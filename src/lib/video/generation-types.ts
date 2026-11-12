import type { AssetPurpose, ClipAttemptRecord, CreativePlan, ProviderCapabilities, PronunciationLexicon, QaReport, QaSeverity, SpeechLine } from "@/lib/video/pipeline-types";
import type { VideoMode } from "@/lib/video/clean-mode";

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
  /** What was open when they did, kept so an approved clip is never shown as one that passed. */
  override?: OverrideRecord | null;
};

/** When to wait for the operator before spending on the next clip. */
export type Checkpoint = "after_first" | "each" | "none";

/**
 * What the finishing step does to the picture. "clean" (the default) adds nothing: the three flags
 * are then always false. They mean something only for "branded", the earlier behaviour of burning
 * captions, the logo and an end card into the file.
 */
export type Finishing = {
  mode?: VideoMode;
  captions: boolean;
  logo: boolean;
  endCard: boolean;
};

export const DEFAULT_FINISHING: Finishing = { mode: "clean", captions: false, logo: false, endCard: false };

/** An uploaded file as it was when the video was started: the job keeps using exactly this file whatever is uploaded or changed afterwards. */
export type AssetSnapshot = {
  id: string;
  name: string;
  /** What the file is for, e.g. "approved_proof_screenshot". */
  purpose: AssetPurpose;
  /** Where the original bytes are kept. Never an expiring address. */
  key: string;
  mime: string;
  version: number;
  /** SHA-256 of the original bytes, checked whenever the file is used or handed over. Null when the file could not be read at the time. */
  sha256: string | null;
  bytes: number | null;
};

export type LogoSnapshot = { key: string; mime: string; sha256: string | null; bytes: number | null; sourceUrl: string | null; origin: "page" | "upload" | "client" };

/** What a person approved although an inspection had not: who decided is the operator; what they overrode is kept word for word. */
export type OverrideRecord = {
  at: string;
  by: string | null;
  /** The findings that were open when they approved it. */
  findings: Array<{ code: string; severity: QaSeverity; message: string; atSeconds?: number }>;
};

/** How a clip or an export stands: it passed, it has open findings, or a person approved it despite them. Never "passed" for an override. */
export type CheckStatus = "passed" | "issues" | "approved_despite_warnings" | "unchecked";

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
  /** What was open when they did. */
  override?: OverrideRecord | null;
  /** "clean": footage and sound only. Absent on exports made before clean video existed, which had their graphics burned in. */
  mode?: VideoMode;
  /** The files handed over beside a clean video: the transcript and the placement plan (subtitles are in `subtitles`). */
  deliverables?: { transcriptKey: string; planJsonKey: string; planTextKey: string; overlays: number } | null;
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
  /** The uploaded files and the logo exactly as they were when this video was started. */
  assets?: AssetSnapshot[];
  logo?: LogoSnapshot | null;
  /** Spoken lines reworded because they pointed at an image a clean video does not show. */
  narrationChanges?: Array<{ scene: number; was: string; now: string; reason: string }>;
  /** Scenes changed because a figure in them had no recorded source. */
  figureAdjustments?: Array<{ scene: number; figure: string; change: string }>;
  createdAt: string;
};

export type FinalView = Omit<FinalVideo, "key" | "reviewKey" | "subtitles" | "deliverables"> & {
  videoUrl: string | null;
  reviewUrl: string | null;
  srtUrl: string | null;
  vttUrl: string | null;
  subtitleCues: number;
  transcriptUrl: string | null;
  planUrl: string | null;
  planJsonUrl: string | null;
  suggestedOverlays: number;
  checkStatus: CheckStatus;
};

export type AssetView = { id: string; name: string; purpose: AssetPurpose; version: number; sha256: string | null; bytes: number | null; url: string; downloadUrl: string; available: boolean; cautions: string[] };

export type GenerationView = {
  status: "generating" | "paused" | "stopped" | "clips_ready" | "assembling" | "done" | "failed" | "idle";
  /** The clip waiting for the operator to check it, when paused. */
  reviewClip: number | null;
  /** Set when a clip did not pass its inspection and the operator is to say what happens next. */
  decision: (ClipDecision & { clip: number; spentUsd: number; budgetUsd: number | null; overBudget: boolean; canUse: boolean; remainingUsd: number }) | null;
  /** About what the clips not yet made would cost. */
  remainingUsd: number;
  final: FinalView | null;
  plan: (Omit<GenerationPlan, "character" | "setting" | "references" | "speech" | "assets" | "logo"> & { character: boolean; setting: boolean; speech: { uncertain: string[]; terms: number } | null }) | null;
  clips: Array<Omit<ClipState, "taskId" | "sourceVideoUrl" | "lastFrameUrl" | "videoKey" | "prompt" | "attemptLog"> & { hasVideo: boolean; videoUrl: string | null; attemptCount: number; checkStatus: CheckStatus }>;
  /** The files this video was started with (or, before it starts, the files it would start with): the actual thumbnail and file name of each. */
  assets: AssetView[];
  /** Things to settle about the evidence before it is used: a relabelled figure, a time claim the date range does not support, an unstated currency. */
  cautions: string[];
  /** False when files are kept on this server's own disk and would be lost on a restart. */
  storageDurable: boolean;
  spentUsd: number;
  /** Why generation cannot start, e.g. no key for the model. */
  blocked: string | null;
  /** A heads-up that does not stop the video (figures with no recorded source). */
  notice: string | null;
  error: string | null;
};
