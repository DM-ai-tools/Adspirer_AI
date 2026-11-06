/**
 * BytePlus ModelArk: Seedance video generation.
 *
 * Facts below are from the ModelArk docs (read 6 Nov 2026): the Seedance 2.0 series tutorial, the
 * Seedance 2.5 tutorial and prompt guide, the video generation tutorial and the pricing page.
 * Nothing here is guessed; where a number is an estimate it says so.
 */
import { getConfig } from "@/lib/config";

export type SeedanceModelKey = "seedance-2-5" | "seedance-2-0" | "seedance-2-0-fast" | "seedance-2-0-mini";
export type VideoResolution = "480p" | "720p" | "1080p";
export type VideoRatio = "9:16" | "1:1" | "3:4" | "16:9" | "adaptive";

export type SeedanceSpec = {
  key: SeedanceModelKey;
  modelId: string;
  label: string;
  /** Longest single request, in seconds. The shortest is 4 for every model. */
  maxSeconds: number;
  minSeconds: number;
  maxImageRefs: number;
  maxVideoRefs: number;
  maxAudioRefs: number;
  /** Audio can be the only reference (2.5), or must come with an image or video (2.0 series). */
  audioOnlyRef: boolean;
  resolutions: VideoResolution[];
  /** USD per million tokens, input without video. */
  usdPerMTokens: Partial<Record<VideoResolution, number>>;
  /** Online inference rate limit: concurrent tasks for an individual account. */
  concurrency: number;
};

export const MIN_CLIP_SECONDS = 4;

export const SEEDANCE_SPECS: Record<SeedanceModelKey, SeedanceSpec> = {
  "seedance-2-5": {
    key: "seedance-2-5",
    modelId: "dreamina-seedance-2-5-260628",
    label: "Seedance 2.5",
    maxSeconds: 30,
    minSeconds: MIN_CLIP_SECONDS,
    maxImageRefs: 30,
    maxVideoRefs: 10,
    maxAudioRefs: 10,
    audioOnlyRef: true,
    resolutions: ["480p", "720p", "1080p"],
    usdPerMTokens: { "480p": 10.7, "720p": 10.7, "1080p": 11.7 },
    concurrency: 3,
  },
  "seedance-2-0": {
    key: "seedance-2-0",
    modelId: "dreamina-seedance-2-0-260128",
    label: "Seedance 2.0",
    maxSeconds: 15,
    minSeconds: MIN_CLIP_SECONDS,
    maxImageRefs: 9,
    maxVideoRefs: 3,
    maxAudioRefs: 3,
    audioOnlyRef: false,
    resolutions: ["480p", "720p", "1080p"],
    usdPerMTokens: { "480p": 7.0, "720p": 7.0, "1080p": 7.7 },
    concurrency: 3,
  },
  "seedance-2-0-fast": {
    key: "seedance-2-0-fast",
    modelId: "dreamina-seedance-2-0-fast-260128",
    label: "Seedance 2.0 fast",
    maxSeconds: 15,
    minSeconds: MIN_CLIP_SECONDS,
    maxImageRefs: 9,
    maxVideoRefs: 3,
    maxAudioRefs: 3,
    audioOnlyRef: false,
    resolutions: ["480p", "720p"],
    usdPerMTokens: { "480p": 5.6, "720p": 5.6 },
    concurrency: 3,
  },
  "seedance-2-0-mini": {
    key: "seedance-2-0-mini",
    modelId: "dreamina-seedance-2-0-mini-260615",
    label: "Seedance 2.0 mini",
    maxSeconds: 15,
    minSeconds: MIN_CLIP_SECONDS,
    maxImageRefs: 9,
    maxVideoRefs: 3,
    maxAudioRefs: 3,
    audioOnlyRef: false,
    resolutions: ["480p", "720p"],
    usdPerMTokens: { "480p": 3.5, "720p": 3.5 },
    concurrency: 3,
  },
};

/** The documented sample response reports 24 frames per second. */
export const OUTPUT_FPS = 24;

/** Pixel size of a ratio at a resolution (the short edge is the resolution's number). */
export function frameSize(resolution: VideoResolution, ratio: VideoRatio): { width: number; height: number } {
  const short = resolution === "480p" ? 480 : resolution === "720p" ? 720 : 1080;
  const even = (n: number) => Math.round(n / 2) * 2;
  switch (ratio) {
    case "9:16":
      return { width: short, height: even((short * 16) / 9) };
    case "3:4":
      return { width: short, height: even((short * 4) / 3) };
    case "16:9":
      return { width: even((short * 16) / 9), height: short };
    default:
      return { width: short, height: short };
  }
}

/**
 * Estimated cost of one clip, from the pricing page's formula: tokens = seconds x width x height x
 * fps / 1024, billed per million tokens. It is an estimate: the bill follows usage.completion_tokens.
 */
