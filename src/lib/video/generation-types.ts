/** What is stored while a video is being made, and what the screen reads back. Client-safe: types only. */

export type ClipStatus = "waiting" | "running" | "succeeded" | "failed";

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
};

export type Finishing = {
  captions: boolean;
  logo: boolean;
  endCard: boolean;
};

export const DEFAULT_FINISHING: Finishing = { captions: true, logo: true, endCard: true };

export type QaCheck = { name: string; ok: boolean; detail: string };

/** The finished video, or the state of making it. */
export type FinalVideo = {
  state: "running" | "done" | "failed";
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
  createdAt: string;
};

export type FinalView = Omit<FinalVideo, "key"> & { videoUrl: string | null };

export type GenerationView = {
  status: "generating" | "clips_ready" | "assembling" | "done" | "failed" | "idle";
  final: FinalView | null;
  plan: (Omit<GenerationPlan, "character" | "setting"> & { character: boolean; setting: boolean }) | null;
  clips: Array<Omit<ClipState, "taskId" | "sourceVideoUrl" | "lastFrameUrl" | "videoKey" | "prompt"> & { hasVideo: boolean; videoUrl: string | null }>;
  spentUsd: number;
  /** Why generation cannot start, e.g. no key for the model. */
  blocked: string | null;
  error: string | null;
};
