import { generateObject } from "ai";
import { z } from "zod";
import { ADSPIRER_META_CTAS } from "@/lib/adspirer/skills/ad-copywriting";
import { pickModel } from "@/lib/creatives/concept-writer";
import { sceneSchema, type VideoScene, type VideoScript } from "@/lib/video/script";
import { sceneSeconds } from "@/lib/video/timing";
import { HUMAN_VOICE, SYSTEM } from "@/lib/video/voice";

const CTA_VALUES = ADSPIRER_META_CTAS as unknown as [string, ...string[]];

/** A scene is rewritten at the length it has; only its content changes. */
const rewrittenScene = sceneSchema.omit({ seconds: true });

export type RewriteContext = {
  facts: string;
  assetIds: string[];
  locale: string;
};

function describeScript(script: VideoScript): string {
  return [
    `Title: ${script.title}`,
    `Angle: ${script.angle.name} (${script.angle.stage}), targets: ${script.pain}`,
    `Framework: ${script.framework.name}. Style: ${script.style}.`,
    script.character ? `Presenter (identical in every scene): ${script.character}` : "No presenter on camera.",
    `Setting: ${script.setting}`,
    "Scenes:",
    ...script.scenes.map(
      (s) =>
        `${s.number}. [${s.start}-${s.end}s, ${s.seconds}s] sees: ${s.visual} | camera: ${s.camera} | ${s.speaker === "on_camera" ? "presenter says" : s.speaker === "voiceover" ? "voiceover says" : "no speech"}: "${s.line}"${s.keywords.length ? ` | highlight: ${s.keywords.join(", ")}` : ""}${s.stat ? ` | stat: ${s.stat}` : ""}${s.assetId ? ` | image: ${s.assetId}` : ""}`,
    ),
  ].join("\n");
}

/**
 * Rewrite one scene, keeping its length, its place in the story and the same presenter and setting,
 * to fix what the verifier found and/or what the operator asked for.
 */
export async function regenerateScene(input: { script: VideoScript; sceneNumber: number; feedback?: string | null; issues?: string[]; ctx: RewriteContext }): Promise<VideoScene> {
  const model = pickModel();
  if (!model) throw new Error("No language model is configured to rewrite scenes.");
  const { script, sceneNumber, ctx } = input;
  const scene = script.scenes.find((s) => s.number === sceneNumber);
  if (!scene) throw new Error(`Scene ${sceneNumber} does not exist.`);

  const { object } = await generateObject({
    model,
    schema: rewrittenScene,
    temperature: 0.8,
    system: SYSTEM,
    prompt: [
      ctx.facts,
      `\nTHE SCRIPT SO FAR\n${describeScript(script)}`,
      `\nRewrite ONLY scene ${sceneNumber} (now ${scene.seconds} seconds). It keeps its job in the story, flows from scene ${sceneNumber - 1 || "the start"} into scene ${sceneNumber + 1 > script.scenes.length ? "the end" : sceneNumber + 1}, and uses the same presenter and setting. Its length is not fixed: it runs as long as its spoken line takes to say, so write what the scene needs, in at most 35 words.`,
      input.issues?.length ? `Problems found in this scene that must be fixed:\n${input.issues.map((i) => `- ${i}`).join("\n")}` : null,
      input.feedback?.trim() ? `The operator's feedback (follow it, within the facts): ${input.feedback.trim()}` : null,
      "Facts only: a stat or number may appear only if it is in the facts above or on an uploaded image. Keep an uploaded image (asset_id) and its stat in this scene if the scene had them, unless the feedback says otherwise.",
      `Language: ${ctx.locale}.`,
      HUMAN_VOICE,
    ]
      .filter(Boolean)
      .join("\n"),
  });

  const next = {
    ...scene,
    visual: object.visual,
    camera: object.camera,
    speaker: object.speaker,
    line: object.line.trim(),
    keywords: object.keywords.map((k) => k.trim()).filter(Boolean),
    stat: object.stat?.trim() || null,
    assetId: object.asset_id && ctx.assetIds.includes(object.asset_id) ? object.asset_id : null,
    sound: object.sound,
  };
  // The new line sets the scene's length; the caller lays the script out again.
  const seconds = sceneSeconds(next);
  return { ...next, seconds, end: next.start + seconds };
}

const copySchema = z.object({
  primary_text: z.string().describe("70 to 130 words. Line 1: a standalone hook under 125 characters. Then 2 to 3 short paragraphs, then the next step in plain words."),
  headline: z.string().describe("Under 40 characters"),
  description: z.string().describe("Under 30 characters"),
  cta: z.enum(CTA_VALUES),
});

/** Rewrite the ad copy to fix what was found and/or what the operator asked for. */
export async function rewriteAdCopy(input: { script: VideoScript; feedback?: string | null; issues?: string[]; ctx: RewriteContext }): Promise<VideoScript["adCopy"]> {
  const model = pickModel();
  if (!model) throw new Error("No language model is configured to rewrite the ad copy.");
  const { script, ctx } = input;
  const { object } = await generateObject({
    model,
    schema: copySchema,
    temperature: 0.8,
    system: SYSTEM,
    prompt: [
      ctx.facts,
      `\nTHE SCRIPT THIS AD COPY GOES WITH\n${describeScript(script)}`,
      `\nCurrent ad copy:\nPrimary text:\n${script.adCopy.primaryText}\nHeadline: ${script.adCopy.headline}\nDescription: ${script.adCopy.description}\nCTA: ${script.adCopy.cta}`,
      input.issues?.length ? `Problems found that must be fixed:\n${input.issues.map((i) => `- ${i}`).join("\n")}` : null,
      input.feedback?.trim() ? `The operator's feedback (follow it, within the facts): ${input.feedback.trim()}` : null,
      "Write it like a short post from a person, not a brochure. The first line is a hook that stands alone. Facts only, no invented numbers. No dashes, no stock marketing words, no emoji unless the brand voice uses them.",
      `Language: ${ctx.locale}.`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  return { primaryText: object.primary_text, headline: object.headline, description: object.description, cta: object.cta };
}
