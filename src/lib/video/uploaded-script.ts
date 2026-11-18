import { generateObject } from "ai";
import { z } from "zod";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import { pickModel } from "@/lib/creatives/concept-writer";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import { withModelFallback, modelCandidates } from "@/lib/video/model-fallback";
import { structureByRules, type Structured } from "@/lib/video/script-by-rules";
import { logger } from "@/lib/observability/logger";
import { rewriteAdCopy } from "@/lib/video/rewrite";
import { restoreVerbatim, unusedText, verbatimCheck } from "@/lib/video/verbatim";
import { restoreMissingSpeech, spokenBlocks } from "@/lib/video/spoken-blocks";
import { MAX_SCENE_SECONDS, retime, wordsFor } from "@/lib/video/timing";
import { HUMAN_VOICE } from "@/lib/video/voice";
import { VISUAL_DIRECTION_RULES } from "@/lib/video/visual-rules";

const CTA_VALUES = ADSPIRER_META_CTAS as unknown as [string, ...string[]];

export const MIN_SCRIPT_WORDS = 15;

const STRUCTURE_SYSTEM =
  "You turn a video ad script that someone else wrote into a shot-by-shot plan. You are a careful editor, not a writer: the spoken words belong to the author and you never change them. You copy every spoken line exactly, character for character, with the author's spelling, punctuation and wording, even where you would have written it differently. You only decide where one scene ends and the next begins, and you add what the script does not say: a visual, a camera, sound.";

/**
 * What the reader asks the model for. It carries no size limits on purpose: a script has as many scenes as it has
 * spoken lines, and a reply that is right but longer than a limit used to be thrown away with "response did not
 * match schema". The limits live in `normaliseStructured`, which puts a reply right instead of rejecting it.
 */
const structureSchema = z.object({
  title: z.string().describe("A short working title taken from the script's own title or first idea"),
  angle_name: z.string().describe("The script's angle or idea, in a few words of your own"),
  pain: z.string().describe("The pain, hope or objection the script targets, in one sentence"),
  structure: z.string().describe("The structure or format it follows, in a few words of your own (e.g. 'mini movie trailer', 'problem then demo')"),
  style: z.string().describe("The look the script implies (UGC creator, cinematic, motion graphics, documentary...). Use its own direction if it gives one."),
  character: z.string().nullable().describe("Everyone who appears on camera, each with one precise description (age range, build, hair, wardrobe, manner) and the name the script gives them. Use the script's descriptions if it has them; otherwise propose fitting ones. null when nobody appears."),
  setting: z.string().describe("Where it takes place and the light. Use the script's own description if it has one; otherwise propose one that fits."),
  hook_alternatives: z.array(z.string()).describe("Three alternative openings for the first 2 seconds. Suggestions only; the script's own opening is kept as written."),
  scenes: z
    .array(
      z.object({
        line: z.string().describe("The exact words spoken in this scene, copied from the script character for character. Empty if nobody speaks. Never paraphrase, correct, shorten or add words. No speaker name, no stage direction."),
        speaker: z.string().describe('One of "on_camera" (a person shown speaking), "voiceover" (an unseen voice) or "none" (no speech)'),
        visual: z.string().describe("What is seen. Use the script's own visual direction for this beat if it has one; otherwise propose something concrete that fits what is said. When more than one person speaks, begin with who says this line, using the script's own name for them."),
        camera: z.string(),
        keywords: z.array(z.string()).describe("0 to 3 words that appear in the line, to highlight on screen"),
        stat: z.string().nullable().describe("A number to show big, only if the script states it (copied as written) or it is in the facts; else null"),
        asset_id: z.string().nullable(),
        sound: z.string(),
        seconds: z.number().describe("Only for a scene with no speech: how long the picture holds, 2 to 6"),
      }),
    ),
});

type RawStructured = z.infer<typeof structureSchema>;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v == null ? fallback : String(v));

