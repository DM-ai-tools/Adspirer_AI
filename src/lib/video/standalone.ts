import { generateObject } from "ai";
import { z } from "zod";
import { logger } from "@/lib/observability/logger";
import { acceptableStandalone, cutPointingPhrase, pointingPhrase } from "@/lib/video/clean-mode";
import { modelCandidates, withModelFallback } from "@/lib/video/model-fallback";
import type { VideoScript } from "@/lib/video/script";

/**
 * A clean video shows no screenshot, so a spoken line that points at one ("as you can see here",
 * "in the results shown here") would refer to nothing. Such a line is reworded so the video makes
 * sense on its own, keeping its meaning and every figure. The image stays available as an optional
 * addition; if the operator adds it by hand the reworded line still reads naturally.
 */

export type NarrationChange = { scene: number; was: string; now: string; reason: string };

export type Reword = (line: string, phrase: string) => Promise<string | null>;

const rewordSchema = z.object({ line: z.string().describe("The reworded spoken line") });

/** Ask a language model for the reworded line. Null when none is configured or the call fails. */
export const rewordWithModel: Reword = async (line, phrase) => {
  const candidates = modelCandidates();
  if (!candidates.length) return null;
  try {
    const result = await withModelFallback(
      async (model) =>
        (
          await generateObject({
            model,
            schema: rewordSchema,
            temperature: 0.2,
            prompt: [
              "This is one spoken line from a video ad. The video will show NO image, screenshot, chart or text on screen while it is said, so the words must make complete sense on their own.",
              `The line: "${line}"`,
              `The part that points at something on screen: "${phrase}"`,
              "Reword the line so it no longer points at anything on screen. Keep the meaning, the tone, the speaker's voice and roughly the same length. Keep every number exactly as written and say what each one measures exactly as the line does. Do not add any fact, figure, claim or call to action. Return only the reworded line.",
            ].join("\n"),
          })
        ).object,
      candidates,
    );
    return result.line.trim();
  } catch (error) {
    logger.warn("A spoken line could not be reworded by the model", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
};

export type StandaloneResult = {
  script: VideoScript;
  changes: NarrationChange[];
  /** Lines that still point at the screen because no acceptable rewording was found: the operator rewords these. */
  unresolved: Array<{ scene: number; line: string; phrase: string }>;
};

/**
 * Reword every spoken line that points at the screen. A rewording is used only when it stops
 * pointing, keeps every figure and stays about the same length; otherwise the pointing words are
 * simply cut where that leaves a sound sentence; otherwise the line is reported and left alone.
 */
export async function makeNarrationStandalone(script: VideoScript, deps: { reword?: Reword } = {}): Promise<StandaloneResult> {
  const reword = deps.reword ?? rewordWithModel;
  const changes: NarrationChange[] = [];
  const unresolved: StandaloneResult["unresolved"] = [];
  const scenes = [];
  for (const scene of script.scenes) {
    const phrase = scene.line ? pointingPhrase(scene.line) : null;
    if (!phrase) {
      scenes.push(scene);
      continue;
    }
    const proposed = await reword(scene.line, phrase).catch(() => null);
    const now = proposed && acceptableStandalone(scene.line, proposed) ? proposed.trim() : cutPointingPhrase(scene.line);
    if (!now) {
      unresolved.push({ scene: scene.number, line: scene.line, phrase });
      scenes.push(scene);
      continue;
    }
    changes.push({ scene: scene.number, was: scene.line, now, reason: `"${phrase}" pointed at an image, and a clean video shows none.` });
    scenes.push({ ...scene, line: now, originalLine: scene.originalLine ?? scene.line });
  }
  return { script: changes.length ? { ...script, scenes } : script, changes, unresolved };
}
