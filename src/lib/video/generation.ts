import { getObjectStorage } from "@/lib/storage/r2";
import { logger } from "@/lib/observability/logger";
import { buildClipPrompt } from "@/lib/video/clip-prompt";
import type { ArkContent } from "@/lib/video/seedance";
import {
  arkCredentials,
  availableSeedanceModels,
  createVideoTask,
  estimateClipUsd,
  getVideoTask,
  SEEDANCE_SPECS,
  usdForTokens,
  type SeedanceModelKey,
  type VideoResolution,
} from "@/lib/video/seedance";
import { createReferenceImage } from "@/lib/video/seedream";
import { assembleVideo } from "@/lib/video/assemble";
import { generationRatio, previewPlan } from "@/lib/video/plan-view";
import { DEFAULT_FINISHING, type ClipState, type Finishing, type GenerationPlan, type GenerationView } from "@/lib/video/generation-types";
import { claimProjectLease, getProject, releaseProjectLease, updateProject, type VideoProject } from "@/lib/video/projects";

/** A reference image or clip address from ModelArk stops working after 24 hours; stop using one well before. */
const FRESH_MS = 20 * 60 * 60 * 1000;
const LEASE_MS = 45_000;
const POLL_EVERY_MS = 8_000;
const MAX_ATTEMPTS = 2;

const fresh = (iso: string | null | undefined, now = Date.now()) => Boolean(iso) && now - Date.parse(iso!) < FRESH_MS;

/** Why a video cannot be made right now, or null. */
export function blockedReason(project: VideoProject): string | null {
  if (!project.chosen_script) return "Confirm a script first.";
  if (!availableSeedanceModels().length) return "Add your BytePlus key to .env.local (ARK_API_KEY, or ARK_SEEDANCE_API_KEY and ARK_SEEDANCE_25_API_KEY) to make video.";
  try {
    const preview = previewPlan(project.chosen_script, project.inputs, project.assets.length);
    arkCredentials(preview.model as SeedanceModelKey);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Video generation is not set up.";
  }
}

/** The plan and the empty clip list for a confirmed script. */
export function buildPlan(project: VideoProject, finishing: Finishing = DEFAULT_FINISHING): { plan: GenerationPlan; clips: ClipState[] } {
  const script = project.chosen_script;
  if (!script) throw new Error("Confirm a script first.");
  const preview = previewPlan(script, project.inputs, project.assets.length);
  const model = preview.model as SeedanceModelKey;
  arkCredentials(model);
  const chainVideo = script.scenes.some((s) => s.speaker === "on_camera");
  const plan: GenerationPlan = {
    model,
    modelLabel: preview.modelLabel,
    resolution: preview.resolution,
    ratio: generationRatio(project.inputs.format),
    format: project.inputs.format,
    reasons: preview.reasons,
    estimatedUsd: preview.estimatedUsd,
    character: null,
    setting: null,
    chainVideo,
    finishing,
    createdAt: new Date().toISOString(),
  };
  const clips: ClipState[] = preview.clips.map((c) => ({
    number: c.number,
    seconds: c.seconds,
    sceneNumbers: c.sceneNumbers,
    status: "waiting",
    taskId: null,
    attempts: 0,
    error: null,
    videoKey: null,
    lastFrameUrl: null,
    sourceVideoUrl: null,
    finishedAt: null,
    tokens: null,
    usd: null,
    prompt: null,
  }));
  return { plan, clips };
}

export async function startGeneration(projectId: string, finishing: Finishing = DEFAULT_FINISHING): Promise<VideoProject> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Video project not found");
  const { plan, clips } = buildPlan(project, finishing);
  return updateProject(projectId, { plan, clips, final: null, status: "generating", error: null });
}

/** Everything needed to ask for one clip. */
export function buildClipRequest(project: VideoProject, plan: GenerationPlan, clips: ClipState[], clip: ClipState, now = Date.now()) {
  const script = project.chosen_script!;
  const previous = clips[clip.number - 2];
  const previousFrame = previous && previous.status === "succeeded" && previous.lastFrameUrl && fresh(previous.finishedAt, now) ? previous.lastFrameUrl : null;
  const previousVideo = plan.chainVideo && previous && previous.status === "succeeded" && previous.sourceVideoUrl && fresh(previous.finishedAt, now) ? previous.sourceVideoUrl : null;
  const presenter = plan.character?.url ?? null;
  const location = plan.setting?.url ?? null;

  const content: ArkContent[] = [];
  const prompt = buildClipPrompt({
    script,
    sceneNumbers: clip.sceneNumbers,
    clipNumber: clip.number,
    clipCount: clips.length,
    locale: project.inputs.locale,
    refs: { presenter: Boolean(presenter), location: Boolean(location), previousFrame: Boolean(previousFrame), previousVideo: Boolean(previousVideo) },
    graphicSceneNumbers: script.scenes.filter((s) => s.stat || s.assetId).map((s) => s.number),
  });
  content.push({ type: "text", text: prompt });
  // Order matters: the prompt names assets as Image 1, Image 2, Image 3 in this order.
  for (const url of [presenter, location, previousFrame]) {
    if (url) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  }
  if (previousVideo) content.push({ type: "video_url", video_url: { url: previousVideo }, role: "reference_video" });
  return { prompt, content };
}

