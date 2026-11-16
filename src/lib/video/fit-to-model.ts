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
import { conceptSchema } from "@/lib/video/concepts";
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
    const pick = candidates.sort((a, b) => sceneSeconds(b.s) - sceneSeconds(a.s))[0]!;
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

/** Read the operator's own concept into the shape the writer works from. Their words are the source. */
export async function conceptFromText(text: string, ctx: { targetSeconds: number; deps?: { generate?: (prompt: string) => Promise<unknown> } }): Promise<VideoConcept> {
  const prompt = [
    "The operator wrote their own concept for a video ad. Read it into the fields below WITHOUT changing the idea: keep their premise, story, characters, places, tone and any lines they wrote. Fill in only what they left out, in the spirit of their idea.",
    `Plan about ${ctx.targetSeconds} seconds unless they said otherwise. No beat longer than ${MAX_SCENE_SECONDS} seconds (split longer ones). At most 3 speaking voices. Characters are invented people, never real or famous ones.`,
    "",
    "THE OPERATOR'S CONCEPT:",
    text.trim(),
  ].join("\n");
  const raw = ctx.deps?.generate
    ? await ctx.deps.generate(prompt)
    : await withModelFallback(async (model) => (await generateObject({ model, schema: conceptSchema, temperature: 0.2, prompt })).object);
  const parsed = conceptSchema.parse(raw);
  return { ...parsed, id: `concept_own_${Date.now().toString(36)}`, beats: parsed.beats.flatMap((b) => (b.seconds > MAX_SCENE_SECONDS ? [{ ...b, seconds: MAX_SCENE_SECONDS }, { text: `${b.text} (continued)`, seconds: Math.max(2, b.seconds - MAX_SCENE_SECONDS) }] : [b])) };
}

