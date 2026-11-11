/**
 * What is handed over beside a clean video for the person who finishes it by hand: where a piece of
 * text could go and for how long, where the logo and the proof image could sit, and what an end card
 * could say. Nothing here is rendered into the MP4.
 *
 * Every time comes from the finished timeline (the clips as actually joined, the words as actually
 * spoken), so the plan is rebuilt whenever the video is exported again. Pure: no model, no storage.
 */
import type { SceneWindow, TimedWord } from "@/lib/video/captions";
import { bandsForCue, type FaceBand } from "@/lib/video/face-bands";
import { firstMention, imageSpansFor } from "@/lib/video/image-timing";
import type { AlignedLine } from "@/lib/video/subtitles";
import type { ApprovedClaim, AssetPurpose, EditingNote, SceneBrief, SpeechLine } from "@/lib/video/pipeline-types";

export type OverlayKind = "stat" | "keyword" | "cta" | "url";

export type PlannedOverlay = {
  id: string;
  kind: OverlayKind;
  /** The exact wording suggested. */
  text: string;
  /** Seconds on the exported video's own timeline. */
  start: number;
  end: number;
  scene: number;
  position: string;
  alignment: "centre";
  styling: string;
  /** What to watch for: a face in the way, timing that could not be measured. */
  concerns: string[];
  /** Where a figure comes from, so it stays tied to its source. */
  source?: string;
};

export type PlannedImage = {
  assetId: string;
  fileName: string;
  purpose: AssetPurpose;
  sha256: string | null;
  available: boolean;
  start: number;
  end: number;
  scenes: number[];
  placement: string;
  instructions: string;
  cautions: string[];
};

export type EditPlan = {
  version: 1;
  createdAt: string;
  videoSeconds: number;
  format: string;
  frame: { width: number; height: number };
  note: string;
  textOverlays: PlannedOverlay[];
  logo: { available: boolean; fileName: string | null; sha256: string | null; placement: string; note: string } | null;
  proofImages: PlannedImage[];
  endCard: { lines: string[]; note: string } | null;
  /** Spoken lines that were reworded because they pointed at an image the clean video does not show. */
  narrationChanges: Array<{ scene: number; was: string; now: string; reason: string }>;
  /** Things to settle about the evidence before a figure is put on screen. */
  cautions: string[];
};

export type EditPlanInput = {
  seconds: number;
  format: string;
  width: number;
  height: number;
  scenes: Array<{ number: number; line: string; stat: string | null; assetId: string | null; keywords: string[] }>;
  /** The creative plan's briefs, whose editingNotes are the planner's suggestions. Empty for a video with no plan. */
  briefs: Array<Pick<SceneBrief, "number" | "editingNotes">>;
  windows: SceneWindow[];
  aligned: AlignedLine[];
  faces: { bands: FaceBand[]; samples: number[]; limitation: string | null };
  assets: Array<{ id: string; name: string; purpose: AssetPurpose; sha256: string | null; available: boolean; cautions: string[]; figures: string[] }>;
  claims: ApprovedClaim[];
  logo: { available: boolean; fileName: string | null; sha256: string | null; needsDarkPlate: boolean } | null;
  brand: { name: string | null; ctaLabel: string | null; url: string | null; accent: string | null };
  narrationChanges?: EditPlan["narrationChanges"];
  cautions?: string[];
  now?: string;
};

/** No more than this many text suggestions per scene: emphasis works because it is rare. */
export const MAX_OVERLAYS_PER_SCENE = 1;
const MIN_SHOW = 1.6;
const round = (n: number) => Math.round(n * 100) / 100;

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.%$ ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** When a phrase is said, from the timed words of its scene: the run of words that matches it. Null when it is not spoken there. */
export function phraseSpan(words: TimedWord[], phrase: string): { start: number; end: number } | null {
  const want = tokens(phrase);
  if (!want.length || !words.length) return null;
  const have = words.map((w) => tokens(w.text).join(""));
  for (let i = 0; i + want.length <= have.length; i += 1) {
    if (want.every((t, k) => have[i + k] === t || have[i + k]!.replace(/[.]+$/, "") === t)) return { start: words[i]!.start, end: words[i + want.length - 1]!.end };
  }
  return null;
}

const figureOf = (text: string) => /[$€£]?\d[\d,.]*\s?(?:%|[kKmMbB]\b|\+|x\b)*/.exec(text)?.[0].trim() ?? null;

type Zone = { name: string; top: number; bottom: number };
const LOWER: Zone = { name: "lower third", top: 0.62, bottom: 0.84 };
const UPPER: Zone = { name: "upper third", top: 0.1, bottom: 0.3 };

