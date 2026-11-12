import { generateObject } from "ai";
import { z } from "zod";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import { pickModel } from "@/lib/creatives/concept-writer";
import { BULK_ANGLES, STAGE_LABEL } from "@/lib/creatives/bulk/angles";
import { FRAMEWORKS, sceneSchema, type VideoScene, type VideoScript } from "@/lib/video/script";
import { rewriteAdCopy } from "@/lib/video/rewrite";
import { restoreVerbatim, unusedText, verbatimCheck } from "@/lib/video/verbatim";
import { restoreMissingSpeech, spokenBlocks } from "@/lib/video/spoken-blocks";
import { retime } from "@/lib/video/timing";
import { HUMAN_VOICE } from "@/lib/video/voice";
import { VISUAL_DIRECTION_RULES } from "@/lib/video/visual-rules";

const CTA_VALUES = ADSPIRER_META_CTAS as unknown as [string, ...string[]];
const ANGLE_KEYS = BULK_ANGLES.map((a) => a.key) as [string, ...string[]];
const FRAMEWORK_KEYS = [...FRAMEWORKS.map((f) => f.key), "custom"] as unknown as [string, ...string[]];

export const MIN_SCRIPT_WORDS = 15;

const STRUCTURE_SYSTEM =
  "You turn a video ad script that someone else wrote into a shot-by-shot plan. You are a careful editor, not a writer: the spoken words belong to the author and you never change them. You copy every spoken line exactly, character for character, with the author's spelling, punctuation and wording, even where you would have written it differently. You only decide where one scene ends and the next begins, and you add what the script does not say: a visual, a camera, sound.";

const structureSchema = z.object({
  title: z.string().describe("A short working title taken from the script's own title or first idea"),
  angle_key: z.enum(ANGLE_KEYS).describe("The advertising angle this script is closest to"),
  pain: z.string().describe("The pain, hope or objection the script targets, in one sentence"),
  framework_key: z.enum(FRAMEWORK_KEYS).describe("The structure it follows, or custom"),
  style: z.string().describe("The look the script implies (UGC creator, cinematic, motion graphics, documentary...). Use its own direction if it gives one."),
  character: z.string().nullable().describe("If a person speaks on camera: one precise description (age range, build, hair, wardrobe, manner). Use the script's description if it has one; otherwise propose a fitting one. null when nobody appears."),
  setting: z.string().describe("Where it takes place and the light. Use the script's own description if it has one; otherwise propose one that fits."),
  hook_alternatives: z.array(z.string()).length(3).describe("Three alternative openings for the first 2 seconds. Suggestions only; the script's own opening is kept as written."),
  scenes: z
    .array(
      z.object({
        line: z.string().describe("The exact words spoken in this scene, copied from the script character for character. Empty if nobody speaks. Never paraphrase, correct, shorten or add words."),
        speaker: sceneSchema.shape.speaker,
        visual: z.string().describe("What is seen. Use the script's own visual direction for this beat if it has one; otherwise propose something concrete that fits what is said."),
        camera: z.string(),
        keywords: z.array(z.string()).max(3).describe("0-3 words that appear in the line, to highlight on screen"),
        stat: z.string().nullable().describe("A number to show big, only if the script states it (copied as written) or it is in the facts; else null"),
        asset_id: z.string().nullable(),
        sound: z.string(),
        seconds: sceneSchema.shape.seconds,
      }),
    )
    .min(2)
    .max(16),
});

type Structured = z.infer<typeof structureSchema>;

/** How many words a scene may carry, so each scene is a beat and not a paragraph. */
const MAX_WORDS_PER_SCENE = 40;

