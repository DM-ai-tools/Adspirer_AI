import { generateObject } from "ai";
import { z } from "zod";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import { pickModel } from "@/lib/creatives/concept-writer";
import { pickBulkAngles, STAGE_LABEL, type BulkAngle } from "@/lib/creatives/bulk/angles";
import { HUMAN_VOICE, SYSTEM } from "@/lib/video/voice";
import { retime, WORDS_PER_SECOND } from "@/lib/video/timing";
import { textRisk, VISUAL_DIRECTION_RULES } from "@/lib/video/visual-rules";
import type { Verification } from "@/lib/video/verify";
import type { ApprovedClaim } from "@/lib/video/pipeline-types";
import type { ScriptExtras } from "@/lib/video/script-types";
import { sourceClaims, type ClaimUse } from "@/lib/video/claims";

/** Ideal length range for the ad, in seconds, and the hard cap. */
export const IDEAL_SECONDS = { min: 30, max: 40 } as const;
export const MAX_SECONDS = 60;
export const DEFAULT_SECONDS = 35;
/** English ad voiceover runs about 2.5 words a second; faster than this is hard to follow and to lip-sync. */
export const MAX_WORDS_PER_SECOND = 3.0;
export const SCRIPT_COUNT = 3;

export type Framework = { key: string; name: string; beats: string; fits: Array<BulkAngle["kind"]> };

/**
 * Structures that work for short paid-social video. They are structure only: the look (UGC,
 * cinematic, motion graphics, documentary...) is chosen per script by the writer. Sources agree the
 * opening 1.5-2s decides the scroll, and that Hook-Body-CTA underlies most of these.
 */
export const FRAMEWORKS: Framework[] = [
  { key: "pas", name: "Problem, agitate, solution", fits: ["pain"], beats: "Hook names the pain in the viewer's words (0-3s). Agitate: what it costs them (3-12s). Solution reveal with the mechanism (12-24s). Proof (24-31s). One clear CTA (last 4-5s)." },
  { key: "ugc_skeptic", name: "UGC \"I was sceptical\" walkthrough", fits: ["proof", "pain", "hope"], beats: "Creator-style confession hook (0-3s). What they tried before and why it failed (3-10s). What changed and how it works, shown (10-25s). The result, only with facts from the page (25-32s). Casual recommendation CTA. Never presented as a real customer review." },
  { key: "myth_bust", name: "Myth-bust / contrarian", fits: ["belief"], beats: "Contrarian hook that challenges a common belief (0-3s). Why it is wrong, with a concrete example (3-14s). The truth and mechanism (14-26s). Proof (26-32s). CTA." },
  { key: "bab", name: "Before, after, bridge", fits: ["hope", "pain"], beats: "Hook shows the painful before in one image (0-3s). The after the viewer wants, vivid (3-12s). The bridge: how to get from one to the other (12-27s). Proof and CTA." },
  { key: "listicle", name: "Numbered list", fits: ["belief", "pain"], beats: "Numbered hook (\"3 mistakes...\", \"3 things...\") (0-3s). Each item gets one fast beat with an on-screen number and keyword. The last item is the offer. CTA." },
  { key: "expert_talk", name: "Expert / founder to camera", fits: ["proof", "belief"], beats: "Credibility hook (0-3s). One sharp insight (3-14s). A demonstration or example shown over the talk (14-28s). CTA to act on the insight." },
  { key: "versus", name: "Old way vs new way", fits: ["belief", "objection"], beats: "Hook sets up the comparison (0-3s). The old way's problems, quick cuts (3-13s). The new way's advantages (13-26s). Proof and CTA." },
  { key: "demo_steps", name: "Demonstration in steps", fits: ["belief", "proof"], beats: "Outcome hook (0-3s). Step 1, 2, 3 each shown with an on-screen label (3-27s). The result and CTA." },
  { key: "pov_story", name: "POV / relatable story", fits: ["pain", "hope"], beats: "Relatable moment hook (0-3s). The turning point (3-14s). The outcome (14-28s). A soft CTA." },
  { key: "open_loop", name: "Curiosity open loop", fits: ["belief", "hope"], beats: "Open a question the viewer must close (0-3s). Build with relevant detail, withholding the answer (3-22s). Pay it off (22-31s). CTA." },
  { key: "stat_led", name: "Stat-led proof", fits: ["proof"], beats: "A striking true number from the facts as the hook (0-3s). What stands behind it (3-15s). How the viewer can get the same (15-28s). CTA." },
  { key: "objection_answer", name: "Objection, answered", fits: ["objection"], beats: "State the doubt in the viewer's words (0-3s). Acknowledge it honestly (3-10s). Answer with evidence (10-26s). Remove the risk and CTA." },
];