/** Put a model reply in the shape the rest of the system needs. A reply that is a little off is put right, never refused. */
export function normaliseStructured(raw: Partial<RawStructured> | Record<string, unknown>): Structured {
  const r = raw as Record<string, unknown>;
  const scenes = (Array.isArray(r.scenes) ? r.scenes : [])
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object")
    .map((x) => {
      const line = str(x.line).trim();
      const said = str(x.speaker).toLowerCase().replace(/[\s-]+/g, "_");
      const speaker: Structured["scenes"][number]["speaker"] = !line ? "none" : /^(voice_?over|vo|v\.o\.|narrat|announcer|off_?screen)/.test(said) ? "voiceover" : "on_camera";
      const seconds = Number(x.seconds);
      return {
        line,
        speaker,
        visual: str(x.visual),
        camera: str(x.camera),
        keywords: (Array.isArray(x.keywords) ? x.keywords : []).map((k) => str(k).trim()).filter(Boolean).slice(0, 3),
        stat: typeof x.stat === "string" && x.stat.trim() ? x.stat.trim() : null,
        asset_id: typeof x.asset_id === "string" && x.asset_id.trim() ? x.asset_id.trim() : null,
        sound: str(x.sound),
        seconds: Number.isFinite(seconds) ? Math.min(12, Math.max(2, Math.round(seconds))) : 3,
      };
    });
  const title = str(r.title, "Your script").trim() || "Your script";
  const hooks = (Array.isArray(r.hook_alternatives) ? r.hook_alternatives : []).map((h) => str(h).trim()).filter(Boolean).slice(0, 3);
  const fillers = [...scenes.map((s) => s.visual).filter(Boolean), title];
  for (let i = 0; hooks.length < 3; i += 1) hooks.push(fillers[i % fillers.length]!);
  return {
    title,
    angle_name: str(r.angle_name, title),
    pain: str(r.pain),
    structure: str(r.structure),
    style: str(r.style),
    character: typeof r.character === "string" && r.character.trim() ? r.character.trim() : null,
    setting: str(r.setting),
    hook_alternatives: hooks,
    scenes,
  };
}

/** Whether a failure is the model's reply not fitting the schema (as opposed to it being unreachable). */
function isSchemaError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  return e?.name === "AI_NoObjectGeneratedError" || /did not match schema|no object generated|validation failed|could not parse/i.test(e?.message ?? "");
}

/** What was wrong with a reply, in a line the model can act on. */
function schemaProblem(error: unknown): string {
  const e = error as { cause?: { message?: string }; message?: string } | null;
  const detail = String(e?.cause?.message ?? e?.message ?? "");
  const tail = /Error message:\s*([\s\S]*)$/.exec(detail)?.[1] ?? detail;
  return tail.replace(/\s+/g, " ").trim().slice(0, 500) || "the reply did not fit the required shape";
}


/** How many words a scene may carry: no scene may run longer than one clip. */
const MAX_WORDS_PER_SCENE = wordsFor(MAX_SCENE_SECONDS);

const changeSchema = z.object({
  understood: z.string().describe("One sentence: what the operator asked to change"),
  scene_changes: z
    .array(
      z.object({
        scene: z.number(),
        line: z.string().nullish().describe("The new spoken line, only if the request is about the words of this scene. null to keep it exactly."),
        visual: z.string().nullish(),
        camera: z.string().nullish(),
        keywords: z.array(z.string()).nullish(),
        stat: z.string().nullish(),
        sound: z.string().nullish(),
      }),
    ),
  ad_copy: z
    .object({ primary_text: z.string().nullish(), headline: z.string().nullish(), description: z.string().nullish(), cta: z.string().nullish().describe(`One of: ${CTA_VALUES.join(", ")}`) })
    .nullish()
    .describe("Only if the request is about the ad copy"),
});

export type UploadedContext = { facts: string; assetIds: string[]; locale: string; model: NonNullable<ReturnType<typeof pickModel>>; direction?: string | null };

function sceneFrom(raw: Structured["scenes"][number], number: number, line: string, assetIds: string[]): Omit<VideoScene, "start" | "end"> {
  return {
    number,
    seconds: raw.seconds,
    visual: raw.visual,
    camera: raw.camera,
    speaker: line ? raw.speaker : "none",
    line,
    keywords: raw.keywords.map((k) => k.trim()).filter((k) => k && line.toLowerCase().includes(k.toLowerCase())),
    stat: raw.stat?.trim() || null,
    assetId: raw.asset_id && assetIds.includes(raw.asset_id) ? raw.asset_id : null,
    sound: raw.sound,
  };
}

/**
 * Ask the model for an object and never give up on the first reply that does not fit. A reply that fails the schema is
 * asked for again once, naming what was wrong; the next provider is tried when the first is unavailable.
 */
