/**
 * Changing a script by saying what to change.
 *
 * The operator writes what they want in their own words ("make the voiceover funnier", "scene 3
 * should end on the chase", "let Maya say the last line", "a punchier headline"). One model call
 * reads the request with the whole script and returns an edit plan: what the request is about (the
 * whole voiceover, some scenes, the ad copy, or the idea itself) and the new content for just those
 * parts. The plan is checked (no scene that does not exist, no edits to scenes the request did not
 * touch) and applied in place: every untouched scene keeps its words, picture and voices exactly.
 * The script as it was is kept, so the last change can be undone.
 */
import { generateObject } from "ai";
import { z } from "zod";
import { withModelFallback } from "@/lib/video/model-fallback";
import { buildScriptSpeech } from "@/lib/video/duration";
import { normaliseVoices, splitLongScenes } from "@/lib/video/script-writer";
import { MAX_SCENE_SECONDS, retime, wordsFor } from "@/lib/video/timing";
import type { SceneLine, VideoScene, VideoScript } from "@/lib/video/script";

export type ChangeScope = "voiceover" | "scenes" | "concept" | "ad_copy";

export type SceneEdit = { scene: number; lines?: SceneLine[] | null; visual?: string | null; camera?: string | null; sound?: string | null };

export type ChangePlan = {
  scope: ChangeScope;
  /** The scenes the request is about (empty for the ad copy or a new idea). */
  scenes: number[];
  /** One plain line for the operator on what changes. */
  summary: string;
  edits: SceneEdit[];
  adCopy: { primaryText: string; headline: string; description: string } | null;
  /** When set, nothing is changed and this is shown to the operator instead. */
  problem: string | null;
};

const modelSchema = z.object({
  scope: z.enum(["voiceover", "scenes", "concept", "ad_copy"]).describe("voiceover: the spoken words across the video. scenes: particular scenes (words and/or picture). ad_copy: the post text, headline or description. concept: the idea itself should be different, so the script must be rewritten from it."),
  scenes: z.array(z.number().int()).describe("The numbers of the scenes the request is about"),
  summary: z.string().describe("One short plain sentence for the operator on what you changed"),
  problem: z.string().describe("Empty when the change can be made. Otherwise one plain sentence on why not (e.g. the scene does not exist, the request is unclear)."),
  edits: z
    .array(
      z.object({
        scene: z.number().int(),
        lines: z
          .array(z.object({ voice_id: z.string(), text: z.string(), on_camera: z.boolean() }))
          .max(2)
          .nullable()
          .describe("The scene's new spoken lines in order, or null to keep them as they are. An empty list means nobody speaks."),
        visual: z.string().nullable().describe("The scene's new picture, or null to keep it"),
        camera: z.string().nullable().describe("The new camera, or null to keep it"),
        sound: z.string().nullable().describe("The new sound, or null to keep it"),
      }),
    )
    .describe("One entry per scene that changes; scenes not listed stay exactly as they are"),
  ad_copy: z.object({ primaryText: z.string(), headline: z.string(), description: z.string() }).nullable().describe("The new ad copy, only when the request is about it; otherwise null"),
});

