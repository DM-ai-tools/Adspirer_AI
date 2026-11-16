import { z } from "zod";
import { textRisk } from "@/lib/video/visual-rules";
import type { VideoConcept } from "@/lib/video/script-types";
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
  /**
   * Who says what, in spoken order, when the script has voices (see VideoScript.voices). `line` is
   * these texts joined, and `speaker` is derived from them, so older readers keep working.
   */
  lines?: SceneLine[];
};

/** One spoken part of a scene: which voice says it and whether that speaker is on camera. */
export type SceneLine = { voiceId: string; text: string; onCamera: boolean };

/** A speaking voice: a narrator or a character who talks. */
export type ScriptVoice = { id: string; who: string; description: string };

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
  /** Every voice that speaks, at most three. Absent on older scripts: they have one voice. */
  voices?: ScriptVoice[];
  /** The concept the operator chose, when the script was written from one. */
  concept?: VideoConcept;
  /** The script as it was before the last change the operator asked for, so that change can be undone. */
  previousVersion?: VideoScript;
  /** One plain line on what the last change did. */
  changeNote?: string | null;
  /** What was changed so an uploaded script or concept fits what the video model can make. */
  adaptations?: string[];
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
  images: Array<{ id: string; name: string; summary: string; stats: Array<{ value: string; label: string }>; mainStat?: { value: string; label: string } | null }>;
  targetSeconds: number;
  /** "auto" lets the writer pick a different style per script. */
  style: string;
  /** The video type and idea the operator gave before the script was written, as one direction block. */
  direction?: string | null;
  locale: string;
  /** The claims that have a recorded source: the only figures and results the script may state. */
  claims?: ApprovedClaim[];
  /** Pronunciations the operator asked for; the writer must use those terms as written. */
  pronunciationNotes?: string[];
};

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

export type StatInsert = {
  scene: number;
  figure: string;
  /** True when the scene's spoken line says the figure, so it is heard in the video. */
  spoken: boolean;
  /** True when an approved claim backs the figure; otherwise it should be confirmed before it goes on screen. */
  sourced: boolean;
  /** The words it is said in, for finding the moment in the edit. */
  line: string;
};

/**
 * The figures in the script, scene by scene, for someone to put on screen afterwards. The footage
 * never draws a number (the video model cannot spell), so each stat is said in the voice and listed
 * here; the exported placement plan gives the exact time it is said.
 */
export function statInserts(script: Pick<VideoScript, "scenes">, claims: ApprovedClaim[]): StatInsert[] {
  const out: StatInsert[] = [];
  for (const scene of script.scenes) {
    const inLine = sourceClaims([{ text: scene.line, where: `Scene ${scene.number}` }], claims);
    const spokenFigures = [...inLine.sourced.map((f) => ({ figure: f.figure, sourced: true })), ...inLine.unsourced.map((f) => ({ figure: f.figure, sourced: false }))];
    for (const f of spokenFigures) {
      if (!out.some((o) => o.scene === scene.number && o.figure === f.figure)) out.push({ scene: scene.number, figure: f.figure, spoken: true, sourced: f.sourced, line: scene.line });
    }
    if (scene.stat) {
      const stat = sourceClaims([{ text: scene.stat, where: `Scene ${scene.number}` }], claims);
      const sourced = stat.unsourced.length === 0;
      // A stat whose figure the line already says is the same insert; one the line never says is shown only.
      const statFigures = [...stat.sourced, ...stat.unsourced].map((f) => f.figure);
      const said = statFigures.length > 0 && statFigures.every((fig) => spokenFigures.some((s) => s.figure === fig));
      if (said) {
        for (const o of out) if (o.scene === scene.number && statFigures.includes(o.figure)) o.figure = scene.stat;
      } else if (!out.some((o) => o.scene === scene.number && o.figure === scene.stat)) {
        out.push({ scene: scene.number, figure: scene.stat, spoken: false, sourced, line: scene.line });
      }
    }
  }
  return out;
}

/** A figure shown big on screen that no approved claim backs: it is never drawn. */
export function dropUnsourcedStats(script: VideoScript, claims: ApprovedClaim[]): VideoScript {
  const unsourced = (scene: VideoScene) => Boolean(scene.stat) && sourceClaims([{ text: scene.stat!, where: `Scene ${scene.number}` }], claims).unsourced.length > 0;
  if (!script.scenes.some(unsourced)) return script;
  return { ...script, scenes: script.scenes.map((s) => (unsourced(s) ? { ...s, stat: null } : s)) };
}

/** Scenes whose picture is a number, chart, report or screen: they cannot be shown without the figure they carry. */
const FIGURE_VISUAL = /\b(dashboards?|charts?|graphs?|reports?|screens?|screenshots?|stats?|statistics?|numbers?|figures?|invoices?|revenue|results?|analytics|metrics?)\b/i;

export type FigureAdjustment = { scene: number; figure: string; change: string };

/**
 * A script with figures nobody has a source for still gets made. Where a scene would have to show
 * the figure (a number on screen, or a picture of a report or result) the figure is left out and the
 * scene is told to picture the situation in footage instead. A figure that is only spoken stays as
 * the operator wrote it: it is reported, not rewritten.
 */
export function adaptToMissingSources(script: VideoScript, claims: ApprovedClaim[], options: { keepStats?: boolean } = {}): { script: VideoScript; adjustments: FigureAdjustment[] } {
  const open = unsourcedFigures(script, claims);
  if (!open.length) return { script, adjustments: [] };
  const adjustments: FigureAdjustment[] = [];
  const scenes = script.scenes.map((scene) => {
    const figures = open.filter((o) => o.where === `Scene ${scene.number}`).map((o) => o.figure);
    if (!figures.length) return scene;
    const statUnsourced = Boolean(scene.stat) && sourceClaims([{ text: scene.stat!, where: `Scene ${scene.number}` }], claims).unsourced.length > 0;
    if (!statUnsourced && !FIGURE_VISUAL.test(scene.visual)) return scene;
    const shown = figures.map((f) => `"${f}"`).join(", ");
    adjustments.push({
      scene: scene.number,
      figure: figures.join(", "),
      change: statUnsourced
        ? options.keepStats
          ? "The scene pictures the situation in footage instead of the figure; the figure stays on the list of stats to insert in editing (confirm it first)."
          : "The figure is not shown on screen, and the scene pictures the situation in footage instead."
        : "The scene no longer shows a report, chart or screen; it pictures the situation in footage instead.",
    });
    return {
      ...scene,
      // A clean video never draws the stat, so it is kept as the note for the editor; a branded one drops it from the screen.
      stat: statUnsourced && !options.keepStats ? null : scene.stat,
      visual: `${scene.visual} CHANGED: ${shown} has no recorded source, so show no number, chart, report or screen in this scene. Picture the situation or the outcome in footage instead.`,
    };
  });
  return { script: { ...script, scenes }, adjustments };
}

/** Everything the script may state as fact: the page, the operator's words and stats. Numbers are checked against it. */
export function factsCorpus(b: VideoBrief, extra: string[] = []): string {
  return [briefFacts(b), ...extra].join("\n");
}