async function askLenient<S extends z.ZodType>(ctx: UploadedContext, schema: S, args: { system: string; prompt: string; temperature?: number; maxOutputTokens?: number }): Promise<z.infer<S>> {
  const candidates = [ctx.model, ...modelCandidates().slice(1)];
  let problem: string | null = null;
  for (let attempt = 0; ; attempt += 1) {
    const prompt = problem ? `${args.prompt}\n\nYour last answer was rejected because it did not fit the required shape (${problem}). Fix that and answer again in the required shape, keeping every scene, every field and every word.` : args.prompt;
    try {
      return await withModelFallback(async (model) => (await generateObject({ model, schema, temperature: args.temperature ?? 0, maxOutputTokens: args.maxOutputTokens, system: args.system, prompt })).object as z.infer<S>, candidates);
    } catch (error) {
      if (!isSchemaError(error) || attempt >= 1) throw error;
      problem = schemaProblem(error);
    }
  }
}

/**
 * Turn the operator's script into scenes without touching their words. The model splits and adds
 * visuals; every spoken line is then checked against the original and any that drifted are put back
 * exactly as written.
 */
export async function structureUploadedScript(
  scriptText: string,
  ctx: UploadedContext,
  onFeedback?: string,
): Promise<{ structured: Structured; lines: string[]; restoredScenes: number[]; removedScenes: number[]; addedScenes: number[]; unused: string[]; usedRules: boolean }> {
  // The spoken parts the script labels itself ("VO:", "Presenter:"): every one must end up in a scene.
  const labelled = spokenBlocks(scriptText);
  const call = async (feedback?: string): Promise<Structured> => {
    const prompt = [
      "THE OPERATOR'S SCRIPT (their words; never change them):",
      "<<<",
      scriptText,
      ">>>",
      "\nFACTS ABOUT THE BUSINESS (for visuals and context only, never to change the script):\n" + ctx.facts,
      `\nSplit the script into scenes at its natural beats (a sentence or a clause end), so each scene is one idea and at most about ${MAX_WORDS_PER_SCENE} words of speech. There is no limit on how many scenes there are: one scene for each spoken line or exchange is right, so a script with twenty lines has twenty scenes. Anything that is not meant to be said aloud (scene headings, camera or editor notes, speaker labels such as "VO:", "Presenter:" or "Dialogue — Founder:", timings) is a direction: use it for the visual, camera, speaker and sound, and do not put it in a spoken line. Copy every spoken word exactly, in order, losing none and adding none. If the script gives a presenter, characters or a setting, use its description.`,
      labelled.length
        ? `This script labels ${labelled.length} spoken part${labelled.length === 1 ? "" : "s"}. Every one of them must be spoken in full, in this order, none left out or merged away (split a long one into two scenes at a sentence end if you need to):\n${labelled.map((b, i) => `${i + 1}. ${b.name ? `${b.name}: ` : ""}${b.text}`).join("\n")}`
        : null,
      `Anything the script says is printed on screen ("Text Overlay", "On screen", "Super") is not spoken: keep it out of the spoken lines. If it is, or contains, a number or figure, use that figure exactly as written as the scene's stat; otherwise pick its key words (from the spoken line) to highlight.`,
      `Where the script names an uploaded image or asset ("Uploaded Asset Placeholder", "[PLACEHOLDER: name]"), give that scene the id of the uploaded image with that name from the facts (match by name). A logo is not an image to show in a scene: leave asset_id null for it.`,
      `Speaker: on_camera when a person is shown speaking, voiceover when the words are an unseen voice, none for a beat with no speech. When more than one person speaks, the picture of each scene begins with who says its line (the script's own name or role for them), so it is always clear who is talking and who is in frame.`,
      `Language: ${ctx.locale}. Where you write a visual, camera or sound, make it concrete and filmable.`,
      ctx.direction
        ? `THE KIND OF VIDEO THE OPERATOR ASKED FOR (design every visual, camera, speaker and the style to fit it; the spoken words still never change, and the script's own visual directions still win where it gives them):\n${ctx.direction}`
        : null,
      `Where the script gives its own visual direction, keep it as written. Where you propose a visual yourself:\n${VISUAL_DIRECTION_RULES}`,
      feedback ? `\nYour previous attempt changed the operator's words in these places: ${feedback}. Copy those lines exactly as they are in the script.` : null,
    ]
      .filter(Boolean)
      .join("\n");
    const out = normaliseStructured(await askLenient(ctx, structureSchema, { system: STRUCTURE_SYSTEM, prompt, maxOutputTokens: 16000 }));
    if (!out.scenes.length) throw new Error("The reply had no scenes.");
    return out;
  };

  let structured: Structured;
  let usedRules = false;
  try {
    structured = await call(onFeedback);
  } catch (error) {
    // The model could not give a usable answer: whatever was typed is still read, by the script's own labels, and nothing fails.
    logger.warn("The language model could not read the uploaded script; it was split by rules instead", { error: error instanceof Error ? error.message : String(error) });
    structured = structureByRules(scriptText);
    usedRules = true;
  }
  let check = verbatimCheck(scriptText, structured.scenes.map((s) => s.line));
  if (!check.ok && !usedRules) {
    // One more try, naming what drifted; whatever still differs is then put back from the original.
    const drifted = check.altered.map((i) => `scene ${i + 1}: "${structured.scenes[i]!.line.slice(0, 80)}"`).join("; ");
    try {
      structured = await call(drifted);
      check = verbatimCheck(scriptText, structured.scenes.map((s) => s.line));
    } catch {
      // keep the first attempt
    }
  }
  const restore = restoreVerbatim(scriptText, structured.scenes.map((s) => s.line));
  // A line with nothing like it in the script was invented: it is removed rather than kept.
  const removedIdx: number[] = [];
  const kept = restore.lines.map((line, i) => {
    if (line.trim() && !restore.spans[i]) {
      removedIdx.push(i);
      return "";
    }
    return line;
  });
  // A spoken part the script labels that no scene carries was skipped by the analysis: put it back where it belongs.
  const repaired = restoreMissingSpeech(scriptText, structured.scenes, kept, restore.spans);
  structured = { ...structured, scenes: repaired.scenes };
  const renumber = (idx: number[]) => idx.map((old) => repaired.from.indexOf(old) + 1).filter((n) => n > 0);
  return {
    structured,
    lines: repaired.lines,
    restoredScenes: renumber(restore.restored),
    removedScenes: renumber(removedIdx),
    addedScenes: repaired.added,
    unused: unusedText(scriptText, repaired.spans),
    usedRules,
  };
}