export function estimateClipUsd(model: SeedanceModelKey, resolution: VideoResolution, ratio: VideoRatio, seconds: number, inputVideoSeconds = 0): number {
  const spec = SEEDANCE_SPECS[model];
  const rate = spec.usdPerMTokens[resolution];
  if (rate === undefined) throw new Error(`${spec.label} does not offer ${resolution}`);
  const { width, height } = frameSize(resolution, ratio);
  // A reference video counts toward the tokens as well as the clip that is made.
  const tokens = ((seconds + inputVideoSeconds) * width * height * OUTPUT_FPS) / 1024;
  return (tokens / 1_000_000) * rate;
}

/** What a finished task cost, from the tokens it reports. */
export function usdForTokens(model: SeedanceModelKey, resolution: VideoResolution, tokens: number): number {
  const rate = SEEDANCE_SPECS[model].usdPerMTokens[resolution] ?? 0;
  return (tokens / 1_000_000) * rate;
}

export type ClipSlice = { sceneNumbers: number[]; seconds: number };

/**
 * Group consecutive scenes into clips. Cuts fall only on scene boundaries. Uses as few clips as the
 * model's longest request allows, then spreads the length as evenly as it can, so no clip is a stub
 * and a join is never in the middle of a scene. Scenes must each fit in one clip.
 */
export function splitIntoClips(scenes: Array<{ number: number; seconds: number }>, maxSeconds: number, minSeconds = MIN_CLIP_SECONDS): ClipSlice[] {
  if (!scenes.length) return [];
  if (scenes.some((s) => s.seconds > maxSeconds)) throw new Error(`A scene is longer than ${maxSeconds}s, which this model cannot do in one clip.`);
  const total = scenes.reduce((a, s) => a + s.seconds, 0);
  const prefix = [0];
  for (const s of scenes) prefix.push(prefix[prefix.length - 1]! + s.seconds);

  const attempt = (clips: number): number[] | null => {
    const mean = total / clips;
    const INF = Number.POSITIVE_INFINITY;
    // best[k][i]: cheapest way to cover the first i scenes with k clips; cost is squared deviation from the mean.
    const best: number[][] = Array.from({ length: clips + 1 }, () => Array<number>(scenes.length + 1).fill(INF));
    const from: number[][] = Array.from({ length: clips + 1 }, () => Array<number>(scenes.length + 1).fill(-1));
    best[0]![0] = 0;
    for (let k = 1; k <= clips; k += 1) {
      for (let i = 1; i <= scenes.length; i += 1) {
        for (let j = k - 1; j < i; j += 1) {
          const len = prefix[i]! - prefix[j]!;
          if (len > maxSeconds || (len < minSeconds && total >= minSeconds)) continue;
          const prev = best[k - 1]![j]!;
          if (prev === INF) continue;
          const cost = prev + (len - mean) ** 2;
          if (cost < best[k]![i]!) {
            best[k]![i] = cost;
            from[k]![i] = j;
          }
        }
      }
    }
    if (best[clips]![scenes.length] === INF) return null;
    const cuts: number[] = [];
    let i = scenes.length;
    for (let k = clips; k >= 1; k -= 1) {
      cuts.unshift(i);
      i = from[k]![i]!;
    }
    return cuts;
  };

  const minClips = Math.max(1, Math.ceil(total / maxSeconds));
  for (let clips = minClips; clips <= scenes.length; clips += 1) {
    const cuts = attempt(clips);
    if (cuts) {
      const out: ClipSlice[] = [];
      let start = 0;
      for (const end of cuts) {
        const slice = scenes.slice(start, end);
        out.push({ sceneNumbers: slice.map((s) => s.number), seconds: slice.reduce((a, s) => a + s.seconds, 0) });
        start = end;
      }
      return out;
    }
  }
  throw new Error("The scenes cannot be grouped into clips within the model's limits.");
}

export type ModelChoice = {
  model: SeedanceModelKey;
  reasons: string[];
  clips: ClipSlice[];
  resolution: VideoResolution;
};

export type ChooseInput = {
  scenes: Array<{ number: number; seconds: number; onCameraSpeech: boolean }>;
  imageRefs: number;
  /** "quality" prefers fewer joins and the newest model, "cost" the cheapest that can do it. */
  priority?: "quality" | "balanced" | "cost";
  resolution?: VideoResolution;
  /** Models this deployment has a key for. Defaults to all. */
  available?: SeedanceModelKey[];
};

/**
 * Pick the model for a script, with the reasons, so the choice can be shown and trusted.
 * A talking person is the hardest thing to keep consistent across a join, so scripts built on one
 * go to 2.5 (up to 30s in one request, more references, audio-only references). Cut-away scripts
 * (voiceover over varied shots) hide joins by design and can use the cheaper 2.0.
 */
