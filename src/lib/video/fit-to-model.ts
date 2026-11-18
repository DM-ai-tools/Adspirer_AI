/**
 * Fitting an operator's own script (or concept) to what the video model can make.
 *
 * The operator's words are theirs, so the smallest change that makes the video possible is made,
 * and each one is reported in a plain line:
 *  - a picture the model cannot draw (text to read, a screen, a logo, a real or famous person) is
 *    re-pictured as something that shows the same thing;
 *  - when the whole script runs past the video limit, middle scenes are dropped (never the first or
 *    the last, never one the operator edited);
 *  - a scene longer than one clip is split, at sentences first, with every word kept in order.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { withModelFallback } from "@/lib/video/model-fallback";
import { textRisk } from "@/lib/video/visual-rules";
import { MAX_SCENE_SECONDS, retime, sceneSeconds, splitLongLine } from "@/lib/video/timing";
import { splitLongScenes } from "@/lib/video/script-writer";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { VideoConcept } from "@/lib/video/script-types";

const FAMOUS = /\b(celebrity|celebrities|famous|lookalike|look-alike|movie star|pop star|influencer named|president|prime minister)\b/i;

/** What in a visual the video model cannot draw. Empty when it can. Pure. */
export function unrenderable(visual: string): string[] {
  const out = [...textRisk(visual)];
  if (FAMOUS.test(visual)) out.push("a real or famous person");
  return out;
}

export type Repicture = (scenes: Array<{ number: number; visual: string; line: string; reasons: string[] }>) => Promise<Record<number, string>>;

const repictureSchema = z.object({ scenes: z.array(z.object({ number: z.number().int(), visual: z.string() })) });

function defaultRepicture(): Repicture {
  return async (scenes) => {
    const prompt = [
      "These shots from a video ad script cannot be made by an AI video model as written. Rewrite each visual so it shows the same idea in a way the model CAN film: no readable text, signs, screens, numbers or logos anywhere in the frame; no real or famous people (use an invented person of the same kind instead). Keep the action, mood and place as close as possible. Return one new visual per scene number.",
      ...scenes.map((s) => `Scene ${s.number}: "${s.visual}" (problem: ${s.reasons.join(", ")}; what is said over it: "${s.line}")`),
    ].join("\n");
    const out = await withModelFallback(async (model) => (await generateObject({ model, schema: repictureSchema, temperature: 0.4, prompt })).object);
    return Object.fromEntries(out.scenes.map((s) => [s.number, s.visual.trim()]));
  };
}

/** Fit a script to the model, reporting every change in plain words. The operator's words are only cut when the video is over its limit. */
export async function fitToModel(script: VideoScript, opts: { maxSeconds: number; repicture?: Repicture }): Promise<{ script: VideoScript; adaptations: string[] }> {
  const adaptations: string[] = [];
  let scenes: VideoScene[] = script.scenes.map((s) => ({ ...s }));
  // Every adaptation is reported with the scene numbers the operator wrote.
  const origin = new Map<VideoScene, number>(scenes.map((s) => [s, s.number]));
  const orig = (s: VideoScene) => origin.get(s) ?? s.number;

  // 1. Pictures the model cannot draw.
  const risky = scenes.map((s) => ({ number: s.number, visual: s.visual, line: s.line, reasons: unrenderable(s.visual) })).filter((s) => s.reasons.length);
  if (risky.length) {
    let fresh: Record<number, string> = {};
    try {
      fresh = await (opts.repicture ?? defaultRepicture())(risky);
    } catch {
      fresh = {};
    }
    for (const r of risky) {
      const next = fresh[r.number]?.trim();
      if (next && !unrenderable(next).length) {
        scenes = scenes.map((s) => {
          if (s.number !== r.number) return s;
          const moved = { ...s, visual: next };
          origin.set(moved, orig(s));
          return moved;
        });
        adaptations.push(`Scene ${r.number} re-pictured: ${r.reasons.join(" and ")} cannot be drawn by the video model, so it now shows: ${next}`);
      } else {
        adaptations.push(`Scene ${r.number} shows ${r.reasons.join(" and ")}, which may not come out right: the video model cannot draw readable text or real people. Consider changing that picture.`);
      }
    }
  }

  // 2. Over the length limit: drop the wordiest middle scenes until it fits.
  const length = (list: VideoScene[]) => list.reduce((t, s) => t + sceneSeconds(s), 0);
  const before = length(scenes);
  const dropped: number[] = [];
  while (length(scenes) > opts.maxSeconds && scenes.length > 2) {
    const candidates = scenes.map((s, i) => ({ s, i })).filter(({ s, i }) => i !== 0 && i !== scenes.length - 1 && !s.edited);
    if (!candidates.length) break;
    // The smallest scene whose removal is enough; only when no single scene is enough, the longest (and go round again).
    const over = length(scenes) - opts.maxSeconds;
    const enough = candidates.filter(({ s }) => sceneSeconds(s) >= over).sort((a, b) => sceneSeconds(a.s) - sceneSeconds(b.s));
    const pick = enough[0] ?? candidates.sort((a, b) => sceneSeconds(b.s) - sceneSeconds(a.s))[0]!;
    dropped.push(orig(pick.s));
    scenes = scenes.filter((_, i) => i !== pick.i);
  }
  if (dropped.length) {
    adaptations.push(`The script ran about ${Math.round(before)} seconds, longer than ${opts.maxSeconds} seconds, so ${dropped.length === 1 ? `scene ${dropped[0]} was` : `scenes ${dropped.sort((a, b) => a - b).join(", ")} were`} left out.`);
  }
  if (length(scenes) > opts.maxSeconds) adaptations.push(`The script still runs about ${Math.round(length(scenes))} seconds, past the ${opts.maxSeconds} second limit. Shorten it before making the video.`);

  // 3. Scenes longer than one clip: split, every word kept.
  for (const s of scenes) {
    const seconds = sceneSeconds(s);
    if (seconds <= MAX_SCENE_SECONDS) continue;
    const parts = s.lines?.length ? s.lines.flatMap((l) => splitLongLine(l.text)) : splitLongLine(s.line);
    adaptations.push(`Scene ${orig(s)} split in ${parts.length}: it ran about ${seconds} seconds, and one scene can be at most ${MAX_SCENE_SECONDS}.`);
  }

  const timed = retime(scenes.map((s, i) => ({ ...s, number: i + 1 })));
  const fitted = splitLongScenes({ ...script, scenes: timed, durationSeconds: timed.length ? timed[timed.length - 1]!.end : 0 });
  if (!adaptations.length) return { script, adaptations };
  return { script: { ...fitted, adaptations }, adaptations };
}

