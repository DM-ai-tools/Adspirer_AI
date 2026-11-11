import path from "node:path";
import { generateObject } from "ai";
import { z } from "zod";
import { modelCandidates, withModelFallback } from "@/lib/video/model-fallback";
import { logger } from "@/lib/observability/logger";
import { extractFramesAt, frameTimes, normaliseText, temporalChecks, tokenise } from "@/lib/video/clip-qa";
import type { AsrWord } from "@/lib/video/captions";
import { hasCritical, type BrandManifest, type QaCheckResult, type QaFinding, type QaReport } from "@/lib/video/pipeline-types";

/**
 * The gate on the finished export. The final video has no retry: anything critical or major blocks
 * delivery. A vision model reads every piece of visible text verbatim and describes logos and caption
 * placement; deterministic rules compare that with the verified brand facts, so what ships is what
 * was approved (the right name, the real logo, the approved claims and nothing invented).
 */

/** The end card must stay up at least this long to be read (brand name and call to action). */
export const MIN_END_CARD_SECONDS = 1.8;

export type FinalQaInput = {
  file: string;
  workDir: string;
  attempt: number;
  /** Length of the export in seconds, end card included. */
  seconds: number;
  endCardSeconds: number;
  manifest: Pick<BrandManifest, "name" | "logo" | "internalLabels" | "allowTextOnlyBrand" | "claims" | "cta" | "offer">;
  expected: { brandName: string | null; ctaLabel: string | null; claimTexts: string[]; captionTexts: string[]; allowedOverlayText: string[] };
  cues: Array<{ start: number; end: number; text: string }>;
  expectsLogo: boolean;
  asr: AsrWord[] | null;
  requireVision?: boolean;
  /** The brand's original logo, sent to the reviewer as a labelled reference. */
  logoReference?: Buffer | null;
  /**
   * When the operator's own uploaded images (screenshots, results) are composited on screen. Text
   * read there is the operator's real pixels, not something the video model drew, so it is not
   * counted as text in the footage.
   */
  verifiedAssetWindows?: Array<{ start: number; end: number }>;
  /**
   * Clean video: the export is footage and sound only. A missing logo, missing captions and a missing
   * end card are then correct, not faults; any caption, graphic, logo or card in the picture is the fault.
   */
  clean?: boolean;
};

export type FinalTextRegion = "caption" | "overlay" | "footage" | "end_card" | "unknown";

export type FinalEnding = { state: "composed" | "mid_speech" | "frozen_or_distorted" | "card_or_text" | "unclear"; detail: string };

export type FinalVisionResult = {
  /** `prominence` is "incidental" only for a small background detail of the filmed place that is not a graphic and not part of the message. */
  textSeen: Array<{ text: string; atSeconds: number | null; region: FinalTextRegion; legible: boolean; prominence?: "prominent" | "incidental" }>;
  /** How the film ends, from its last frames. */
  ending?: FinalEnding | null;
  logoSeen: Array<{ atSeconds: number | null; matchesReference: boolean | null; region: string }>;
  captionIssues: Array<{ atSeconds: number | null; problem: "covers_face" | "covers_logo" | "unreadable" | "off_safe_area" | "other"; detail: string }>;
  summary: string;
};

export type FinalVisionReviewer = (input: { frames: Array<{ at: number; bytes: Buffer; note: string }>; logoReference: Buffer | null; rubric: string }) => Promise<FinalVisionResult>;

// ------------------------------------------------------------------ vision

