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
  createdAt: string;
};

export type GenerationView = {
  status: "generating" | "clips_ready" | "failed" | "idle";
  plan: (Omit<GenerationPlan, "character" | "setting"> & { character: boolean; setting: boolean }) | null;
  clips: Array<Omit<ClipState, "taskId" | "sourceVideoUrl" | "lastFrameUrl" | "videoKey" | "prompt"> & { hasVideo: boolean; videoUrl: string | null }>;
  spentUsd: number;
  /** Why generation cannot start, e.g. no key for the model. */
  blocked: string | null;
  error: string | null;
};