/** Three frameworks, each fitting its angle, none repeated. */
export function assignFrameworks(angles: BulkAngle[], random: () => number = Math.random): Framework[] {
  const used = new Set<string>();
  return angles.map((angle) => {
    const fitting = FRAMEWORKS.filter((f) => !used.has(f.key) && f.fits.includes(angle.kind));
    const pool = fitting.length ? fitting : FRAMEWORKS.filter((f) => !used.has(f.key));
    const choice = pool[Math.floor(random() * pool.length)]!;
    used.add(choice.key);
    return choice;
  });
}

export type VideoScene = {
  number: number;
  start: number;
  end: number;
  seconds: number;
  /** What is seen: subject, setting, action. */
  visual: string;
  camera: string;
  speaker: "on_camera" | "voiceover" | "none";
  /** Exact words spoken. */
  line: string;
  /** Words to emphasise on screen. */
  keywords: string[];
  /** A number shown big on screen, taken from the facts or the operator's stats. */
  stat: string | null;
  /** An uploaded image or screenshot to show in this scene (its asset id). */
  assetId: string | null;
  sound: string;
  /** For an uploaded script: the words as the operator wrote them, kept when a change they asked for rewrote this line. */
  originalLine?: string | null;
  /** The operator changed this scene's words or picture: later rewrites keep it as it is. */
  edited?: boolean;
};

export type VideoScript = {
  id: string;
  title: string;
  angle: { key: string; name: string; stage: string; kind: string };
  pain: string;
  framework: { key: string; name: string };
  style: string;
  durationSeconds: number;
  hookAlternatives: string[];
  /** One precise description of the on-camera person, repeated in every clip so they stay the same. null when nobody appears. */
  character: string | null;
  setting: string;
  scenes: VideoScene[];
  adCopy: { primaryText: string; headline: string; description: string; cta: string };
  warnings: string[];
  /** The verifier's review of this script and what it fixed on its own. */
  verification?: Verification | null;
  /** "uploaded": the operator's own script, kept word for word unless they asked for a change. */
  source?: "written" | "uploaded";
  /** What was done to an uploaded script: how it was split, what was restored, and changes the operator asked for. */
  handling?: {
    /** Scenes where the model had changed a word and the operator's exact words were put back. */
    restoredScenes: number[];
    /** Scenes where the model had added words that are not in the script, which were removed. */
    removedScenes: number[];
    /** Scenes added because the analysis had skipped a spoken part the script labels (a VO line); its exact words were put in. */
    addedScenes?: number[];
    /** Parts of the script that were not spoken lines (directions, notes) and were not put in any scene's words. */
    unusedText: string[];
    changes: Array<{ target: string; was: string; now: string }>;
  } | null;
} & ScriptExtras;

export type VideoBrief = {
  brandName: string;
  voice?: string | null;
  colors?: string[] | null;
  imageryNotes?: string | null;
  pageExcerpt?: string | null;
  /** More of the page's text, for the creative brief. */
  pageText?: string | null;
  summary?: string | null;
  industry?: string | null;
  description?: string | null;
  valueProposition?: string | null;
  audience?: string | null;
  offerName: string;
  offerDescription?: string | null;
  landingPageUrl?: string | null;
  instructions?: string | null;
  offerDetails?: string | null;
  stats: string[];
  /** Uploaded images, already read: what each shows and the stats printed in it. */
  images: Array<{ id: string; name: string; summary: string; stats: Array<{ value: string; label: string }> }>;
  targetSeconds: number;
  /** "auto" lets the writer pick a different style per script. */
  style: string;
  locale: string;
  /** The claims that have a recorded source: the only figures and results the script may state. */
  claims?: ApprovedClaim[];
  /** Pronunciations the operator asked for; the writer must use those terms as written. */
  pronunciationNotes?: string[];
};

const CTA_VALUES = ADSPIRER_META_CTAS as unknown as [string, ...string[]];