export function changePrompt(script: VideoScript, request: string, ctx: { facts: string }): string {
  const s = normaliseVoices(script);
  const voices = s.voices ?? [];
  return [
    `The operator wants this change to their video script:\n"${request.trim()}"`,
    "",
    `THE SCRIPT ("${script.title}"${script.concept ? `, from the concept "${script.concept.title}": ${script.concept.logline}` : ", the operator's own script"}):`,
    `Voices: ${voices.map((v) => `${v.id} = ${v.who}${v.description ? ` (${v.description})` : ""}`).join("; ")}`,
    ...s.scenes.map((sc) => `${sc.number}. [${sc.visual}] [camera: ${sc.camera}] [sound: ${sc.sound}] ${sc.lines!.length ? sc.lines!.map((l) => `${l.voiceId}${l.onCamera ? " (on camera)" : ""}: "${l.text}"`).join(" / ") : "(nobody speaks)"}`),
    `Ad copy: headline "${script.adCopy.headline}"; description "${script.adCopy.description}"; post: ${script.adCopy.primaryText}`,
    "",
    "What is true about the business (anything said about it must come from here or from the script as it stands):",
    ctx.facts || "(only what the script already says)",
    "",
    "Rules:",
    "- Change ONLY what the request is about. Every scene you do not list stays exactly as it is, word for word. For a listed scene, set to null every field the request does not change.",
    "- A request about the voiceover or the narration changes spoken lines across the scenes that speak; it never changes pictures.",
    `- No scene may carry more than ${wordsFor(MAX_SCENE_SECONDS)} spoken words (${MAX_SCENE_SECONDS} seconds). The last spoken line stays the call to action unless the request is about it.`,
    `- Use only these voice ids: ${voices.map((v) => v.id).join(", ")}. At most two voices in one scene.`,
    "- Pictures stay filmable: nothing to read on screen (no signs, screens, numbers, logos), no real or famous people.",
    "- Never invent results, prices, offers, guarantees, urgency or customers.",
    script.concept
      ? "- Choose scope concept only when the operator wants a different idea or story, not a change to this one."
      : "- This is the operator's own script: never choose scope concept.",
    `- The script has ${s.scenes.length} scenes. If the request names a scene that does not exist or cannot be understood, explain in problem and change nothing.`,
  ].join("\n");
}

export type ChangeDeps = { generate?: (prompt: string) => Promise<unknown> };

function defaultGenerate(): (prompt: string) => Promise<unknown> {
  return async (prompt) =>
    withModelFallback(async (model) => (await generateObject({ model, schema: modelSchema, temperature: 0.4, system: "You edit video ad scripts exactly as asked and change nothing else. You never invent facts about the business.", prompt })).object);
}

/** Read the request against the script and return a checked edit plan. Throws only when no model answers. */
export async function planChange(script: VideoScript, request: string, ctx: { facts: string }, deps: ChangeDeps = {}): Promise<ChangePlan> {
  const text = request.trim();
  if (text.length < 3) return { scope: "scenes", scenes: [], summary: "", edits: [], adCopy: null, problem: "Say what you want changed." };
  // A scene the request names by number must exist: checked here, so it never depends on the model noticing.
  const named = [...text.matchAll(/\bscenes?\s+((?:\d+\s*(?:,|and|&|-|to)?\s*)+)/gi)].flatMap((m) => [...m[1]!.matchAll(/\d+/g)].map((d) => Number(d[0])));
  const absent = [...new Set(named.filter((n) => n < 1 || n > script.scenes.length))];
  if (absent.length) return { scope: "scenes", scenes: [], summary: "", edits: [], adCopy: null, problem: `There is no scene ${absent.join(", ")}: this script has ${script.scenes.length} scenes.` };
  const generate = deps.generate ?? defaultGenerate();
  const raw = modelSchema.parse(await generate(changePrompt(script, text, ctx)));
  const base: ChangePlan = { scope: raw.scope, scenes: raw.scenes, summary: raw.summary.trim(), edits: [], adCopy: null, problem: raw.problem.trim() || null };
  if (base.problem) return base;

  if (raw.scope === "concept") {
    if (!script.concept) return { ...base, scope: "scenes", problem: "This is your own script, so it has no generated idea to swap. Say which scenes or lines to change, or start a new video for a different idea." };
    return base;
  }
  const count = script.scenes.length;
  const missing = [...raw.scenes, ...raw.edits.map((e) => e.scene)].filter((n) => n < 1 || n > count);
  if (missing.length) return { ...base, edits: [], problem: `There is no scene ${[...new Set(missing)].join(", ")}: this script has ${count} scenes.` };

  // Only scenes the request is about are changed; for a voiceover change, that is every scene whose lines change.
  const allowed = raw.scope === "voiceover" ? null : new Set(raw.scenes);
  const edits: SceneEdit[] = raw.edits
    .filter((e) => !allowed || allowed.has(e.scene))
    .map((e) => ({
      scene: e.scene,
      lines: e.lines ? e.lines.filter((l) => l.text.trim()).map((l) => ({ voiceId: l.voice_id, text: l.text.trim(), onCamera: l.on_camera })) : null,
      // A voiceover change never changes the pictures.
      visual: raw.scope === "voiceover" ? null : e.visual?.trim() || null,
      camera: raw.scope === "voiceover" ? null : e.camera?.trim() || null,
      sound: raw.scope === "voiceover" ? null : e.sound?.trim() || null,
    }));
  const adCopy = raw.scope === "ad_copy" && raw.ad_copy ? raw.ad_copy : null;
  if (!edits.length && !adCopy) return { ...base, problem: "Nothing in the script would change for that request. Say a little more about what you want different." };
  return { ...base, edits, adCopy };
}