export function finalRubric(ctx: { endCardSeconds: number; hasLogoReference: boolean; clean?: boolean }): string {
  if (ctx.clean) {
    return [
      "You are a meticulous inspector for a finished CLEAN video ad. A clean video is footage and sound only: it must contain NO subtitles, captions, highlighted words, titles, headlines, statistic badges, buttons, web addresses, logos, watermarks, screenshots, dashboards or closing card. You are given frames sampled in time order across the WHOLE export, each labelled with its time. Report only what is visible. Read, do not guess, and never correct or complete what you see.",
      "",
      "1. TEXT. List EVERY piece of visible text in textSeen, copied VERBATIM, with the time and the region: caption (a subtitle line), overlay (any graphic, title, badge, button or panel drawn over the picture, including a dashboard or interface floating in the air), footage (lettering that is physically part of the filmed place: a sign, a label, a book spine, a screen), end_card (a full-frame card), or unknown. Set legible=false for text you cannot read with certainty. Set prominence=incidental ONLY for footage text that is small, in the background, out of focus or barely readable and that a viewer would not take as part of the ad's message; everything else is prominent.",
      "2. LOGOS. For every logo, wordmark or brand mark you see in any frame, add a logoSeen entry with the time and region. Set matchesReference to null.",
      "3. CAPTIONS. There should be none: leave captionIssues empty and report any subtitle line under TEXT with region caption.",
      "4. ENDING. Look at the last frames. Set ending.state: composed (the film ends on a settled, natural shot: a person with a relaxed expression and a closed or resting mouth, or a closing visual that completes the story), mid_speech (the mouth is open mid-word or the person is plainly cut off), frozen_or_distorted (a frozen, smeared, warped or blank face or frame), card_or_text (a card, a block of colour, a logo or text instead of footage), or unclear. Say what you see in ending.detail.",
      "",
      "Be exhaustive about text and graphics: a missed one is a worse mistake than a doubtful one flagged as not legible. Do not invent items; an empty list is a good result. Fill summary with two sentences on what the video shows on screen.",
    ].join("\n");
  }
  return [
    "You are a meticulous proofreader and brand-compliance inspector for a finished video ad. You are given frames sampled in time order across the WHOLE export, each labelled with its time and what it is expected to contain. Report only what is visible. Read, do not guess, and never correct or complete what you see.",
    "",
    "1. TEXT. List EVERY piece of visible text in textSeen: spoken-word captions, text overlays, text on the closing card, and any text, numbers, wordmarks, buttons, signs or screens that appear inside the camera footage itself. Copy each one VERBATIM, letter for letter, exactly as it appears, including spelling mistakes and odd spacing; do not fix typos and do not guess unreadable letters. Give the time and the region: caption (the subtitle line), overlay (a graphic added on top of the footage), footage (text that is part of the filmed scene), end_card (the closing card), or unknown. Set legible=false for text you cannot read with certainty. Include numbers, percentages and prices.",
    ctx.hasLogoReference
      ? "2. LOGOS. You are also given the brand's REFERENCE LOGO image. For every logo, wordmark or brand mark you see in any frame, add a logoSeen entry with the time and region, and set matchesReference true only if it is the same mark as the reference (same shape, lettering and colours), false if it is a different, altered, redrawn or invented mark, null if you cannot tell."
      : "2. LOGOS. For every logo, wordmark or brand mark you see in any frame, add a logoSeen entry with the time and region. No reference logo is given, so set matchesReference to null.",
    "3. CAPTIONS. Look at the subtitle line in each frame that has one. Add a captionIssues entry when it covers a person's face (covers_face), covers a logo (covers_logo), is hard to read against the background (unreadable), sits outside the safe area near the screen edge or under where app buttons cover the video (off_safe_area), or has another layout problem (other). Say what you see in detail.",
    ctx.endCardSeconds > 0 ? `4. END CARD. The last ${ctx.endCardSeconds.toFixed(1)} seconds are a closing card. Read everything on it: the company name exactly as written, the logo, the call to action and any other line.` : "4. There is no closing card.",
    "",
    "Be exhaustive about text: a missed piece of text is a worse mistake than a doubtful one flagged as not legible. Do not invent items. Fill summary with two sentences on what the video shows on screen.",
  ].join("\n");
}

const finalSchema = z.object({
  textSeen: z
    .array(
      z.object({
        text: z.string(),
        atSeconds: z.number().nullable(),
        region: z.enum(["caption", "overlay", "footage", "end_card", "unknown"]),
        legible: z.boolean(),
        prominence: z.enum(["prominent", "incidental"]).describe("incidental only for a small background detail of the filmed place that is not a graphic and not part of the message"),
      }),
    )
    .max(80)
    .describe("Every piece of visible text, verbatim"),
  ending: z
    .object({ state: z.enum(["composed", "mid_speech", "frozen_or_distorted", "card_or_text", "unclear"]), detail: z.string() })
    .nullable()
    .describe("How the film ends, from its last frames. null when not asked for."),
  logoSeen: z.array(z.object({ atSeconds: z.number().nullable(), matchesReference: z.boolean().nullable(), region: z.string() })).max(30),
  captionIssues: z.array(z.object({ atSeconds: z.number().nullable(), problem: z.enum(["covers_face", "covers_logo", "unreadable", "off_safe_area", "other"]), detail: z.string() })).max(30),
  summary: z.string(),
});