export const sceneSchema = z.object({
  seconds: z.number().min(2).max(12).describe("Only for a scene with no speech: how long the visual holds (2-5). For a scene with speech this is ignored: its length follows the words."),
  visual: z.string().describe("What is seen: subject, setting, action. Concrete and filmable."),
  camera: z.string().describe("Shot size, angle and movement."),
  speaker: z.enum(["on_camera", "voiceover", "none"]),
  line: z.string().describe("The exact words spoken in this scene, or empty. No stage directions."),
  keywords: z.array(z.string()).max(3).describe("0-3 words from the line to highlight on screen"),
  stat: z.string().nullable().describe("A number to show big on screen, only if it appears in the facts or operator stats; else null"),
  asset_id: z.string().nullable().describe("The id of an uploaded image to show in this scene (so a screenshot with a stat is on screen while the stat is said), or null"),
  sound: z.string().describe("Music and sound effects for this scene"),
});

const scriptSchema = z.object({
  scripts: z.array(
    z.object({
      angle_key: z.string().describe("Exactly the assigned angle key"),
      title: z.string().describe("A short working title"),
      pain: z.string().describe("The specific pain, hope or objection this script targets, in one sentence"),
      style: z.string().describe("The look, e.g. UGC creator walkthrough, cinematic, motion graphics over footage, documentary, 3D animated. Different for each script."),
      hook_alternatives: z.array(z.string()).length(3).describe("Three different spoken or on-screen openings for the first 2 seconds"),
      character: z.string().nullable().describe("If a person appears: ONE precise description (age range, build, hair, wardrobe, accent, manner) that will be repeated word for word in every clip. null if nobody appears."),
      setting: z.string().describe("Where it takes place and the lighting, kept consistent"),
      scenes: z.array(sceneSchema).min(4).max(14),
      primary_text: z
        .string()
        .describe(
          "The ad's primary text, 70 to 130 words, facts only. Line 1: a standalone hook under 125 characters (a pain in the viewer's words, a surprising fact from the page, or a bold claim you can back). Then 2 to 3 short paragraphs separated by blank lines: the moment or problem they will recognise, what changes and how it works, and proof taken from the facts. Last line: the next step, in plain words. Conversational, no dashes, no stock marketing words, no emoji unless the brand voice uses them.",
        ),
      headline: z.string().describe("Under 40 characters"),
      description: z.string().describe("Under 30 characters"),
      cta: z.enum(CTA_VALUES),
    }),
  ),
});