/** Pair the operator's ad copy (kept exactly) with the headline, description and button it did not include. */
export async function adCopyForUploaded(input: {
  script: VideoScript;
  provided: string | null;
  ctx: UploadedContext;
}): Promise<VideoScript["adCopy"]> {
  const rewriteCtx = { facts: input.ctx.facts, assetIds: input.ctx.assetIds, locale: input.ctx.locale };
  let generated: VideoScript["adCopy"];
  try {
    generated = await rewriteAdCopy({
      script: input.script,
      ctx: rewriteCtx,
      feedback: input.provided ? "The operator already wrote the primary text; write only a headline (under 40 characters), a description (under 30) and the best call-to-action button for it. Keep the primary text exactly as given." : undefined,
    });
  } catch (error) {
    // The ad copy is a side product of the script; if it cannot be written the script still stands, with simple copy the operator can edit.
    logger.warn("Ad copy for an uploaded script could not be written", { error: error instanceof Error ? error.message : String(error) });
    const spoken = input.script.scenes.map((s) => s.line).filter(Boolean).join(" ");
    generated = { primaryText: spoken.slice(0, 500), headline: input.script.title.slice(0, 40), description: input.script.angle.name.slice(0, 30), cta: "Learn More" };
  }
  if (!input.provided) return generated;
  // The operator's primary text is theirs: it is used exactly, whatever the model wrote.
  return { ...generated, primaryText: input.provided.trim() };
}

/**
 * Apply only the changes the operator asked for. The model names the scenes and fields the request
 * touches and gives their new content; every other word stays exactly as it was. What changed is
 * recorded, with the original line kept so it can be put back.
 */