export function createFinalVisionReviewer(): FinalVisionReviewer | null {
  const candidates = modelCandidates();
  if (!candidates.length) return null;
  return async ({ frames, logoReference, rubric }) => {
    const content: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }> = [{ type: "text", text: rubric }];
    if (logoReference) {
      content.push({ type: "text", text: "REFERENCE LOGO: the brand's real logo. Compare every logo or wordmark you see with this image." });
      content.push({ type: "image", image: new Uint8Array(logoReference), mediaType: "image/png" });
    }
    for (const f of frames) {
      content.push({ type: "text", text: `Frame at ${Math.round(f.at * 100) / 100}s (${f.note}):` });
      content.push({ type: "image", image: new Uint8Array(f.bytes), mediaType: "image/jpeg" });
    }
    return withModelFallback(async (model) => (await generateObject({ model, schema: finalSchema, temperature: 0, messages: [{ role: "user", content }] })).object, candidates);
  };
}

// ------------------------------------------------------------------ which moments to look at

export function finalFrameTimes(input: Pick<FinalQaInput, "seconds" | "endCardSeconds" | "cues" | "clean">): Array<{ at: number; note: string }> {
  const total = Math.max(input.seconds, 0);
  if (input.clean) {
    // A clean video has no captions or card to aim at: the frames are spread across the whole film, with the last second looked at closely for the ending.
    const body = frameTimes(Math.max(total - 1, 0), 12).map((at) => ({ at, note: "footage: should carry no text or graphics" }));
    const ending = [total - 0.9, total - 0.45, total - 0.12].filter((t) => t > 0).map((t) => ({ at: Math.round(t * 100) / 100, note: "the ending" }));
    const all = [...body, ...ending].sort((a, b) => a.at - b.at);
    return all.filter((o, i) => i === 0 || o.at - all[i - 1]!.at >= 0.1).slice(0, 24);
  }
  const endStart = input.endCardSeconds > 0 ? Math.max(total - input.endCardSeconds, 0) : total;
  const out: Array<{ at: number; note: string }> = [];
  const bodyEnd = input.endCardSeconds > 0 ? Math.max(endStart - 0.1, 0) : total;
  for (const t of frameTimes(bodyEnd, 8)) out.push({ at: t, note: "footage with any graphics on it" });
  if (input.endCardSeconds > 0) {
    for (const t of [endStart + 0.25, endStart + input.endCardSeconds / 2, total - 0.15]) out.push({ at: Math.max(0, Math.round(t * 100) / 100), note: "end card" });
  } else if (total > 0) {
    out.push({ at: Math.max(total - 0.15, 0), note: "last frame" });
  }
  // Where captions are: the middle of up to six cues spread across the video.
  const cues = input.cues.filter((c) => c.end > c.start && c.text.trim());
  const step = Math.max(1, Math.ceil(cues.length / 6));
  for (let i = 0; i < cues.length; i += step) {
    const c = cues[i]!;
    out.push({ at: Math.round(((c.start + c.end) / 2) * 100) / 100, note: `caption "${c.text.slice(0, 60)}" expected` });
  }
  const sorted = out.filter((o) => o.at <= Math.max(total - 0.05, 0)).sort((a, b) => a.at - b.at);
  const kept: Array<{ at: number; note: string }> = [];
  for (const o of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && o.at - prev.at < 0.2) {
      // keep the more specific note
      if (/end card|caption/.test(o.note)) kept[kept.length - 1] = o;
      continue;
    }
    kept.push(o);
  }
  return kept.slice(0, 24);
}

// ------------------------------------------------------------------ rules

const fmtT = (t: number | null | undefined) => (t === null || t === undefined ? "" : ` at ${Math.round(t * 100) / 100}s`);

function allowedPool(input: FinalQaInput): string[] {
  const m = input.manifest;
  return [
    input.expected.brandName ?? "",
    input.expected.ctaLabel ?? "",
    ...input.expected.claimTexts,
    ...input.expected.captionTexts,
    ...input.expected.allowedOverlayText,
    ...input.cues.map((c) => c.text),
    m.name.value ?? "",
    m.offer.value ?? "",
    m.cta.value?.label ?? "",
    m.cta.value?.url ?? "",
    ...m.claims.flatMap((c) => [c.text, c.figure ?? ""]),
  ]
    .map(normaliseText)
    .filter(Boolean);
}

