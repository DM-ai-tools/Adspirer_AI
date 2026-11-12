import { sceneSeconds } from "@/lib/video/timing";
import { availableSeedanceModels, chooseSeedanceModel, estimateClipUsd, SEEDANCE_SPECS, type VideoRatio, type VideoResolution } from "@/lib/video/seedance";
import type { VideoScript } from "@/lib/video/script";
import type { VideoInputs } from "@/lib/video/projects";

/** Seedance has no 4:5; 3:4 is the nearest and is cropped to 4:5 afterwards. */
export function generationRatio(format: VideoInputs["format"]): VideoRatio {
  return format === "4:5" ? "3:4" : format;
}

export type PlanPreview = {
  model: string;
  modelLabel: string;
  reasons: string[];
  resolution: VideoResolution;
  clips: Array<{ number: number; seconds: number; sceneNumbers: number[] }>;
  totalSeconds: number;
  /** Estimated from the documented token formula; the bill follows actual usage. */
  estimatedUsd: number;
  /** The same ad at 1080p, for comparison. */
  estimatedUsd1080: number | null;
};

/** The model, clip split and cost for a script, shown before any video is generated. */
export function previewPlan(script: VideoScript, inputs: Pick<VideoInputs, "format" | "priority">, uploadedImages: number): PlanPreview {
  // Character sheet, location and each uploaded image can all ride along as references.
  const request = {
    // Each scene at least as long as its words take to say: the plan will lengthen it, so the model and the clips must allow for that now.
    scenes: script.scenes.map((s) => ({ number: s.number, seconds: Math.max(s.seconds, sceneSeconds(s)), onCameraSpeech: s.speaker === "on_camera" })),
    imageRefs: uploadedImages + 2,
    priority: inputs.priority,
    // Best quality is made at 1080p on the newest model; the other choices stay at 720p.
    resolution: (inputs.priority === "quality" ? "1080p" : "720p") as VideoResolution,
  };
  // Prefer a model that has a key. With none that can do the job, still show the plan the script
  // needs (the screen then says a key is missing); starting the video is what refuses.
  const available = availableSeedanceModels();
  let choice: ReturnType<typeof chooseSeedanceModel>;
  try {
    choice = chooseSeedanceModel({ ...request, available: available.length ? available : undefined });
  } catch {
    choice = chooseSeedanceModel(request);
  }
  const ratio = generationRatio(inputs.format);
  // When anyone speaks (on camera or voiceover), each later clip carries an earlier clip as the voice reference, which counts toward the cost.
  const chain = script.scenes.some((s) => s.line.trim());
  const cost = (res: VideoResolution) => choice.clips.reduce((t, c, i) => t + estimateClipUsd(choice.model, res, ratio, c.seconds, chain && i > 0 ? choice.clips[i - 1]!.seconds : 0), 0);
  const spec = SEEDANCE_SPECS[choice.model];
  return {
    model: choice.model,
    modelLabel: spec.label,
    reasons: choice.reasons,
    resolution: choice.resolution,
    clips: choice.clips.map((c, i) => ({ number: i + 1, seconds: c.seconds, sceneNumbers: c.sceneNumbers })),
    totalSeconds: choice.clips.reduce((t, c) => t + c.seconds, 0),
    estimatedUsd: Math.round(cost(choice.resolution) * 100) / 100,
    estimatedUsd1080: spec.resolutions.includes("1080p") ? Math.round(cost("1080p") * 100) / 100 : null,
  };
}
