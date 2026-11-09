import type { ClipAttemptRecord, CreativePlan, ProviderCapabilities, PronunciationLexicon, QaReport, SpeechLine } from "@/lib/video/pipeline-types";

/** What is stored while a video is being made, and what the screen reads back. Client-safe: types only. */

/** "reviewing": the clip is downloaded and is being inspected before it counts as made. */
export type ClipStatus = "waiting" | "running" | "reviewing" | "succeeded" | "failed";

/**
 * A clip the inspection did not approve. Nothing is made again until the operator says so, because
 * every new attempt is paid for: they can make it again (at the stated cost), use the clip as it is,
 * or stop.
 */
export type ClipDecision = {
  /** What the automatic loop would have done: correct and retry, redesign the shot, or nothing (retries used up, or over the cost cap). */
  verdict: "retry" | "redesign" | "unresolved";
  /** The problems, in words for the operator. */
  summary: string;
  /** About what one more attempt at this clip costs. */
  estimateUsd: number;
  /** Seconds the last scene of this clip needs when the speech ran past it, applied if the operator makes it again. */
  addSeconds: number;
  /** The corrections the next attempt would carry. */
  corrections: string[];
  /** True when the inspection itself could not run: making the clip again would not help, inspecting again would. */
  inspectionFailed: boolean;
  at: string;
};

export type ClipState = {
  number: number;
  seconds: number;
  sceneNumbers: number[];
  status: ClipStatus;
  /** The ModelArk task, while one exists. */
  taskId: string | null;
  attempts: number;
  error: string | null;
  /** The clip saved in our storage once it is done. */
  videoKey: string | null;
  /** The last frame as ModelArk returned it. Kept by its original address, because only an unedited original is trusted as a face reference. */
  lastFrameUrl: string | null;
  /** The clip as ModelArk returned it (valid for 24 hours), used as the voice and look reference for the next clip. */
  sourceVideoUrl: string | null;
  finishedAt: string | null;
  tokens: number | null;
  usd: number | null;
  /** The prompt that was sent, so a clip can be understood and repeated. */
  prompt: string | null;
  /** The operator has looked at this clip and said to carry on. */
  approved?: boolean;
  /** Every attempt at this clip: the prompt, the corrections added, the review and what it cost. Explains why a clip was retried or failed. */
  attemptLog?: ClipAttemptRecord[];
  /** The review of the clip that is currently kept (or the last one when it failed). */
  qa?: QaReport | null;
  /** Corrections for the NEXT attempt, from the last review's findings. */
  corrections?: string[];
  /** Attempts made because a review rejected the clip (separate from attempts lost to provider errors). */
  qaAttempts?: number;
  /** How many times the scenes in this clip were redesigned after repeated failures. */
  redesigns?: number;
  /** True when the review could not approve the clip and no retry is left: it blocks the video. */
  unresolved?: boolean;
  /** Set while the operator is deciding what to do with a clip that did not pass. */
  decision?: ClipDecision | null;
  /** The operator used this clip although the inspection did not approve it. */
  acceptedWithIssues?: boolean;
};

/** When to wait for the operator before spending on the next clip. */
export type Checkpoint = "after_first" | "each" | "none";

export type Finishing = {
  captions: boolean;
  logo: boolean;
  endCard: boolean;
};

export const DEFAULT_FINISHING: Finishing = { captions: true, logo: true, endCard: true };

export type QaCheck = { name: string; ok: boolean; detail: string };

/** What the brand check found when the video was finished, so a delivered file can be traced to verified inputs. */
export type FinalBrandUse = { name: string | null; logo: boolean; textOnly: boolean };

/** The finished video, or the state of making it. */
export type FinalVideo = {
  /** "blocked": the export was made but failed a critical check, so it is not offered for download. */
  state: "running" | "done" | "failed" | "blocked";
  /** What the step is doing now, for the screen. */
  stage: string | null;
  error: string | null;
  startedAt: string;
  key: string | null;
  seconds: number | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  createdAt: string | null;
  qa: QaCheck[];
  includes: { captions: boolean; logo: boolean; endCard: boolean; stats: number; images: number; captionTiming: "transcript" | "estimated" | "none" } | null;
  /** The full inspection of the exported video (frames, text read from the video, brand checks). */
  report?: QaReport | null;
  /** Subtitle files made from the same timing as the burned-in captions. */
  subtitles?: { srtKey: string; vttKey: string; cues: number } | null;
  brand?: FinalBrandUse | null;
  /** The narration's length as measured from the audio of this export, against what the script estimated. Null when the speech could not be located. */
  speech?: { measuredSeconds: number | null; estimatedSeconds: number | null } | null;
  /** A blocked export is kept here for the operator to look at; it is never offered as the finished video. */
  reviewKey?: string | null;
  /** The operator delivered this export although the inspection did not approve it. */
  acceptedAnyway?: boolean;
};

export type ReferenceImage = {
  url: string;
  /** Our own copy for showing on screen. */
  key: string | null;
  createdAt: string;
};

export type GenerationPlan = {
  model: string;
  modelLabel: string;
  resolution: string;
  /** The shape ModelArk makes. 4:5 is made as 3:4 and cropped afterwards. */
  ratio: string;
  format: string;
  reasons: string[];
  estimatedUsd: number;
  character: ReferenceImage | null;
  setting: ReferenceImage | null;
  /** True when each later clip also gets the one before it as a reference, to keep the face and voice the same. */
  chainVideo: boolean;
  /** What the finishing step adds. */
  finishing: Finishing;
  /** Where generation waits for the operator to check a clip before paying for the next. */
  checkpoint: Checkpoint;
  /** The creative plan made for this video: per-scene briefs, characters, environments. Made before any clip is paid for. */
  creative?: CreativePlan | null;
  /** Display text versus speech text, and how each term is said. */
  speech?: { lexicon: PronunciationLexicon; lines: SpeechLine[] } | null;
  /** One reference image per recurring person and per place. */
  references?: { characters: Record<string, ReferenceImage>; environments: Record<string, ReferenceImage> };
  /** What this deployment's providers can and cannot do, and what is done instead. */
  capabilities?: ProviderCapabilities;
  /** The most that may be spent on one video including clips that were rejected and made again. */
  budgetUsd?: number;
  createdAt: string;
};

export type FinalView = Omit<FinalVideo, "key" | "reviewKey" | "subtitles"> & { videoUrl: string | null; reviewUrl: string | null; srtUrl: string | null; vttUrl: string | null; subtitleCues: number };

export type GenerationView = {
  status: "generating" | "paused" | "stopped" | "clips_ready" | "assembling" | "done" | "failed" | "idle";
  /** The clip waiting for the operator to check it, when paused. */
  reviewClip: number | null;
  /** Set when a clip did not pass its inspection and the operator is to say what happens next. */
  decision: (ClipDecision & { clip: number; spentUsd: number; budgetUsd: number | null; overBudget: boolean; canUse: boolean; remainingUsd: number }) | null;
  /** About what the clips not yet made would cost. */
  remainingUsd: number;
  final: FinalView | null;
  plan: (Omit<GenerationPlan, "character" | "setting" | "references" | "speech"> & { character: boolean; setting: boolean; speech: { uncertain: string[]; terms: number } | null }) | null;
  clips: Array<Omit<ClipState, "taskId" | "sourceVideoUrl" | "lastFrameUrl" | "videoKey" | "prompt" | "attemptLog"> & { hasVideo: boolean; videoUrl: string | null; attemptCount: number }>;
  spentUsd: number;
  /** Why generation cannot start, e.g. no key for the model. */
  blocked: string | null;
  error: string | null;
};