/** The concept the model is asked for: no size limits, because the limits are applied afterwards by `normaliseConcept` instead of rejecting a good answer. */
const readConceptSchema = z.object({
  title: z.string().describe("2-5 words, the concept's own name"),
  format: z.string().describe("The format in your own words, e.g. 'faux movie trailer', 'sitcom scene'"),
  logline: z.string().describe("The whole idea in one sentence"),
  hook: z.string().describe("Exactly what the viewer sees and hears in the first 2 seconds"),
  beats: z.array(z.object({ text: z.string().describe("What happens, in plain words, including any lines spoken"), seconds: z.number().describe("Roughly how long it runs, at most 15") })).describe("The story beat by beat, in order"),
  whyItWorks: z.string(),
  brandLink: z.string().describe("How the story lands on the brand's message"),
  look: z.string().describe("Mood, light, camera style, colour"),
  cast: z.array(z.string()).describe("Who appears, each in a few words"),
  settings: z.array(z.string()).describe("Where it happens"),
  voices: z.array(z.object({ id: z.string(), who: z.string(), description: z.string().describe("gender, rough age, timbre, accent, pace, energy") })).describe("Every voice that speaks"),
  seconds: z.number().describe("Planned length in seconds"),
});

const MAX_BEATS = 8;
const text = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);

/** Put a reading of the operator's concept in the shape the writer needs, merging and trimming instead of failing. Pure. */
export function normaliseConcept(raw: unknown, targetSeconds: number): Omit<VideoConcept, "id"> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let beats = (Array.isArray(r.beats) ? r.beats : [])
    .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === "object")
    .map((b) => ({ text: text(b.text), seconds: Number.isFinite(Number(b.seconds)) && Number(b.seconds) > 0 ? Number(b.seconds) : 4 }))
    .filter((b) => b.text);
  // More beats than the system can plan: the two shortest neighbours become one, so the whole story stays.
  while (beats.length > MAX_BEATS) {
    let at = 0;
    let least = Infinity;
    for (let i = 0; i < beats.length - 1; i += 1) {
      const together = beats[i]!.seconds + beats[i + 1]!.seconds;
      if (together < least) {
        least = together;
        at = i;
      }
    }
    beats = [...beats.slice(0, at), { text: `${beats[at]!.text} Then: ${beats[at + 1]!.text}`, seconds: least }, ...beats.slice(at + 2)];
  }
  const list = (v: unknown, max: number) => (Array.isArray(v) ? v : []).map((x) => text(x)).filter(Boolean).slice(0, max);
  const voices = (Array.isArray(r.voices) ? r.voices : [])
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
    .map((v, i) => ({ id: text(v.id, `voice${i + 1}`), who: text(v.who, "narrator"), description: text(v.description, "Natural, clear, confident") }))
    .slice(0, 4);
  const title = text(r.title, "Your concept");
  return {
    title,
    format: text(r.format, "Your own format"),
    logline: text(r.logline, title),
    hook: text(r.hook, beats[0]?.text ?? title),
    beats,
    whyItWorks: text(r.whyItWorks, "It is the operator's own idea."),
    brandLink: text(r.brandLink),
    look: text(r.look, "As the concept describes"),
    cast: list(r.cast, 6),
    settings: list(r.settings, 6),
    voices: voices.length ? voices : [{ id: "narrator", who: "narrator", description: "Natural, confident, warm" }],
    seconds: Number.isFinite(Number(r.seconds)) && Number(r.seconds) > 0 ? Number(r.seconds) : targetSeconds,
  };
}