async function saveClipFile(projectId: string, clip: ClipState, videoUrl: string): Promise<string> {
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Could not download the clip (${res.status}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const key = `video/${projectId}/clip-${clip.number}-${Date.now()}.mp4`;
  await getObjectStorage().put(key, bytes, "video/mp4");
  if (clip.videoKey) await getObjectStorage().delete(clip.videoKey).catch(() => undefined);
  return key;
}

export type StepResult = "working" | "done" | "failed" | "idle";

/**
 * One bounded step: make a missing reference image, submit the next clip, or check the running one.
 * Safe to call again and again. The caller holds the lease.
 */
export async function step(projectId: string, now = Date.now()): Promise<StepResult> {
  let project = await getProject(projectId);
  if (!project || project.status !== "generating" || !project.plan || !project.clips || !project.chosen_script) return "idle";
  const plan = project.plan;
  const clips = project.clips;
  const script = project.chosen_script;
  const model = plan.model as SeedanceModelKey;
  const save = async (patch: Partial<VideoProject>) => {
    project = await updateProject(projectId, patch);
  };

  // 1. The presenter and the location, made once, by Seedream on the same account.
  const firstWaiting = clips.find((c) => c.status !== "succeeded");
  const needsFreshRefs = firstWaiting?.number === 1 && firstWaiting.status === "waiting";
  if (script.character && (!plan.character || (needsFreshRefs && !fresh(plan.character.createdAt, now)))) {
    const img = await createReferenceImage(model, "presenter", script.character);
    plan.character = { url: img.url, key: null, createdAt: new Date(now).toISOString() };
    await save({ plan });
  }
  if (script.setting && (!plan.setting || (needsFreshRefs && !fresh(plan.setting.createdAt, now)))) {
    const img = await createReferenceImage(model, "location", script.setting);
    plan.setting = { url: img.url, key: null, createdAt: new Date(now).toISOString() };
    await save({ plan });
  }

  // 2. The clips, one after another: each opens from where the last one ended.
  for (const clip of clips) {
    if (clip.status === "succeeded") continue;
    if (clip.status === "failed") return "failed";

    if (clip.status === "waiting") {
      const previous = clips[clip.number - 2];
      if (previous && previous.status !== "succeeded") return "working";
      // A later clip whose references have expired would not match the first: say so instead of drifting.
      if (clip.number > 1 && ((plan.character && !fresh(plan.character.createdAt, now)) || (plan.setting && !fresh(plan.setting.createdAt, now)))) {
        clip.status = "failed";
        clip.error = "The reference images for this video expired (they last 24 hours). Regenerate from clip 1 to keep the person the same.";
        await save({ clips, status: "failed", error: clip.error });
        return "failed";
      }
      const request = buildClipRequest(project, plan, clips, clip, now);
      try {
        const task = await createVideoTask({
          model,
          content: request.content,
          seconds: clip.seconds,
          ratio: plan.ratio as "9:16",
          resolution: plan.resolution as VideoResolution,
          generateAudio: true,
          seed: clip.attempts > 0 ? Math.floor(Math.random() * 2_000_000_000) : undefined,
        });
        clip.status = "running";
        clip.taskId = task.id;
        clip.attempts += 1;
        clip.prompt = request.prompt;
        clip.error = null;
      } catch (error) {
        clip.attempts += 1;
        clip.error = error instanceof Error ? error.message : String(error);
        if (clip.attempts >= MAX_ATTEMPTS) {
          clip.status = "failed";
          await save({ clips, status: "failed", error: `Clip ${clip.number} could not be started: ${clip.error}` });
          return "failed";
        }
      }
      await save({ clips });
      return "working";
    }

    // running: ask how it is getting on
    const result = await getVideoTask(model, clip.taskId!);
    if (result.status === "queued" || result.status === "running") return "working";
    if (result.status === "succeeded" && result.videoUrl) {
      clip.videoKey = await saveClipFile(projectId, clip, result.videoUrl);
      clip.sourceVideoUrl = result.videoUrl;
      clip.lastFrameUrl = result.lastFrameUrl;
      clip.tokens = result.completionTokens;
      clip.usd = result.completionTokens !== null ? usdForTokens(model, plan.resolution as VideoResolution, result.completionTokens) : estimateClipUsd(model, plan.resolution as VideoResolution, plan.ratio as "9:16", clip.seconds);
      clip.finishedAt = new Date(now).toISOString();
      clip.status = "succeeded";
      clip.error = null;
      await save({ clips });
      continue;
    }
    // failed, expired or cancelled: try once more, then stop and say why.
    const reason = result.error ? `${result.error.code}: ${result.error.message}` : `The task ${result.status}.`;
    clip.error = reason;
    clip.taskId = null;
    if (clip.attempts >= MAX_ATTEMPTS) {
      clip.status = "failed";
      await save({ clips, status: "failed", error: `Clip ${clip.number} failed: ${reason}` });
      return "failed";
    }
    clip.status = "waiting";
    await save({ clips });
    return "working";
  }

  await save({ clips, status: "clips_ready", error: null });
  return "done";
}

/** One locked step. Returns "idle" when someone else is already working on this video. */
export async function advance(projectId: string): Promise<StepResult> {
  if (!(await claimProjectLease(projectId, LEASE_MS))) return "idle";
  try {
    return await step(projectId);
  } catch (error) {
    logger.warn("Video generation step failed", { projectId, error: error instanceof Error ? error.message : String(error) });
    return "working";
  } finally {
    await releaseProjectLease(projectId);
  }
}

/** Keep stepping until the video is done, fails, or the time budget is used up (the page carries on after that). */
export async function runGeneration(projectId: string, budgetMs = 240_000, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<StepResult> {
  const started = Date.now();
  let last: StepResult = "working";
  while (Date.now() - started < budgetMs) {
    last = await advance(projectId);
    if (last === "done") {
      // Every clip is made: join them and finish the video straight away.
      await assembleVideo(projectId);
      return last;
    }
    if (last === "failed") return last;
    if (last === "idle") {
      const p = await getProject(projectId);
      if (!p || p.status !== "generating") return last;
    }
    await sleep(POLL_EVERY_MS);
  }
  return last;
}

/**
 * Make clip `fromClip` and every clip after it again (each one opens from where the one before it
 * ended, so a change in the middle changes what follows). Earlier clips are kept.
 */
export async function regenerateFrom(projectId: string, fromClip: number): Promise<VideoProject> {
  const project = await getProject(projectId);
  if (!project?.plan || !project.clips) throw new Error("There is no video to regenerate yet.");
  const storage = getObjectStorage();
  const clips = project.clips.map((c) => {
    if (c.number < fromClip) return c;
    if (c.videoKey) void storage.delete(c.videoKey).catch(() => undefined);
    return { ...c, status: "waiting" as const, taskId: null, attempts: 0, error: null, videoKey: null, lastFrameUrl: null, sourceVideoUrl: null, finishedAt: null, tokens: null, usd: null, prompt: null };
  });
  // From clip 1 the references are made fresh too, so a new take starts from a new, matching person.
  const plan = { ...project.plan, character: fromClip === 1 ? null : project.plan.character, setting: fromClip === 1 ? null : project.plan.setting };
  return updateProject(projectId, { clips, plan, final: null, status: "generating", error: null });
}

/** Assembling takes about a minute. One that has been "running" far longer was interrupted (a restart, a crash): show it as such. */
const ASSEMBLY_STALE_MS = 8 * 60 * 1000;

export function effectiveProject(project: VideoProject, now = Date.now()): VideoProject {
  if (project.status === "assembling" && project.final && now - Date.parse(project.final.startedAt) > ASSEMBLY_STALE_MS) {
    return { ...project, status: "clips_ready", final: { ...project.final, state: "failed", stage: null, error: "Finishing the video was interrupted. Try again." } };
  }
  return project;
}

/** What the screen reads: state per clip, without internal addresses. */
export function viewGeneration(raw: VideoProject): GenerationView {
  const project = effectiveProject(raw);
  const clips = project.clips ?? [];
  const status = project.status === "generating" ? "generating" : project.status === "clips_ready" ? "clips_ready" : project.status === "assembling" ? "assembling" : project.status === "done" ? "done" : project.status === "failed" && clips.length ? "failed" : "idle";
  return {
    status,
    // The reference images' addresses and the prompts stay on the server.
    plan: project.plan ? { ...project.plan, character: Boolean(project.plan.character), setting: Boolean(project.plan.setting) } : null,
    clips: clips.map((c) => ({
      number: c.number,
      seconds: c.seconds,
      sceneNumbers: c.sceneNumbers,
      status: c.status,
      attempts: c.attempts,
      error: c.error,
      finishedAt: c.finishedAt,
      tokens: c.tokens,
      usd: c.usd,
      hasVideo: Boolean(c.videoKey),
      videoUrl: c.videoKey ? `/api/creatives/video/${project.id}/clips/${c.number}?v=${encodeURIComponent(c.finishedAt ?? "")}` : null,
    })),
    final: project.final ? (({ key, ...rest }) => ({ ...rest, videoUrl: key ? `/api/creatives/video/${project.id}/final?v=${encodeURIComponent(rest.createdAt ?? "")}` : null }))(project.final) : null,
    spentUsd: Math.round(clips.reduce((t, c) => t + (c.usd ?? 0), 0) * 100) / 100,
    blocked: ["confirmed", "clips_ready", "done"].includes(project.status) ? blockedReason(project) : null,
    error: project.error,
  };
}

export { availableSeedanceModels, SEEDANCE_SPECS };