function isAllowed(text: string, pool: string[]): boolean {
  const n = normaliseText(text);
  if (!n) return true;
  return pool.some((a) => a === n || (n.length >= 2 && a.includes(n)) || (a.length >= 4 && n.includes(a)));
}

const FIGURE = /[$€£]?\d[\d,.]*\s?(?:%|[kKmMbB]\b|\+)*/g;

function figuresIn(text: string): string[] {
  return (text.match(FIGURE) ?? []).map((f) => normaliseText(f)).filter((f) => /\d/.test(f));
}

function overlap(seen: string[], reference: Set<string>): number {
  return seen.length ? seen.filter((w) => reference.has(w)).length / seen.length : 1;
}

/**
 * The findings for a clean video. Nothing on screen is "expected", so nothing is "missing": the
 * faults are a caption, graphic, logo or card that is there, prominent lettering inside the footage,
 * and an ending that is cut off, frozen or replaced by a card. A small background detail is noted only.
 */
export function cleanFindings(input: FinalQaInput, vision: FinalVisionResult): QaFinding[] {
  const findings: QaFinding[] = [];
  const seen = new Set<string>();
  for (const t of vision.textSeen.filter((x) => x.text.trim())) {
    const key = `${t.region}:${normaliseText(t.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const internal = input.manifest.internalLabels.find((l) => normaliseText(l.value).length >= 3 && normaliseText(t.text).includes(normaliseText(l.value)));
    if (internal) {
      findings.push({ code: "internal_label_visible", severity: "critical", category: "branding", message: "An internal label (a project or campaign title) is visible on screen.", evidence: `"${t.text}"${fmtT(t.atSeconds)} matches the internal label "${internal.value}" (${t.region}).`, atSeconds: t.atSeconds ?? undefined, correction: "Regenerate the affected clip with plain surfaces and no lettering.", source: "vision" });
      continue;
    }
    if (t.region === "footage" || t.region === "unknown") {
      if (!t.legible || t.prominence === "incidental") {
        if (t.region === "footage" && t.legible) findings.push({ code: "incidental_text", severity: "minor", category: "text", message: `A small background detail ("${t.text}") is faintly readable in the scene.`, evidence: `"${t.text}"${fmtT(t.atSeconds)}: part of the filmed place, small or out of focus, not a graphic.`, atSeconds: t.atSeconds ?? undefined, correction: "", source: "vision" });
        continue;
      }
      findings.push({
        code: "fabricated_text",
        severity: t.region === "unknown" ? "major" : "critical",
        category: "text",
        message: `Readable text ("${t.text}") appears inside the footage.`,
        evidence: `"${t.text}"${fmtT(t.atSeconds)} is prominent in the picture. A clean video carries no lettering.`,
        atSeconds: t.atSeconds ?? undefined,
        correction: "Regenerate the affected clip with plain surfaces (clothing, walls, props and screens show solid colours and natural texture).",
        source: "vision",
      });
      continue;
    }
    // caption, overlay or end card: a graphic that a clean video must not contain, whether this application or the video model drew it.
    findings.push({
      code: "graphic_in_clean_video",
      severity: "critical",
      category: t.region === "caption" ? "subtitles" : "text",
      message: `${t.region === "caption" ? "A subtitle" : t.region === "end_card" ? "A closing card" : "A graphic"} ("${t.text}") is in the picture of a clean video.`,
      evidence: `"${t.text}"${fmtT(t.atSeconds)} (${t.region}). A clean video contains no subtitles, headlines, badges, buttons or cards; those are supplied separately.`,
      atSeconds: t.atSeconds ?? undefined,
      correction: "Regenerate the affected clip without any wording about graphics, so the footage is the whole picture.",
      source: "vision",
    });
  }
  for (const l of vision.logoSeen) {
    findings.push({
      code: "invented_branding",
      severity: "critical",
      category: "branding",
      message: "A logo or brand mark appears in a clean video.",
      evidence: `Mark seen${fmtT(l.atSeconds)} in ${l.region}. A clean video carries no logo; the original file is supplied separately.`,
      atSeconds: l.atSeconds ?? undefined,
      correction: "Regenerate the affected clip with unmarked clothing, props and surfaces.",
      source: "vision",
    });
  }
  const ending = vision.ending;
  if (ending && ending.state !== "composed" && ending.state !== "unclear") {
    findings.push({
      code: ending.state === "card_or_text" ? "ending_card" : ending.state === "mid_speech" ? "ending_cut_off" : "ending_frozen",
      severity: "major",
      category: ending.state === "mid_speech" ? "speech" : "composition",
      message: ending.state === "card_or_text" ? "The video ends on a card or text instead of footage." : ending.state === "mid_speech" ? "The video ends while the speaker is still mid-word." : "The video ends on a frozen or distorted frame.",
      evidence: `${ending.detail}`.trim() || "Seen in the last frames.",
      atSeconds: Math.max(input.seconds - 0.5, 0),
      correction: "End on the speaker finishing the last word, then holding a relaxed, composed expression for about a second.",
      source: "vision",
    });
  }
  return findings;
}

/** From the audio: the last word must not run into the very end of the file. */
export function endingFromAudio(seconds: number, asr: AsrWord[] | null): QaFinding[] {
  if (!asr?.length) return [];
  const lastEnd = Math.max(...asr.map((w) => w.end));
  const tail = seconds - lastEnd;
  if (tail < 0.15) {
    return [{ code: "ending_cut_off", severity: "major", category: "speech", message: "The last word runs to the very end of the video, so it sounds cut off.", evidence: `The last word ends at ${lastEnd.toFixed(2)}s and the video at ${seconds.toFixed(2)}s (${Math.max(tail, 0).toFixed(2)}s after it).`, atSeconds: lastEnd, correction: "Give the closing shot about a second after the last word.", source: "asr" }];
  }
  return [];
}

export function finalFindings(input: FinalQaInput, vision: FinalVisionResult): QaFinding[] {
  if (input.clean) return cleanFindings(input, vision);
  const findings: QaFinding[] = [];
  const endStart = input.endCardSeconds > 0 ? Math.max(input.seconds - input.endCardSeconds, 0) : null;
  const onCard = (region: string, at: number | null) => (endStart !== null ? region === "end_card" || (at !== null && at >= endStart - 0.05 && region !== "footage") : region !== "footage" && region !== "caption");
  const texts = vision.textSeen.filter((t) => t.text.trim());
  const pool = allowedPool(input);
  const flagged = new Set<string>();

  // --- internal labels (anywhere, readable or not)
  const brandNorm = normaliseText(input.expected.brandName ?? input.manifest.name.value ?? "");
  for (const label of input.manifest.internalLabels) {
    const ln = normaliseText(label.value);
    if (ln.length < 3) continue;
    if (brandNorm && brandNorm.includes(ln)) continue;
    const hit = texts.find((t) => normaliseText(t.text).includes(ln));
    if (hit) {
      flagged.add(hit.text);
      findings.push({
        code: "internal_label_visible",
        severity: "critical",
        category: "branding",
        message: "An internal label (a project or campaign title) is visible on screen.",
        evidence: `"${hit.text}"${fmtT(hit.atSeconds)} matches the internal label "${label.value}" (${hit.region}).`,
        atSeconds: hit.atSeconds ?? undefined,
        correction: input.expected.brandName ? `Show only the public company name "${input.expected.brandName}" on the end card and nowhere an internal title.` : "Show only the verified public company name on the end card.",
        source: "vision",
      });
    }
  }

  // --- brand name on the end card
  const brand = input.expected.brandName?.trim();
  if (brand) {
    const bn = normaliseText(brand);
    const card = texts.filter((t) => t.legible && onCard(t.region, t.atSeconds));
    const ok = card.some((t) => normaliseText(t.text).includes(bn)) || normaliseText(card.map((t) => t.text).join("")).includes(bn);
    if (!ok) {
      const read = card.map((t) => `"${t.text}"`).join(", ");
      findings.push({
        code: "brand_name_wrong",
        severity: "critical",
        category: "branding",
        message: `The verified company name "${brand}" is not readable on the end card.`,
        evidence: read ? `Text read on the closing card: ${read}.` : "No readable text was found on the closing card.",
        atSeconds: endStart ?? undefined,
        correction: `Render the end card with the exact company name "${brand}", spelled exactly like that, large and centred.`,
        source: "vision",
      });
    }
  }

  // --- text inside the footage (the renderer adds all text; the model never should)
  for (const t of texts) {
    if (flagged.has(t.text) || t.region !== "footage" || !t.legible) continue;
    if (isAllowed(t.text, pool)) continue;
    if (t.atSeconds !== null && (input.verifiedAssetWindows ?? []).some((w) => t.atSeconds! >= w.start - 0.3 && t.atSeconds! <= w.end + 0.3)) continue;
    flagged.add(t.text);
    findings.push({
      code: "fabricated_text",
      severity: "critical",
      category: "text",
      message: `Readable text ("${t.text}") appears inside the footage.`,
      evidence: `"${t.text}"${fmtT(t.atSeconds)} is part of the filmed scene and not in any approved text.`,
      atSeconds: t.atSeconds ?? undefined,
      correction: "Regenerate the affected clip with plain surfaces (clothing, walls, props and screens show solid colours and natural texture); all lettering is added by the editor.",
      source: "vision",
    });
  }

  // --- figures and claims that are not approved
  for (const t of texts) {
    if (flagged.has(t.text) || !t.legible || t.region === "footage" || t.region === "caption") continue;
    const unknown = figuresIn(t.text).filter((f) => !pool.some((a) => a.includes(f)));
    if (unknown.length) {
      flagged.add(t.text);
      findings.push({
        code: "unsupported_claim",
        severity: "critical",
        category: "claims",
        message: `A figure or claim on screen is not approved ("${t.text}").`,
        evidence: `"${t.text}"${fmtT(t.atSeconds)} contains ${unknown.join(", ")}, which is not among the approved claims (${input.expected.claimTexts.join("; ") || "none"}).`,
        atSeconds: t.atSeconds ?? undefined,
        correction: "Show only the approved claim texts exactly as written, and remove any other number, percentage or result from the graphics.",
        source: "vision",
      });
    }
  }

  // --- other text that should not be there
  for (const t of texts) {
    if (flagged.has(t.text) || !t.legible || t.region === "footage" || t.region === "caption") continue;
    if (isAllowed(t.text, pool)) continue;
    flagged.add(t.text);
    findings.push({
      code: "unexpected_text",
      severity: t.region === "unknown" ? "minor" : "major",
      category: "text",
      message: `Text on screen is not part of the approved copy ("${t.text}").`,
      evidence: `"${t.text}"${fmtT(t.atSeconds)} (${t.region}).`,
      atSeconds: t.atSeconds ?? undefined,
      correction: "Show only the approved overlay text, the brand name and the call to action.",
      source: "vision",
    });
  }

  // --- the call to action
  const cta = input.expected.ctaLabel?.trim();
  if (cta) {
    const cn = normaliseText(cta);
    const seen = texts.filter((t) => t.legible && t.region !== "footage" && t.region !== "caption");
    const ok = seen.some((t) => normaliseText(t.text).includes(cn));
    if (!ok) {
      const near = seen.slice(0, 4).map((t) => `"${t.text}"`);
      findings.push({
        code: "cta_wrong",
        severity: "critical",
        category: "text",
        message: `The call to action "${cta}" is not readable on screen.`,
        evidence: near.length ? `Closest text read: ${near.join(", ")}.` : "No readable call to action was found.",
        atSeconds: endStart ?? undefined,
        correction: `Render the end card with the exact call to action "${cta}" in a clear, high-contrast button.`,
        source: "vision",
      });
    }
  }

  // --- logos
  const textOnly = input.manifest.allowTextOnlyBrand || !input.expectsLogo;
  const hasReference = Boolean(input.logoReference);
  for (const l of vision.logoSeen) {
    const inFootage = /footage/i.test(l.region);
    const wrong = l.matchesReference === false || inFootage || (textOnly && l.matchesReference !== true);
    if (!wrong) continue;
    findings.push({
      code: "invented_branding",
      severity: "critical",
      category: "branding",
      message: inFootage ? "A logo-like mark appears inside the footage." : textOnly ? "A logo appears although only the verified company name should be shown." : "A logo or wordmark on screen is not the brand's real logo.",
      evidence: `Mark seen${fmtT(l.atSeconds)} in ${l.region}; matches the reference: ${l.matchesReference === null ? "unknown" : l.matchesReference ? "yes" : "no"}.`,
      atSeconds: l.atSeconds ?? undefined,
      correction: textOnly && !inFootage ? "Show the verified company name as plain text and no logo mark." : "Show only the brand's original logo file, placed by the editor, and no redrawn or invented marks.",
      source: "vision",
    });
  }
  if (input.expectsLogo && !input.manifest.allowTextOnlyBrand) {
    const atCard = (l: FinalVisionResult["logoSeen"][number]) => /end/i.test(l.region) || (endStart !== null ? l.atSeconds !== null && l.atSeconds >= endStart - 0.05 : true);
    const good = vision.logoSeen.some((l) => !/footage/i.test(l.region) && atCard(l) && (hasReference ? l.matchesReference === true : l.matchesReference !== false));
    if (!good) {
      findings.push({
        code: "logo_missing",
        severity: "critical",
        category: "branding",
        message: "The brand's logo is not visible on the end card.",
        evidence: vision.logoSeen.length ? `Marks seen: ${vision.logoSeen.map((l) => `${l.region}${fmtT(l.atSeconds)} (matches reference: ${l.matchesReference === null ? "unknown" : l.matchesReference ? "yes" : "no"})`).join("; ")}.` : "No logo or brand mark was found in any frame.",
        atSeconds: endStart ?? undefined,
        correction: "Place the brand's original logo file on the end card, large enough to read and clear of other elements.",
        source: "vision",
      });
    }
  }

  // --- captions: placement
  for (const c of vision.captionIssues) {
    findings.push({
      code: "caption_placement",
      severity: c.problem === "other" ? "minor" : "major",
      category: "subtitles",
      message: { covers_face: "A caption covers the presenter's face.", covers_logo: "A caption covers the logo.", unreadable: "A caption is hard to read.", off_safe_area: "A caption sits outside the safe area.", other: "A caption has a layout problem." }[c.problem],
      evidence: `${c.detail}${fmtT(c.atSeconds)}`.trim(),
      atSeconds: c.atSeconds ?? undefined,
      correction: c.problem === "covers_face" || c.problem === "covers_logo" ? "Move the captions to the lower third, clear of faces and the logo." : c.problem === "off_safe_area" ? "Keep the captions inside the safe area, away from the screen edges and the app interface bands." : "Draw the captions larger, in high-contrast type on a solid or shadowed band.",
      source: "vision",
    });
  }

  // --- captions: text against the cues
  const cueWords = new Set(input.cues.flatMap((c) => tokenise(c.text)));
  const reportedMismatch = new Set<string>();
  for (const t of texts.filter((x) => x.region === "caption" && x.legible)) {
    const seenWords = tokenise(t.text);
    if (!seenWords.length) continue;
    const cue = t.atSeconds === null ? null : input.cues.find((c) => t.atSeconds! >= c.start - 0.35 && t.atSeconds! <= c.end + 0.35) ?? null;
    const ref = cue ? new Set(tokenise(cue.text)) : cueWords;
    const share = overlap(seenWords, ref);
    const bad = seenWords.length <= 4 ? share < 1 : share < 0.8;
    if (bad && !reportedMismatch.has(normaliseText(t.text))) {
      reportedMismatch.add(normaliseText(t.text));
      findings.push({
        code: "caption_mismatch",
        severity: "major",
        category: "subtitles",
        message: "A caption on screen differs from the planned caption text.",
        evidence: `Read "${t.text}"${fmtT(t.atSeconds)}; planned ${cue ? `"${cue.text}"` : "text does not contain these words"}.`,
        atSeconds: t.atSeconds ?? undefined,
        correction: "Draw each caption from the planned cue text exactly, word for word, with the original spelling.",
        source: "vision",
      });
    }
  }

  // --- captions against the audio
  if (input.asr && input.asr.length) {
    let reported = 0;
    for (const c of input.cues) {
      const words = tokenise(c.text).filter((w) => !/\d/.test(w));
      if (words.length < 3 || reported >= 3) continue;
      const heard = new Set(input.asr.filter((w) => w.end >= c.start - 0.6 && w.start <= c.end + 0.6).flatMap((w) => tokenise(w.word)));
      if (!heard.size) continue;
      if (overlap(words, heard) < 0.4) {
        reported += 1;
        findings.push({
          code: "caption_audio_mismatch",
          severity: "major",
          category: "subtitles",
          message: "A caption does not match what is said at that moment.",
          evidence: `Caption "${c.text}" (${c.start.toFixed(1)}s-${c.end.toFixed(1)}s) against heard "${[...heard].join(" ").slice(0, 120)}".`,
          atSeconds: c.start,
          correction: "Retime the captions to the voice so each caption shows the words being spoken at that moment.",
          source: "asr",
        });
      }
    }
  }
  return findings;
}

// ------------------------------------------------------------------ orchestrator

export async function reviewFinal(input: FinalQaInput, deps: { reviewer?: FinalVisionReviewer | null } = {}): Promise<QaReport> {
  const requireVision = input.requireVision ?? true;
  const findings: QaFinding[] = [];
  const checks: QaCheckResult[] = [];
  const limitations: string[] = [];
  let framesInspected = 0;

  // 1. Measured by ffmpeg, leaving the closing card (deliberately still and silent) out of the detectors.
  try {
    const t = await temporalChecks(input.file, { expectedSeconds: input.seconds, expectsSpeech: true, tolerance: 0.6, tailSeconds: input.endCardSeconds });
    checks.push(...t.checks);
    findings.push(...t.findings);
  } catch (error) {
    limitations.push(`technical checks could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (input.endCardSeconds > 0) {
    const ok = input.endCardSeconds >= MIN_END_CARD_SECONDS;
    checks.push({ name: "End card long enough to read", ok, detail: `${input.endCardSeconds.toFixed(1)}s (at least ${MIN_END_CARD_SECONDS}s)`, severity: ok ? undefined : "major" });
    if (!ok) {
      findings.push({
        code: "end_card_too_short",
        severity: "major",
        category: "technical",
        message: `The end card is up for only ${input.endCardSeconds.toFixed(1)}s, too short to read.`,
        evidence: `End card ${input.endCardSeconds.toFixed(2)}s; the minimum is ${MIN_END_CARD_SECONDS}s.`,
        atSeconds: Math.max(input.seconds - input.endCardSeconds, 0),
        correction: `Keep the end card on screen for at least ${MIN_END_CARD_SECONDS} seconds.`,
        source: "rule",
      });
    }
  }

  // 2. What is on screen.
  const reviewer = deps.reviewer === undefined ? createFinalVisionReviewer() : deps.reviewer;
  let visionOk = false;
  if (!reviewer) {
    limitations.push("visual review not performed (no vision model is configured)");
  } else {
    try {
      const plan = finalFrameTimes(input);
      if (input.clean) findings.push(...endingFromAudio(input.seconds, input.asr));
      const frames = await extractFramesAt(input.file, plan.map((p) => p.at), path.join(input.workDir, `final-a${input.attempt}`), { width: 900 });
      if (!frames.length) throw new Error("no frames could be extracted from the export");
      const notes = new Map(plan.map((p) => [p.at, p.note]));
      const result = await reviewer({
        frames: frames.map((f) => ({ at: f.at, bytes: f.bytes, note: notes.get(f.at) ?? "" })),
        logoReference: input.logoReference ?? null,
        rubric: finalRubric({ endCardSeconds: input.endCardSeconds, hasLogoReference: Boolean(input.logoReference), clean: input.clean }),
      });
      visionOk = true;
      framesInspected = frames.length;
      const v = finalFindings(input, result);
      findings.push(...v);
      checks.push({ name: input.clean ? "Clean picture: no text, graphics or logos" : "On-screen text and brand marks", ok: !v.some((f) => f.severity !== "minor"), detail: result.summary || `${frames.length} frames inspected`, severity: hasCritical(v) ? "critical" : v.some((f) => f.severity === "major") ? "major" : undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Visual review of the final video failed", { error: message });
      limitations.push(`visual review failed: ${message}`);
    }
  }

  const blocking = findings.some((f) => f.severity === "critical" || f.severity === "major");
  const verdict: QaReport["verdict"] = blocking ? "unresolved" : requireVision && !visionOk ? "unresolved" : "pass";
  checks.push({ name: "Decision", ok: verdict === "pass", detail: blocking ? "Blocked: critical or major problems remain." : verdict === "pass" ? "No problems found." : "Blocked: the on-screen text could not be verified." });
  return { subject: { kind: "final" }, attempt: input.attempt, checkedAt: new Date().toISOString(), verdict, findings, checks, framesInspected, limitations };
}

/** True when the export must not be delivered: anything but a clean pass, or any critical finding. */
export function finalBlocks(report: QaReport): boolean {
  return report.verdict !== "pass" || hasCritical(report.findings);
}