const joinLines = (lines: SceneLine[]) => lines.map((l) => l.text).filter(Boolean).join(" ");
const speakerOf = (lines: SceneLine[]): VideoScene["speaker"] => (!lines.length ? "none" : lines.some((l) => l.onCamera) ? "on_camera" : "voiceover");

/**
 * Apply a checked plan. Untouched scenes are kept exactly; changed scenes are retimed and split if
 * they now run past one clip. The script as it was is kept for undo (one level). Pure.
 */
export function applyChange(script: VideoScript, plan: ChangePlan): VideoScript {
  if (plan.problem) return script;
  const normal = normaliseVoices(script);
  const known = new Set((normal.voices ?? []).map((v) => v.id));
  const byScene = new Map(plan.edits.map((e) => [e.scene, e]));
  const scenes = normal.scenes.map((sc) => {
    const edit = byScene.get(sc.number);
    if (!edit) return sc;
    const own = sc.lines?.[0]?.voiceId ?? normal.voices![0]!.id;
    const lines = edit.lines ? edit.lines.slice(0, 2).map((l) => ({ ...l, voiceId: known.has(l.voiceId) ? l.voiceId : own })) : sc.lines!;
    return {
      ...sc,
      lines,
      line: joinLines(lines),
      speaker: speakerOf(lines),
      visual: edit.visual ?? sc.visual,
      camera: edit.camera ?? sc.camera,
      sound: edit.sound ?? sc.sound,
    };
  });
  const timed = retime(scenes);
  let next: VideoScript = {
    ...normal,
    scenes: timed,
    durationSeconds: timed.length ? timed[timed.length - 1]!.end : 0,
    adCopy: plan.adCopy ? { ...script.adCopy, ...plan.adCopy } : script.adCopy,
    changeNote: plan.summary || "Changed as you asked.",
  };
  next = splitLongScenes(next);
  // The recorded closing line is whatever is said last, as it now stands.
  const lastSpoken = [...next.scenes].reverse().find((sc) => sc.line.trim())?.line.trim();
  if (next.cta && lastSpoken && lastSpoken !== next.cta.spoken) next = { ...next, cta: { ...next.cta, spoken: lastSpoken } };
  if (next.speech) {
    const ctaWords = (next.cta?.spoken ?? "").trim().split(/\s+/).filter(Boolean).length;
    next = { ...next, speech: { ...buildScriptSpeech(next.scenes.map((s) => s.line).filter(Boolean), next.speech.requestedSeconds, next.speech.wordsPerSecond, { ctaWords }), measuredSeconds: next.speech.measuredSeconds ?? null } };
  }
  const before = { ...script };
  delete before.previousVersion;
  return { ...next, previousVersion: before };
}

/** The script as it was before the last change, or null when there is nothing to undo. */
export function undoChange(script: VideoScript): VideoScript | null {
  return script.previousVersion ?? null;
}