const overlaps = (zone: Zone, bands: Array<{ top: number; bottom: number }>) => bands.some((b) => b.top < zone.bottom && b.bottom > zone.top);
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** Where a piece of text could sit for a stretch of the video, away from any face measured there. */
export function placeText(faces: EditPlanInput["faces"], start: number, end: number): { position: string; concerns: string[] } {
  if (faces.limitation && !faces.bands.length) {
    return { position: "Lower third, centred, inside the safe area", concerns: ["Face positions were not measured for this export: check by eye that the text clears the speaker's face and hands."] };
  }
  const bands = bandsForCue(faces.bands, faces.samples, start, end);
  const face = bands.length ? `A face spans ${pct(Math.min(...bands.map((b) => b.top)))} to ${pct(Math.max(...bands.map((b) => b.bottom)))} of the frame height here` : null;
  if (!overlaps(LOWER, bands)) return { position: `Lower third, centred (about ${pct(LOWER.top)} to ${pct(LOWER.bottom)} of the frame height), inside the safe area`, concerns: face ? [`${face}: keep the text below it.`] : [] };
  if (!overlaps(UPPER, bands)) return { position: `Upper third, centred (about ${pct(UPPER.top)} to ${pct(UPPER.bottom)} of the frame height), inside the safe area`, concerns: [`${face}, including the lower third: place the text above it.`] };
  return { position: "Lower third, centred, kept small", concerns: [`${face} and leaves little free space: keep the text small, or leave this one out.`] };
}

const STYLING: Record<OverlayKind, string> = {
  stat: "The figure large and bold with its label smaller beneath it; one brand colour for the figure; a soft shadow or a dark plate so it reads over the footage. Fade in and out over about 0.2 seconds.",
  keyword: "Two or three words at most, bold sans-serif, white with a soft shadow. Use sparingly: it works because most lines have none.",
  cta: "A single clear line, styled as a button or pill in the brand colour, on screen while the call to action is spoken.",
  url: "Small and plain beneath the call to action; no animation.",
};

function suggestionsFor(scene: EditPlanInput["scenes"][number], brief: EditPlanInput["briefs"][number] | undefined, isLast: boolean): EditingNote[] {
  const planned = (brief?.editingNotes ?? []).filter((n) => (n.kind === "stat" || n.kind === "keyword" || n.kind === "cta" || n.kind === "url") && n.text?.trim());
  // A video with no editing notes (made before clean video existed, or its plan suggested none) falls back to what the script marked.
  const fallback: EditingNote[] = brief?.editingNotes ? [] : [...(scene.stat ? [{ kind: "stat" as const, text: scene.stat }] : []), ...scene.keywords.slice(0, 1).map((k) => ({ kind: "keyword" as const, text: k }))];
  const all = planned.length ? planned : fallback;
  // Emphasis is selective: the figure first, then the call to action (only where the video ends), then a single phrase.
  const rank = (n: EditingNote) => (n.kind === "stat" ? 0 : n.kind === "cta" ? (isLast ? 1 : 3) : n.kind === "keyword" ? 2 : 4);
  return [...all].sort((a, b) => rank(a) - rank(b)).filter((n) => (n.kind === "cta" || n.kind === "url" ? isLast : true)).slice(0, MAX_OVERLAYS_PER_SCENE);
}