export async function applyChangeRequest(script: VideoScript, request: string, ctx: UploadedContext): Promise<VideoScript> {
  const object = await askLenient(ctx, changeSchema, {
    system: "You make exactly the changes an operator asks for to their video ad script, and nothing else. Anything the request does not mention is left exactly as it is: you return null for it.",
    maxOutputTokens: 16000,
    prompt: [
      "THE SCRIPT",
      ...script.scenes.map((s) => `Scene ${s.number}: sees: ${s.visual} | camera: ${s.camera} | says: "${s.line}"${s.keywords.length ? ` | highlight: ${s.keywords.join(", ")}` : ""}${s.stat ? ` | stat: ${s.stat}` : ""} | sound: ${s.sound}`),
      `Ad copy primary text:\n${script.adCopy.primaryText}\nHeadline: ${script.adCopy.headline} | Description: ${script.adCopy.description} | CTA: ${script.adCopy.cta}`,
      `\nTHE OPERATOR'S REQUEST: ${request}`,
      "\nReturn only the scenes and fields this request touches. Change spoken words only where the request is about the words; follow the request literally and change nothing else. Facts only for any number you add:\n" + ctx.facts,
      HUMAN_VOICE,
    ].join("\n"),
  });

  const changes: Array<{ target: string; was: string; now: string }> = [...(script.handling?.changes ?? [])];
  const scenes = script.scenes.map((s) => {
    const c = object.scene_changes.find((x) => Math.round(Number(x.scene)) === s.number);
    if (!c) return s;
    const next = { ...s };
    if (typeof c.line === "string" && c.line.trim() && c.line.trim() !== s.line) {
      changes.push({ target: `Scene ${s.number} words`, was: s.line, now: c.line.trim() });
      next.originalLine = s.originalLine ?? s.line;
      next.line = c.line.trim();
    }
    if (c.visual) next.visual = c.visual;
    if (c.camera) next.camera = c.camera;
    if (c.keywords) next.keywords = c.keywords.map((k) => k.trim()).filter(Boolean).slice(0, 3);
    if (typeof c.stat === "string") next.stat = c.stat.trim() || null;
    if (c.sound) next.sound = c.sound;
    return next;
  });

  let adCopy = script.adCopy;
  const ac = object.ad_copy;
  if (ac) {
    const was = adCopy.primaryText;
    adCopy = {
      primaryText: ac.primary_text?.trim() || adCopy.primaryText,
      headline: ac.headline?.trim() || adCopy.headline,
      description: ac.description?.trim() || adCopy.description,
      // A button the model names that is not one of the platform's is ignored rather than failing the change.
      cta: (CTA_VALUES.find((c) => c.toLowerCase() === (ac.cta ?? "").trim().toLowerCase()) as VideoScript["adCopy"]["cta"] | undefined) ?? adCopy.cta,
    };
    if (adCopy.primaryText !== was) changes.push({ target: "Ad copy", was, now: adCopy.primaryText });
  }
  return { ...script, scenes: retime(scenes), durationSeconds: retime(scenes).at(-1)?.end ?? script.durationSeconds, adCopy, handling: { restoredScenes: script.handling?.restoredScenes ?? [], removedScenes: script.handling?.removedScenes ?? [], addedScenes: script.handling?.addedScenes ?? [], unusedText: script.handling?.unusedText ?? [], changes } };
}

/** Build the VideoScript from the structured result (the operator's words, with visuals added). */
export function assembleUploaded(input: { structured: Structured; lines: string[]; restoredScenes: number[]; removedScenes: number[]; addedScenes?: number[]; unused: string[]; assetIds: string[]; warnings?: string[] }): VideoScript {
  const { structured } = input;
  const kept = structured.scenes.map((s, i) => ({ raw: s, line: input.lines[i]!.trim() }));
  const scenes = retime(kept.map((k, i) => sceneFrom(k.raw, i + 1, k.line, input.assetIds)));
  return {
    id: "script_uploaded",
    title: structured.title,
    angle: { key: "uploaded", name: structured.angle_name.trim(), stage: "", kind: "custom" },
    pain: structured.pain,
    framework: { key: "custom", name: structured.structure.trim() || "Your own structure" },
    style: structured.style,
    durationSeconds: scenes.length ? scenes[scenes.length - 1]!.end : 0,
    hookAlternatives: structured.hook_alternatives,
    character: structured.character?.trim() || null,
    setting: structured.setting,
    scenes,
    adCopy: { primaryText: "", headline: "", description: "", cta: "Learn More" },
    warnings: input.warnings ?? [],
    source: "uploaded",
    handling: { restoredScenes: input.restoredScenes, removedScenes: input.removedScenes, addedScenes: input.addedScenes ?? [], unusedText: input.unused, changes: [] },
  };
}

export function scriptWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