export function chooseSeedanceModel(input: ChooseInput): ModelChoice {
  const priority = input.priority ?? "balanced";
  const resolution = input.resolution ?? "720p";
  const total = input.scenes.reduce((a, s) => a + s.seconds, 0);
  const speechSeconds = input.scenes.filter((s) => s.onCameraSpeech).reduce((a, s) => a + s.seconds, 0);
  const speechShare = total ? speechSeconds / total : 0;
  const longest = Math.max(...input.scenes.map((s) => s.seconds));
  const reasons: string[] = [];
  let model: SeedanceModelKey = "seedance-2-5";

  const needs25 =
    longest > SEEDANCE_SPECS["seedance-2-0"].maxSeconds ||
    input.imageRefs > SEEDANCE_SPECS["seedance-2-0"].maxImageRefs ||
    speechShare >= 0.4 ||
    priority === "quality";

  if (longest > SEEDANCE_SPECS["seedance-2-0"].maxSeconds) reasons.push(`a single scene runs ${longest}s, past the 15s limit of Seedance 2.0`);
  if (input.imageRefs > SEEDANCE_SPECS["seedance-2-0"].maxImageRefs) reasons.push(`${input.imageRefs} reference images, more than 2.0's 9`);
  if (speechShare >= 0.4) reasons.push(`a person speaks on camera for ${Math.round(speechShare * 100)}% of the ad, so fewer joins keeps the face and voice consistent`);
  if (priority === "quality") reasons.push("quality was chosen");

  if (needs25) {
    model = "seedance-2-5";
    if (!reasons.length) reasons.push("best realism and fewest joins");
  } else if (priority === "cost" && total <= 15 * 3) {
    model = "seedance-2-0-fast";
    reasons.push("cost was chosen and the ad is mostly cut-aways, which hide the joins");
    // Fast stops at 720p.
  } else {
    model = "seedance-2-0";
    reasons.push("mostly voiceover over varied shots, where cuts hide the joins, so the cheaper 2.0 does the job");
  }

  // A model with no key is never chosen: fall back to one that has a key and can still do the job.
  const available = input.available ?? (Object.keys(SEEDANCE_SPECS) as SeedanceModelKey[]);
  if (!available.includes(model)) {
    const wanted = SEEDANCE_SPECS[model].label;
    const alternative = (["seedance-2-5", "seedance-2-0", "seedance-2-0-fast", "seedance-2-0-mini"] as SeedanceModelKey[]).find(
      (m) => available.includes(m) && SEEDANCE_SPECS[m].maxSeconds >= longest && SEEDANCE_SPECS[m].maxImageRefs >= input.imageRefs,
    );
    if (!alternative) throw new Error(`${wanted} is the right model for this script but has no API key here, and no other model with a key can make it.`);
    reasons.push(`${wanted} has no API key here, so ${SEEDANCE_SPECS[alternative].label} is used`);
    model = alternative;
  }

  const spec = SEEDANCE_SPECS[model];
  const res = spec.resolutions.includes(resolution) ? resolution : spec.resolutions[spec.resolutions.length - 1]!;
  const clips = splitIntoClips(
    input.scenes.map((s) => ({ number: s.number, seconds: s.seconds })),
    spec.maxSeconds,
  );
  reasons.push(`${clips.length} clip${clips.length === 1 ? "" : "s"} of ${clips.map((c) => `${c.seconds}s`).join(" + ")}`);
  return { model, reasons, clips, resolution: res };
}

// ---------------------------------------------------------------- API client

export type ArkContent =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string }; role: "reference_image" | "first_frame" | "last_frame" }
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" };

/**
 * The key and model id for a model. Each family can have its own key (falling back to ARK_API_KEY),
 * and the model id can be overridden from the environment if BytePlus ships a newer dated version.
 */
export function arkCredentials(model: SeedanceModelKey): { apiKey: string; modelId: string } {
  const c = getConfig();
  const is25 = model === "seedance-2-5";
  const apiKey = (is25 ? c.ARK_SEEDANCE_25_API_KEY : c.ARK_SEEDANCE_API_KEY) || c.ARK_API_KEY;
  if (!apiKey) throw new Error(is25 ? "Set ARK_SEEDANCE_25_API_KEY (or ARK_API_KEY) to use Seedance 2.5." : "Set ARK_SEEDANCE_API_KEY (or ARK_API_KEY) to use Seedance 2.0.");
  const override = is25 ? c.ARK_SEEDANCE_25_MODEL : model === "seedance-2-0" ? c.ARK_SEEDANCE_MODEL : undefined;
  return { apiKey, modelId: override || SEEDANCE_SPECS[model].modelId };
}