export function briefFacts(b: VideoBrief): string {
  return [
    `Business: ${b.brandName}`,
    b.industry ? `Industry: ${b.industry}` : null,
    b.description ? `What they do: ${b.description}` : null,
    b.valueProposition ? `Value proposition: ${b.valueProposition}` : null,
    b.audience ? `Audience: ${b.audience}` : null,
    b.voice ? `Brand voice: ${b.voice}` : null,
    b.colors?.length ? `Brand colours: ${b.colors.join(", ")}` : null,
    b.imageryNotes ? `Brand imagery notes: ${b.imageryNotes}` : null,
    b.summary ? `Brand summary: ${b.summary}` : null,
    `Offer being advertised: ${b.offerName}${b.offerDescription ? ` — ${b.offerDescription}` : ""}`,
    b.landingPageUrl ? `Landing page: ${b.landingPageUrl}` : null,
    b.offerDetails ? `Offer details from the operator: ${b.offerDetails.slice(0, 2000)}` : null,
    b.instructions ? `Operator's instructions (follow them): ${b.instructions.slice(0, 2000)}` : null,
    b.stats.length ? `Stats the operator wants shown (real, use them):\n${b.stats.map((s) => `- ${s}`).join("\n")}` : null,
    b.images.length
      ? [
          "Uploaded images the operator wants in the video (each was read automatically):",
          ...b.images.map(
            (i) => `- id ${i.id} (${i.name}): ${i.summary || "no description"}${i.stats.length ? `. Stats printed in it: ${i.stats.map((x) => `${x.value} ${x.label}`).join("; ")}` : ""}`,
          ),
        ].join("\n")
      : null,
    b.pageExcerpt ? `\nWhat their site says:\n${b.pageExcerpt.slice(0, 3000)}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Numbers in `text` (as written: 255%, $120M, 1,500). */
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]$/, "")).filter((n) => n.replace(/\D/g, "").length >= 2);
}

/** Words and constructions that make copy read as machine-written marketing. */
const AI_TELLS: RegExp[] = [
  /\b(discover|unlock|unleash|elevate|revolutioni[sz]e|supercharge|empower|leverage|delve|tapestry|seamless(ly)?|cutting[- ]edge|game[- ]?chang(er|ing)|next level|world[- ]class|robust|holistic|synergy)\b/i,
  /\b(look no further|say goodbye|ever wondered|let'?s dive|in today'?s (fast|digital|world)|here'?s the (thing|kicker|catch)|the truth is|whether you'?re)\b/i,
  /\bnot just\b.{0,60}\b(it'?s|but)\b/i,
  /\bimagine (if|a world|having|this)\b/i,
];

const CONTRACTION = /\b\w+(n't|'s|'re|'ll|'ve|'d|'m)\b/i;

/**
 * Lines that read like ad copy or a teleprompter instead of a person talking, and ad copy that is
 * too thin. Shown to the operator and used to ask the writer for another go.
 */
export function qualityWarnings(script: Pick<VideoScript, "scenes" | "adCopy">): string[] {
  const warnings: string[] = [];
  for (const scene of script.scenes) {
    const line = scene.line;
    if (!line) continue;
    if (/[—–;]/.test(line)) warnings.push(`Scene ${scene.number} sounds scripted: it uses a dash or semicolon, which people do not speak.`);
    if (AI_TELLS.some((re) => re.test(line))) warnings.push(`Scene ${scene.number} sounds like an ad, not a person (stock marketing words).`);
    const longest = Math.max(...line.split(/[.!?]+/).map((s) => wordCount(s)));
    if (longest > 18) warnings.push(`Scene ${scene.number} has a ${longest}-word sentence; break it up so it sounds spoken.`);
  }
  // People contract words when they talk. One uncontracted line is fine; a script of them sounds read out.
  const spoken = script.scenes.filter((s) => wordCount(s.line) >= 6);
  if (spoken.length >= 3 && spoken.filter((s) => CONTRACTION.test(s.line)).length / spoken.length < 0.3) {
    warnings.push("Most spoken lines have no contractions (I'm, it's, didn't), so it sounds stiff and read out.");
  }
  const copy = script.adCopy.primaryText.trim();
  const words = wordCount(copy);
  const hook = copy.split("\n")[0]?.trim() ?? "";
  if (words < 60) warnings.push(`The ad copy is short (${words} words); aim for 70 to 130 with a strong hook and a real body.`);
  if (hook.length > 125) warnings.push(`The first line of the ad copy is ${hook.length} characters; Meta cuts it at about 125, so the hook must fit.`);
  if (/[—–]/.test(copy) || AI_TELLS.some((re) => re.test(copy))) warnings.push("The ad copy has stock marketing wording or dashes that read as machine-written.");
  return warnings;
}

/**
 * Warnings for a script: pace too fast, a stat or spoken number not in the facts, a hook that
 * starts late, the wrong total length, an uploaded image that does not exist, lines that do not
 * sound spoken, and ad copy that is too thin.
 */
export function checkScript(script: VideoScript, ctx: { corpus: string; assetIds: string[]; target: number; claims?: ApprovedClaim[] }): string[] {
  const warnings: string[] = [];
  const total = script.scenes.reduce((a, s) => a + s.seconds, 0);
  if (total > MAX_SECONDS) warnings.push(`Runs ${total}s, over the ${MAX_SECONDS}s limit. Cut or shorten a scene.`);
  for (const scene of script.scenes) {
    if (scene.line && wordCount(scene.line) / scene.seconds > MAX_WORDS_PER_SECOND) {
      warnings.push(`Scene ${scene.number} has ${wordCount(scene.line)} words in ${scene.seconds}s, too fast to speak clearly.`);
    }
    const risky = textRisk(scene.visual);
    if (risky.length) warnings.push(`Scene ${scene.number} shows ${risky.join(" and ")}: AI video draws garbled text there. Show a person or an object instead; the real stat or screenshot is added on top afterwards.`);
    if (scene.assetId && !ctx.assetIds.includes(scene.assetId)) warnings.push(`Scene ${scene.number} uses an image that was not uploaded.`);
    if (!ctx.claims) {
      for (const n of numbersIn(`${scene.stat ?? ""} ${scene.line}`)) {
        if (!ctx.corpus.includes(n)) warnings.push(`Scene ${scene.number} states "${n}", which is not in your page or inputs.`);
      }
    }
  }
  if (ctx.claims) {
    // Every figure must match an approved claim by value, never by a loose substring of the page text.
    for (const u of unsourcedFigures(script, ctx.claims)) warnings.push(`${u.where} states "${u.figure}", which has no recorded source in your page, stats or images.`);
  } else {
    for (const n of numbersIn(script.adCopy.primaryText)) {
      if (!ctx.corpus.includes(n)) warnings.push(`The ad copy states "${n}", which is not in your page or inputs.`);
    }
  }
  if (script.scenes[0] && script.scenes[0].seconds > 5) warnings.push("The opening scene is longer than 5s; the hook should land in the first 2-3 seconds.");
  warnings.push(...qualityWarnings(script));
  return [...new Set(warnings)];
}

/** Every figure the script states (spoken, shown big, or in the ad copy) that no approved claim backs. */
export function unsourcedFigures(script: Pick<VideoScript, "scenes" | "adCopy">, claims: ApprovedClaim[]): Array<{ where: string; figure: string }> {
  const uses: ClaimUse[] = [];
  for (const scene of script.scenes) {
    if (scene.line) uses.push({ text: scene.line, where: `Scene ${scene.number}` });
    if (scene.stat) uses.push({ text: scene.stat, where: `Scene ${scene.number}` });
  }
  uses.push({ text: script.adCopy.primaryText, where: "The ad copy" });
  uses.push({ text: script.adCopy.headline, where: "The ad headline" });
  const { unsourced } = sourceClaims(uses, claims);
  const seen = new Set<string>();
  return unsourced
    .map((u) => ({ where: u.use.where, figure: u.figure }))
    .filter((u) => (seen.has(`${u.where}|${u.figure}`) ? false : (seen.add(`${u.where}|${u.figure}`), true)));
}

type RawScript = z.infer<typeof scriptSchema>["scripts"][number];

export function buildScripts(
  raw: RawScript[],
  assigned: Array<{ angle: BulkAngle; framework: Framework }>,
  ctx: { corpus: string; assetIds: string[]; target: number; claims?: ApprovedClaim[] },
): VideoScript[] {
  const byKey = new Map<string, RawScript>();
  for (const r of raw) if (!byKey.has(r.angle_key)) byKey.set(r.angle_key, r);
  const out: VideoScript[] = [];
  for (const { angle, framework } of assigned) {
    const r = byKey.get(angle.key);
    if (!r) continue;
    // Each scene is as long as its line takes to say; the writer's "seconds" only sets how long a silent visual holds.
    const scenes: VideoScene[] = retime(
      r.scenes.map((sc, i) => ({
        number: i + 1,
        seconds: sc.seconds,
        visual: sc.visual,
        camera: sc.camera,
        speaker: sc.speaker,
        line: sc.line.trim(),
        keywords: sc.keywords.map((k) => k.trim()).filter(Boolean),
        stat: sc.stat?.trim() || null,
        assetId: sc.asset_id && ctx.assetIds.includes(sc.asset_id) ? sc.asset_id : null,
        sound: sc.sound,
      })),
    );
    const cursor = scenes.length ? scenes[scenes.length - 1]!.end : 0;
    const script: VideoScript = {
      id: `script_${angle.key}`,
      title: r.title,
      angle: { key: angle.key, name: angle.name, stage: STAGE_LABEL[angle.stage], kind: angle.kind },
      pain: r.pain,
      framework: { key: framework.key, name: framework.name },
      style: r.style,
      durationSeconds: cursor,
      hookAlternatives: r.hook_alternatives,
      character: r.character?.trim() || null,
      setting: r.setting,
      scenes,
      adCopy: { primaryText: r.primary_text, headline: r.headline, description: r.description, cta: r.cta },
      warnings: [],
    };
    script.warnings = checkScript(script, ctx);
    out.push(script);
  }
  return out;
}

/** Everything the script may state as fact: the page, the operator's words and stats. Numbers are checked against it. */
export function factsCorpus(b: VideoBrief, extra: string[] = []): string {
  return [briefFacts(b), ...extra].join("\n");
}

const messageMapSchema = z.object({
  pains: z.array(z.string()),
  desires: z.array(z.string()),
  objections: z.array(z.string()),
  proof: z.array(z.string()).describe("Real proof points from the facts only"),
  mechanism: z.string(),
});

/**
 * LEGACY single-call writer (fixed angle bank, randomly assigned named frameworks). The app now writes through
 * the creative brief, planned angles and `script-writer.ts`; this is kept only so the live evaluation can
 * compare the old output with the new on the same inputs.
 */
export async function writeVideoScripts(brief: VideoBrief, onStage?: (stage: "understanding" | "writing") => Promise<void> | void): Promise<{ scripts: VideoScript[]; messageMap: z.infer<typeof messageMapSchema> }> {
  const model = pickModel();
  if (!model) throw new Error("No language model is configured to write scripts (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
  const facts = briefFacts(brief);
  const target = Math.min(Math.max(Math.round(brief.targetSeconds || DEFAULT_SECONDS), 15), MAX_SECONDS);

  await onStage?.("understanding");
  const { object: messageMap } = await generateObject({
    model,
    schema: messageMapSchema,
    temperature: 0.4,
    system: SYSTEM,
    prompt: `${facts}\n\nAnalyse the offer: the audience's real pains, desires and objections, the proof points that actually appear above, and how the offer delivers its result. Ground everything in the facts.`,
  });

  const angles = pickBulkAngles(SCRIPT_COUNT);
  const frameworks = assignFrameworks(angles);
  const assigned = angles.map((angle, i) => ({ angle, framework: frameworks[i]! }));
  const ctx = { corpus: factsCorpus(brief, [JSON.stringify(messageMap)]), assetIds: brief.images.map((i) => i.id), target, claims: brief.claims };

  const write = async (extra?: string) => {
    const { object } = await generateObject({
      model,
      schema: scriptSchema,
      temperature: 0.85,
      system: SYSTEM,
      prompt: [
        facts,
        `\nMessage map:\n${JSON.stringify(messageMap)}`,
        `\nWrite exactly ${assigned.length} video ad scripts, one for EACH assignment below, with the exact angle_key. Each targets a different pain, hope or objection and uses a different look, so the three are genuinely different ads, not rewordings.`,
        assigned
          .map(
            (a, i) =>
              `${i + 1}. angle_key "${a.angle.key}" · ${a.angle.name} · ${STAGE_LABEL[a.angle.stage]} · targets a ${a.angle.kind}: ${a.angle.brief}\n   Framework "${a.framework.name}": ${a.framework.beats}`,
          )
          .join("\n"),
        `\nLength: aim for about ${target} seconds, but never pad or squeeze to hit it. Each scene is exactly as long as its spoken line takes to say (about ${WORDS_PER_SECOND} words a second, plus a beat), so write about ${Math.round(target * WORDS_PER_SECOND * 0.85)} words of speech across the whole script and let the length fall where it falls. A scene with no speech holds for a short visual beat (2 to 5 seconds). The total must not pass 60 seconds. Vertical 9:16 for Reels and Stories, watched mostly muted: every spoken line also appears as an on-screen keyword or caption, and the first 2 seconds must already earn attention with a visual and a line that fit the framework.`,
        `Voice and language: ${brief.locale}. Spoken lines are natural, conversational and about 2.5 words a second at most.`,
        brief.style && brief.style !== "auto" ? `Preferred style: ${brief.style}. Use it for the scripts where it suits, and a different look for the others.` : "Choose a different style for each script from what suits the business and angle (for example UGC creator walkthrough, cinematic, motion graphics over footage, documentary, 3D animated).",
        `Scene detail: each scene's visual is concrete and filmable, with camera, who speaks (on_camera = the presenter speaks to camera, voiceover = unseen voice over the visuals), the exact line, up to 3 keywords to highlight, a stat if (and only if) it is in the facts or the operator's stats, and sound. Use every stat found in the uploaded images, and the operator's own stats, in the scene whose spoken line makes the point: set stat to the number exactly as printed and asset_id to the image it came from, so the screenshot is shown and the number is highlighted at that moment. One person at most speaks on camera and is the same person throughout: describe them once in "character".`,
        HUMAN_VOICE,
        VISUAL_DIRECTION_RULES,
        `Ad copy: write it like a short post from a person, not a brochure. 70 to 130 words. The first line is a standalone hook under 125 characters, because Meta cuts the text there. Then two or three short paragraphs separated by blank lines: the situation the viewer recognises, what changes and how it works, and proof taken from the facts. End with the next step in plain words. Facts only. The headline is under 40 characters and the description under 30. Pick the CTA button from the list.`,
        extra ?? null,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    return object.scripts;
  };

  await onStage?.("writing");
  let scripts = buildScripts(await write(), assigned, ctx);
  // Only if a whole script is missing is it worth writing again; everything else is the verifier's job.
  if (scripts.length < assigned.length) {
    try {
      const retry = buildScripts(await write("One or more of the assigned scripts was missing. Write all of them."), assigned, ctx);
      if (retry.length > scripts.length) scripts = retry;
    } catch {
      // keep the first attempt
    }
  }
  if (!scripts.length) throw new Error("The script writer returned nothing usable. Try again.");
  return { scripts, messageMap };
}