export function buildEditPlan(input: EditPlanInput): EditPlan {
  const total = input.seconds;
  const windowOf = new Map(input.windows.map((w) => [w.number, w]));
  const wordsOf = new Map(input.aligned.map((a) => [a.sceneNumber, a]));
  const claimById = new Map(input.claims.map((c) => [c.id, c]));
  const lastScene = Math.max(...input.scenes.map((s) => s.number), 0);
  const textOverlays: PlannedOverlay[] = [];

  for (const scene of input.scenes) {
    const window = windowOf.get(scene.number);
    if (!window) continue;
    const line = wordsOf.get(scene.number);
    const brief = input.briefs.find((b) => b.number === scene.number);
    for (const note of suggestionsFor(scene, brief, scene.number === lastScene)) {
      const kind = note.kind as OverlayKind;
      const text = note.text!.trim();
      const concerns: string[] = [];
      let span: { start: number; end: number } | null = null;
      if (line?.fromAudio) {
        if (kind === "stat") {
          const figure = figureOf(text);
          const at = figure ? firstMention(line.words, figure) : null;
          if (at !== null) span = { start: at, end: Math.max(...line.words.map((w) => w.end)) };
        } else {
          span = phraseSpan(line.words, text);
        }
      }
      if (!span) {
        // Not found in the audio: the scene's own stretch is used and said to be approximate, never passed off as measured.
        span = { start: window.start + 0.3, end: window.end - 0.2 };
        concerns.push(line?.fromAudio ? `"${text}" is not said word for word in this scene, so it is timed to the scene as a whole.` : "The speech could not be located in the audio, so this time is the scene's planned position: check it by ear.");
      }
      let start = Math.max(window.start, span.start - 0.1);
      const end = Math.min(Math.max(span.end + 0.5, start + MIN_SHOW), window.end, total);
      if (end - start < MIN_SHOW) start = Math.max(window.start, end - MIN_SHOW);
      if (end <= start) continue;
      const placed = placeText(input.faces, start, end);
      const claim = note.claimId ? claimById.get(note.claimId) : kind === "stat" ? input.claims.find((c) => c.figure && figureOf(text) && c.figure.replace(/\s/g, "") === figureOf(text)!.replace(/\s/g, "")) : undefined;
      if (kind === "stat" && !claim) concerns.push("This figure is not linked to a recorded source: confirm it before putting it on screen.");
      textOverlays.push({
        id: `text_${textOverlays.length + 1}`,
        kind,
        text,
        start: round(start),
        end: round(end),
        scene: scene.number,
        position: note.position?.trim() ? `${note.position.trim()} (measured: ${placed.position.toLowerCase()})` : placed.position,
        alignment: "centre",
        styling: STYLING[kind],
        concerns: [...concerns, ...placed.concerns, ...(note.note?.trim() ? [note.note.trim()] : [])],
        ...(claim ? { source: `${claim.text} (${claim.provenance.detail})` } : {}),
      });
    }
  }

  // The proof image: when its figure is said, for as long as the point lasts. The file itself is handed over untouched.
  const figuresByAsset: Record<string, string[]> = Object.fromEntries(input.assets.map((a) => [a.id, a.figures]));
  const spans = imageSpansFor({
    scenes: input.scenes.map((s) => ({ number: s.number, assetId: s.assetId, stat: s.stat })),
    windows: input.windows,
    words: new Map(input.aligned.map((a) => [a.sceneNumber, a.words])),
    figuresByAsset,
    totalSeconds: total,
  });
  const proofImages: PlannedImage[] = [];
  for (const asset of input.assets) {
    const own = spans.filter((s) => s.assetId === asset.id);
    const base = {
      assetId: asset.id,
      fileName: asset.name,
      purpose: asset.purpose,
      sha256: asset.sha256,
      available: asset.available,
      instructions: "Use the original file exactly as supplied: scale it in proportion, do not crop, redraw, restyle or re-type it, and do not let a video or image model recreate it.",
      cautions: asset.cautions,
    };
    if (!own.length) {
      proofImages.push({ ...base, start: 0, end: 0, scenes: [], placement: "The script does not point to a moment for this file. Add it only where the spoken words support it." });
      continue;
    }
    for (const span of own) {
      const bands = bandsForCue(input.faces.bands, input.faces.samples, span.start, span.end);
      const faceBottom = bands.length ? Math.max(...bands.map((b) => b.bottom)) : null;
      const placement =
        faceBottom !== null && faceBottom < 0.6
          ? `Inset below the speaker, from about ${pct(Math.min(faceBottom + 0.04, 0.6))} of the frame height down, at most 86% of the width, centred`
          : faceBottom !== null
            ? "Full-width cutaway for this stretch (the speaker fills the frame, so an inset would cover the face), or a small inset in a corner clear of the face"
            : "Inset in the lower half, at most 86% of the width, centred";
      proofImages.push({ ...base, start: round(span.start), end: round(span.end), scenes: span.scenes, placement });
    }
  }

  const endLines = [input.brand.name, input.brand.ctaLabel, input.brand.url].filter((l): l is string => Boolean(l && l.trim()));
  return {
    version: 1,
    createdAt: input.now ?? new Date().toISOString(),
    videoSeconds: round(total),
    format: input.format,
    frame: { width: input.width, height: input.height },
    note: "The MP4 is clean: it contains none of what is listed here. Everything below is a suggestion for manual editing, and the video is complete without it. Times are on the exported video's own timeline and are worked out again whenever it is exported.",
    textOverlays,
    logo: input.logo
      ? {
          available: input.logo.available,
          fileName: input.logo.fileName,
          sha256: input.logo.sha256,
          placement: "Top left inside the safe area, about a fifth of the frame width, for the whole video; or only over the closing shot.",
          note: input.logo.available ? (input.logo.needsDarkPlate ? "This logo is light: it needs a dark plate or a dark part of the frame to be readable." : "Use the original file; do not redraw or recolour it.") : "The logo file could not be read from storage: check the brand again or upload it before using it.",
        }
      : null,
    proofImages,
    endCard: endLines.length
      ? { lines: endLines, note: `Optional. If you want an end card, add it after the video ends at ${stampShort(total)}, or lay it over the closing shot's last second. It is not part of the MP4.` }
      : null,
    narrationChanges: input.narrationChanges ?? [],
    cautions: input.cautions ?? [],
  };
}