/** Which models this deployment can actually call, so the chooser never picks one without a key. */
export function availableSeedanceModels(): SeedanceModelKey[] {
  const c = getConfig();
  const has25 = Boolean(c.ARK_SEEDANCE_25_API_KEY || c.ARK_API_KEY);
  const has20 = Boolean(c.ARK_SEEDANCE_API_KEY || c.ARK_API_KEY);
  return (["seedance-2-5", "seedance-2-0", "seedance-2-0-fast", "seedance-2-0-mini"] as SeedanceModelKey[]).filter((m) => (m === "seedance-2-5" ? has25 : has20));
}

export type CreateTaskInput = {
  model: SeedanceModelKey;
  content: ArkContent[];
  seconds: number;
  ratio: VideoRatio;
  resolution: VideoResolution;
  generateAudio?: boolean;
  seed?: number;
};

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "expired" | "cancelled";

export type TaskResult = {
  id: string;
  status: TaskStatus;
  videoUrl: string | null;
  lastFrameUrl: string | null;
  completionTokens: number | null;
  error: { code: string; message: string } | null;
};

export async function arkRequest<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const config = getConfig();
  const url = `${config.ARK_BASE_URL.replace(/\/$/, "")}${path}`;
  let lastError: Error | null = null;
  // Rate limits (429) and server errors are retried with a short backoff; anything else is the caller's to see.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (response.ok) return body as T;
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    lastError = new Error(`ModelArk ${response.status}${err?.code ? ` ${err.code}` : ""}: ${err?.message ?? (text.slice(0, 200) || "request failed")}`);
    if (response.status !== 429 && response.status < 500) throw lastError;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw lastError ?? new Error("ModelArk request failed");
}

export function buildTaskBody(input: CreateTaskInput, modelId?: string): Record<string, unknown> {
  const spec = SEEDANCE_SPECS[input.model];
  const seconds = Math.round(input.seconds);
  if (seconds < spec.minSeconds || seconds > spec.maxSeconds) {
    throw new Error(`${spec.label} makes ${spec.minSeconds}-${spec.maxSeconds}s clips; ${seconds}s was asked for.`);
  }
  const images = input.content.filter((c) => c.type === "image_url" && c.role === "reference_image").length;
  if (images > spec.maxImageRefs) throw new Error(`${spec.label} takes at most ${spec.maxImageRefs} reference images (got ${images}).`);
  const hasFrame = input.content.some((c) => c.type === "image_url" && (c.role === "first_frame" || c.role === "last_frame"));
  const body: Record<string, unknown> = {
    model: modelId ?? spec.modelId,
    content: input.content,
    duration: seconds,
    // First/last-frame tasks keep the frame's own shape and require "adaptive".
    ratio: hasFrame ? "adaptive" : input.ratio,
    resolution: input.resolution,
    generate_audio: input.generateAudio ?? true,
    // The last frame is what the next clip starts from; the ad carries no vendor watermark.
    return_last_frame: true,
    watermark: false,
  };
  // On 2.5, say it is a plain reference-to-video task so the model does not read it as an edit or an extension.
  if (input.model === "seedance-2-5" && !hasFrame) body.omni_reference_task_type = "auto";
  if (input.seed !== undefined) body.seed = input.seed;
  return body;
}

export async function createVideoTask(input: CreateTaskInput): Promise<{ id: string }> {
  const { apiKey, modelId } = arkCredentials(input.model);
  const created = await arkRequest<{ id: string }>(apiKey, "/contents/generations/tasks", { method: "POST", body: JSON.stringify(buildTaskBody(input, modelId)) });
  if (!created?.id) throw new Error("ModelArk did not return a task id.");
  return { id: created.id };
}

export function mapTask(raw: {
  id?: string;
  status?: string;
  content?: { video_url?: string; last_frame_url?: string };
  usage?: { completion_tokens?: number };
  error?: { code?: string; message?: string } | null;
}): TaskResult {
  const status = (["queued", "running", "succeeded", "failed", "expired", "cancelled"].includes(raw.status ?? "") ? raw.status : "running") as TaskStatus;
  return {
    id: String(raw.id ?? ""),
    status,
    videoUrl: raw.content?.video_url ?? null,
    lastFrameUrl: raw.content?.last_frame_url ?? null,
    completionTokens: raw.usage?.completion_tokens ?? null,
    error: raw.error ? { code: raw.error.code ?? "unknown", message: raw.error.message ?? "Generation failed" } : null,
  };
}

/** A task is read and cancelled with the same key (and so the same account) that created it. */
export async function getVideoTask(model: SeedanceModelKey, id: string): Promise<TaskResult> {
  return mapTask(await arkRequest(arkCredentials(model).apiKey, `/contents/generations/tasks/${encodeURIComponent(id)}`));
}

export async function cancelVideoTask(model: SeedanceModelKey, id: string): Promise<void> {
  await arkRequest(arkCredentials(model).apiKey, `/contents/generations/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}