const changeSchema = z.object({
  understood: z.string().describe("One sentence: what the operator asked to change"),
  scene_changes: z
    .array(
      z.object({
        scene: z.number().int(),
        line: z.string().nullable().describe("The new spoken line, only if the request is about the words of this scene. null to keep it exactly."),
        visual: z.string().nullable(),
        camera: z.string().nullable(),
        keywords: z.array(z.string()).nullable(),
        stat: z.string().nullable(),
        sound: z.string().nullable(),
      }),
    )
    .max(16),
  ad_copy: z
    .object({ primary_text: z.string().nullable(), headline: z.string().nullable(), description: z.string().nullable(), cta: z.enum(CTA_VALUES).nullable() })
    .nullable()
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
 * Turn the operator's script into scenes without touching their words. The model splits and adds
 * visuals; every spoken line is then checked against the original and any that drifted are put back
 * exactly as written.
 */
export async function structureUploadedScript(
  scriptText: string,
  ctx: UploadedContext,
  onFeedback?: string,
): Promise<{ structured: Structured; lines: string[]; restoredScenes: number[]; removedScenes: number[]; addedScenes: number[]; unused: string[] }> {
  // The spoken parts the script labels itself ("VO:", "Presenter:"): every one must end up in a scene.
  const labelled = spokenBlocks(scriptText);
  const call = async (feedback?: string) => {
    const { object } = await generateObject({
      model: ctx.model,
      schema: structureSchema,
      temperature: 0,
      system: STRUCTURE_SYSTEM,
      prompt: [
        "THE OPERATOR'S SCRIPT (their words; never change them):",
        "<<<",
        scriptText,
        ">>>",
        "\nFACTS ABOUT THE BUSINESS (for visuals and context only, never to change the script):\n" + ctx.facts,
        `\nSplit the script into scenes at its natural beats (a sentence or a clause end), so each scene is one idea and at most about ${MAX_WORDS_PER_SCENE} words of speech. Anything that is not meant to be said aloud (scene headings, camera or editor notes, speaker labels such as "VO:" or "Presenter:", timings) is a direction: use it for the visual, camera, speaker and sound, and do not put it in a spoken line. Copy every spoken word exactly, in order, losing none and adding none. If the script gives a presenter or a setting, use its description.`,
        labelled.length
          ? `This script labels ${labelled.length} spoken part${labelled.length === 1 ? "" : "s"}. Every one of them must be spoken in full, in this order, none left out or merged away (split a long one into two scenes at a sentence end if you need to):\n${labelled.map((b, i) => `${i + 1}. ${b.text}`).join("\n")}`
          : null,
        `Anything the script says is printed on screen ("Text Overlay", "On screen", "Super") is not spoken: keep it out of the spoken lines. If it is, or contains, a number or figure, use that figure exactly as written as the scene's stat; otherwise pick its key words (from the spoken line) to highlight.`,
        `Where the script names an uploaded image or asset ("Uploaded Asset Placeholder", "[PLACEHOLDER: name]"), give that scene the id of the uploaded image with that name from the facts (match by name). A logo is not an image to show in a scene: leave asset_id null for it.`,
        `Speaker: on_camera when a person is shown speaking to camera, voiceover when the words are an unseen voice, none for a beat with no speech.`,
        `Language: ${ctx.locale}. Where you write a visual, camera or sound, make it concrete and filmable.`,
        ctx.direction
          ? `THE KIND OF VIDEO THE OPERATOR ASKED FOR (design every visual, camera, speaker and the style to fit it; the spoken words still never change, and the script's own visual directions still win where it gives them):\n${ctx.direction}`
          : null,
        `Where the script gives its own visual direction, keep it as written. Where you propose a visual yourself:\n${VISUAL_DIRECTION_RULES}`,
        feedback ? `\nYour previous attempt changed the operator's words in these places: ${feedback}. Copy those lines exactly as they are in the script.` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    return object;
  };

  let structured = await call(onFeedback);
  let check = verbatimCheck(scriptText, structured.scenes.map((s) => s.line));
  if (!check.ok) {
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
  };
}

/** Pair the operator's ad copy (kept exactly) with the headline, description and button it did not include. */
export async function adCopyForUploaded(input: {
  script: VideoScript;
  provided: string | null;
  ctx: UploadedContext;
}): Promise<VideoScript["adCopy"]> {
  const rewriteCtx = { facts: input.ctx.facts, assetIds: input.ctx.assetIds, locale: input.ctx.locale };
  const generated = await rewriteAdCopy({
    script: input.script,
    ctx: rewriteCtx,
    feedback: input.provided ? "The operator already wrote the primary text; write only a headline (under 40 characters), a description (under 30) and the best call-to-action button for it. Keep the primary text exactly as given." : undefined,
  });
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
  const { object } = await generateObject({
    model: ctx.model,
    schema: changeSchema,
    temperature: 0,
    system: "You make exactly the changes an operator asks for to their video ad script, and nothing else. Anything the request does not mention is left exactly as it is: you return null for it.",
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
    const c = object.scene_changes.find((x) => x.scene === s.number);
    if (!c) return s;
    const next = { ...s };
    if (c.line !== null && c.line.trim() && c.line.trim() !== s.line) {
      changes.push({ target: `Scene ${s.number} words`, was: s.line, now: c.line.trim() });
      next.originalLine = s.originalLine ?? s.line;
      next.line = c.line.trim();
    }
    if (c.visual) next.visual = c.visual;
    if (c.camera) next.camera = c.camera;
    if (c.keywords) next.keywords = c.keywords;
    if (c.stat !== null) next.stat = c.stat.trim() || null;
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
      cta: ac.cta ?? adCopy.cta,
    };
    if (adCopy.primaryText !== was) changes.push({ target: "Ad copy", was, now: adCopy.primaryText });
  }
  return { ...script, scenes: retime(scenes), durationSeconds: retime(scenes).at(-1)?.end ?? script.durationSeconds, adCopy, handling: { restoredScenes: script.handling?.restoredScenes ?? [], removedScenes: script.handling?.removedScenes ?? [], addedScenes: script.handling?.addedScenes ?? [], unusedText: script.handling?.unusedText ?? [], changes } };
}

/** Build the VideoScript from the structured result (the operator's words, with visuals added). */
export function assembleUploaded(input: { structured: Structured; lines: string[]; restoredScenes: number[]; removedScenes: number[]; addedScenes?: number[]; unused: string[]; assetIds: string[] }): VideoScript {
  const { structured } = input;
  const angle = BULK_ANGLES.find((a) => a.key === structured.angle_key) ?? BULK_ANGLES[0]!;
  const framework = FRAMEWORKS.find((f) => f.key === structured.framework_key);
  const kept = structured.scenes.map((s, i) => ({ raw: s, line: input.lines[i]!.trim() }));
  const scenes = retime(kept.map((k, i) => sceneFrom(k.raw, i + 1, k.line, input.assetIds)));
  return {
    id: "script_uploaded",
    title: structured.title,
    angle: { key: angle.key, name: angle.name, stage: STAGE_LABEL[angle.stage], kind: angle.kind },
    pain: structured.pain,
    framework: { key: framework?.key ?? "custom", name: framework?.name ?? "Your own structure" },
    style: structured.style,
    durationSeconds: scenes.length ? scenes[scenes.length - 1]!.end : 0,
    hookAlternatives: structured.hook_alternatives,
    character: structured.character?.trim() || null,
    setting: structured.setting,
    scenes,
    adCopy: { primaryText: "", headline: "", description: "", cta: "Learn More" },
    warnings: [],
    source: "uploaded",
    handling: { restoredScenes: input.restoredScenes, removedScenes: input.removedScenes, addedScenes: input.addedScenes ?? [], unusedText: input.unused, changes: [] },
  };
}

export function scriptWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