/** Read a concept with no model: its paragraphs (or sentences) are the beats, in order. Pure. */
export function conceptByRules(source: string, targetSeconds: number): Omit<VideoConcept, "id"> {
  const clean = source.trim();
  let parts = clean.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (parts.length < 2) parts = clean.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) parts = [clean.replace(/\s+/g, " "), "The story lands on the brand and its next step"];
  const each = Math.min(MAX_SCENE_SECONDS, Math.max(2, Math.round(targetSeconds / Math.max(parts.length, 1))));
  const first = clean.split(/(?<=[.!?])\s+|\n/)[0]!.trim();
  return normaliseConcept(
    {
      title: first.length <= 60 ? first.replace(/[.!?]+$/, "") : "Your concept",
      format: "Your own concept",
      logline: first.slice(0, 240),
      hook: parts[0]!.slice(0, 240),
      beats: parts.map((t) => ({ text: t.slice(0, 600), seconds: each })),
      whyItWorks: "It is the operator's own idea.",
      brandLink: "",
      look: "As the concept describes",
      cast: [],
      settings: [],
      voices: [],
      seconds: targetSeconds,
    },
    targetSeconds,
  );
}

/** Read the operator's own concept into the shape the writer works from. Their words are the source, and any text is accepted. */
export async function conceptFromText(text: string, ctx: { targetSeconds: number; deps?: { generate?: (prompt: string) => Promise<unknown> } }): Promise<VideoConcept> {
  const prompt = [
    "The operator wrote their own concept for a video ad. Read it into the fields below WITHOUT changing the idea: keep their premise, story, characters, places, tone and any lines they wrote. Fill in only what they left out, in the spirit of their idea.",
    `Plan about ${ctx.targetSeconds} seconds unless they said otherwise. At most 8 beats (group neighbouring moments into one beat if there are more). No beat longer than ${MAX_SCENE_SECONDS} seconds (split longer ones). At most 3 speaking voices. Characters are invented people, never real or famous ones.`,
    "",
    "THE OPERATOR'S CONCEPT:",
    text.trim(),
  ].join("\n");
  const ask = async (): Promise<unknown> => {
    if (ctx.deps?.generate) return ctx.deps.generate(prompt);
    let problem: string | null = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withModelFallback(async (model) => (await generateObject({ model, schema: readConceptSchema, temperature: 0.2, maxOutputTokens: 8000, prompt: problem ? `${prompt}\n\nYour last answer was rejected because it did not fit the required shape (${problem}). Answer again in the required shape.` : prompt })).object);
      } catch (error) {
        const e = error as { name?: string; message?: string; cause?: { message?: string } };
        if (attempt >= 1 || !(e?.name === "AI_NoObjectGeneratedError" || /did not match schema|no object generated/i.test(e?.message ?? ""))) throw error;
        problem = String(e.cause?.message ?? e.message ?? "").replace(/\s+/g, " ").slice(-400);
      }
    }
  };
  let parsed: Omit<VideoConcept, "id">;
  try {
    parsed = normaliseConcept(await ask(), ctx.targetSeconds);
    if (parsed.beats.length < 2) throw new Error("The reply had fewer than two beats.");
  } catch {
    // Whatever was typed is still read, from its own paragraphs, so nothing fails.
    parsed = conceptByRules(text, ctx.targetSeconds);
  }
  return { ...parsed, id: `concept_own_${Date.now().toString(36)}`, beats: parsed.beats.flatMap((b) => (b.seconds > MAX_SCENE_SECONDS ? [{ ...b, seconds: MAX_SCENE_SECONDS }, { text: `${b.text} (continued)`, seconds: Math.max(2, b.seconds - MAX_SCENE_SECONDS) }] : [b])) };
}