const two = (n: number) => String(Math.floor(n)).padStart(2, "0");
export function stampShort(seconds: number): string {
  const s = Math.max(seconds, 0);
  return `${two(s / 60)}:${two(s % 60)}.${String(Math.round((s % 1) * 10) % 10)}`;
}

/** The plan as a text file a person can read beside their editor. */
export function editPlanText(plan: EditPlan, title: string): string {
  const out: string[] = [`${title}: placement plan for manual editing`, "", plan.note, "", `Video length ${stampShort(plan.videoSeconds)}, ${plan.frame.width}x${plan.frame.height} (${plan.format}).`, ""];
  out.push("ON-SCREEN TEXT (optional)");
  if (!plan.textOverlays.length) out.push("  None suggested. The video does not need any.");
  for (const o of plan.textOverlays) {
    out.push(`  ${stampShort(o.start)} to ${stampShort(o.end)}  scene ${o.scene}  [${o.kind}]  "${o.text}"`);
    out.push(`    Position: ${o.position}. Alignment: ${o.alignment}.`);
    out.push(`    Styling: ${o.styling}`);
    if (o.source) out.push(`    Source: ${o.source}`);
    for (const c of o.concerns) out.push(`    Watch: ${c}`);
  }
  out.push("", "LOGO (optional)");
  if (!plan.logo) out.push("  No logo is on record for this video.");
  else {
    out.push(`  File: ${plan.logo.fileName ?? "the verified logo"}${plan.logo.sha256 ? ` (SHA-256 ${plan.logo.sha256})` : ""}`);
    out.push(`  Placement: ${plan.logo.placement}`, `  Note: ${plan.logo.note}`);
  }
  out.push("", "PROOF IMAGES (optional; supplied as the original files)");
  if (!plan.proofImages.length) out.push("  None uploaded.");
  for (const p of plan.proofImages) {
    out.push(`  ${p.fileName}${p.sha256 ? ` (SHA-256 ${p.sha256})` : ""}${p.available ? "" : "  [FILE MISSING FROM STORAGE]"}`);
    out.push(p.scenes.length ? `    When: ${stampShort(p.start)} to ${stampShort(p.end)} (scene ${p.scenes.join(", ")})` : "    When: no moment in the script points to it");
    out.push(`    Placement: ${p.placement}`, `    ${p.instructions}`);
    for (const c of p.cautions) out.push(`    Settle first: ${c}`);
  }
  out.push("", "END CARD (optional)");
  if (!plan.endCard) out.push("  No suggestion.");
  else out.push(...plan.endCard.lines.map((l) => `  ${l}`), `  ${plan.endCard.note}`);
  if (plan.narrationChanges.length) {
    out.push("", "SPOKEN LINES THAT WERE REWORDED (they pointed at an image the clean video does not show)");
    for (const c of plan.narrationChanges) out.push(`  Scene ${c.scene}: "${c.was}"  became  "${c.now}"`);
  }
  if (plan.cautions.length) {
    out.push("", "TO SETTLE BEFORE A FIGURE GOES ON SCREEN");
    for (const c of plan.cautions) out.push(`  - ${c}`);
  }
  return `${out.join("\n")}\n`;
}

/** The final transcript: what is said, when, as written for display, with how each written term was spoken. */
export function transcriptText(input: { title: string; seconds: number; speech: SpeechLine[]; aligned: AlignedLine[]; windows: SceneWindow[]; timedFromAudio: boolean }): string {
  const out: string[] = [`${input.title}: transcript`, `Length ${stampShort(input.seconds)}. ${input.timedFromAudio ? "Times are measured from the final audio." : "The speech could not be located in the audio: times are the scenes' planned positions."}`, ""];
  for (const line of input.speech) {
    const aligned = input.aligned.find((a) => a.sceneNumber === line.sceneNumber);
    const window = input.windows.find((w) => w.number === line.sceneNumber);
    const start = aligned?.words.length ? Math.min(...aligned.words.map((w) => w.start)) : (window?.start ?? 0);
    const end = aligned?.words.length ? Math.max(...aligned.words.map((w) => w.end)) : (window?.end ?? 0);
    out.push(`[${stampShort(start)} - ${stampShort(end)}] ${line.display}`);
  }
  const terms = input.speech.flatMap((l) => l.segments.filter((s) => s.spoken.trim() && s.spoken.trim() !== s.display.trim()).map((s) => `  "${s.display.trim()}" is said as "${s.spoken.trim()}"`));
  if (terms.length) out.push("", "WRITTEN FORM AND SPOKEN FORM (subtitles keep the written form)", ...[...new Set(terms)]);
  return `${out.join("\n")}\n`;
}
