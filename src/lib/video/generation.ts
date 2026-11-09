import { getObjectStorage } from "@/lib/storage/r2";
import { logger } from "@/lib/observability/logger";
import { buildClipPrompt } from "@/lib/video/clip-prompt";
import type { ArkContent } from "@/lib/video/seedance";
import {
  arkCredentials,
  availableSeedanceModels,
  cancelVideoTask,
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
import { DEFAULT_FINISHING, type Checkpoint, type ClipState, type Finishing, type GenerationPlan, type GenerationView } from "@/lib/video/generation-types";
import { claimProjectLease, getProject, releaseProjectLease, updateProject, type VideoProject } from "@/lib/video/projects";
import { buildPlannedClipPrompt } from "@/lib/video/clip-prompt";
import {
  applyPlanDurations,
  brandBlockers,
  briefsFor,
  budgetFor,
  claimBlockers,
  clipsFor,
  continuityFor,
  MAX_REDESIGNS,
  nextCorrections,
  prepareCreative,
  recordAttempt,
  redesignClipScenes,
  reviewDownloadedClip,
  secondsToAdd,
  spentUsd,
} from "@/lib/video/pipeline";
import { hasCritical, type CreativePlan, type QaReport } from "@/lib/video/pipeline-types";

/** A reference image or clip address from ModelArk stops working after 24 hours; stop using one well before. */
const FRESH_MS = 20 * 60 * 60 * 1000;
const LEASE_MS = 45_000;
const HEAVY_LEASE_MS = 240_000;
const POLL_EVERY_MS = 8_000;
const MAX_ATTEMPTS = 2;

const fresh = (iso: string | null | undefined, now = Date.now()) => Boolean(iso) && now - Date.parse(iso!) < FRESH_MS;

/** Why a video cannot be made right now, or null. */
export function blockedReason(project: VideoProject): string | null {
  if (!project.chosen_script) return "Confirm a script first.";
  // Nothing is generated from an unverified brand: a wrong name or an invented logo is far costlier than a pause.
  const brand = brandBlockers(project.brand?.manifest);
  if (brand) return brand;
  const claims = claimBlockers(project.chosen_script, project.brand!.manifest!);
  if (claims) return claims;
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
export function buildPlan(project: VideoProject, finishing: Finishing = DEFAULT_FINISHING, checkpoint: Checkpoint = "after_first"): { plan: GenerationPlan; clips: ClipState[] } {
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
    checkpoint,
    budgetUsd: budgetFor(preview.estimatedUsd),
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

export async function startGeneration(projectId: string, finishing: Finishing = DEFAULT_FINISHING, checkpoint: Checkpoint = "after_first"): Promise<VideoProject> {
  const project = await getProject(projectId);
  if (!project) throw new Error("Video project not found");
  const { plan, clips } = buildPlan(project, finishing, checkpoint);
  return updateProject(projectId, { plan, clips, final: null, status: "generating", error: null });
}

/** A clip's request built from the creative plan: per-scene briefs, the references each scene needs, the speech text, and corrections. */
function buildPlannedClipRequest(project: VideoProject, plan: GenerationPlan, clips: ClipState[], clip: ClipState, now: number) {
  const script = project.chosen_script!;
  const creative = plan.creative as CreativePlan;
  const previous = clips[clip.number - 2];
  const cont = continuityFor(creative, script, clip, previous);
  const model = plan.model as SeedanceModelKey;
  const fits = previous && previous.status === "succeeded" && fresh(previous.finishedAt, now);
  const previousFrame = cont.continues && fits && previous!.lastFrameUrl ? previous!.lastFrameUrl : null;
  const previousVideo = plan.chainVideo && cont.sameSpeaker && fits && previous!.sourceVideoUrl ? previous!.sourceVideoUrl : null;

  // References, in the order the prompt names them: people, then places, then the previous frame; within the model's limit.
  const room = SEEDANCE_SPECS[model].maxImageRefs - (previousFrame ? 1 : 0);
  const people = cont.characterIds.map((id) => ({ id, url: plan.references?.characters[id]?.url ?? null })).filter((r): r is { id: string; url: string } => Boolean(r.url));
  const places = cont.environmentIds.map((id) => ({ id, url: plan.references?.environments[id]?.url ?? null })).filter((r): r is { id: string; url: string } => Boolean(r.url));
  const chosenPeople = people.slice(0, room);
  const chosenPlaces = places.slice(0, Math.max(room - chosenPeople.length, 0));

  const spoken: Record<number, { text: string; speaker: "on_camera" | "voiceover" | "none" }> = {};
  for (const s of script.scenes) {
    const line = plan.speech?.lines.find((l) => l.sceneNumber === s.number);
    if (line) spoken[s.number] = { text: line.spoken, speaker: s.speaker };
  }
  const nextClip = clips[clip.number];
  const nextContinues = Boolean(nextClip && (briefsFor(creative, nextClip)[0]?.entry.mode ?? "cut") === "continue_previous");
  const prompt = buildPlannedClipPrompt({
    scenes: briefsFor(creative, clip),
    spoken,
    characters: creative.characters,
    environments: creative.environments,
    style: script.style,
    clipNumber: clip.number,
    clipCount: clips.length,
    locale: project.inputs.locale,
    refs: { characterIds: chosenPeople.map((r) => r.id), environmentIds: chosenPlaces.map((r) => r.id), previousFrame: Boolean(previousFrame), previousVideo: Boolean(previousVideo) },
    corrections: clip.corrections ?? [],
    nextContinues,
  });
  const content: ArkContent[] = [{ type: "text", text: prompt }];
  for (const url of [...chosenPeople.map((r) => r.url), ...chosenPlaces.map((r) => r.url), previousFrame]) {
    if (url) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  }
  if (previousVideo) content.push({ type: "video_url", video_url: { url: previousVideo }, role: "reference_video" });
  return { prompt, content };
}

/** Everything needed to ask for one clip. */
export function buildClipRequest(project: VideoProject, plan: GenerationPlan, clips: ClipState[], clip: ClipState, now = Date.now()) {
  if (plan.creative) return buildPlannedClipRequest(project, plan, clips, clip, now);
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

export type StepResult = "working" | "done" | "failed" | "idle" | "paused";

/** True when this clip must be checked by the operator before the next one is paid for. */
export function needsReview(checkpoint: Checkpoint | undefined, clipNumber: number, clipCount: number): boolean {
  if (clipNumber >= clipCount) return false;
  if (checkpoint === "each") return true;
  if (checkpoint === "none") return false;
  return clipNumber === 1;
}

/** Make any reference image the next clip's scenes need and do not yet have (or have let go stale). Returns true when something was made. */
async function ensureReferences(project: VideoProject, plan: GenerationPlan, clips: ClipState[], clip: ClipState, now: number): Promise<{ made: boolean; stale: string | null }> {
  const creative = plan.creative!;
  const script = project.chosen_script!;
  const model = plan.model as SeedanceModelKey;
  const refs = (plan.references ??= { characters: {}, environments: {} });
  const cont = continuityFor(creative, script, clip, clips[clip.number - 2]);
  const wanted: Array<{ kind: "presenter" | "location"; id: string; description: string; store: Record<string, { url: string; key: string | null; createdAt: string }> }> = [];
  for (const id of cont.characterIds) {
    const description = creative.characters.find((c) => c.id === id)?.description;
    if (description) wanted.push({ kind: "presenter", id, description, store: refs.characters });
  }
  for (const id of cont.environmentIds) {
    const description = creative.environments.find((e) => e.id === id)?.description;
    if (description) wanted.push({ kind: "location", id, description, store: refs.environments });
  }
  // A reference that exists but has expired would no longer match the earlier clips: say so instead of drifting.
  const stale = wanted.find((w) => w.store[w.id] && !fresh(w.store[w.id]!.createdAt, now) && clip.number > 1);
  if (stale) return { made: false, stale: stale.id };
  let made = false;
  for (const w of wanted) {
    const existing = w.store[w.id];
    if (existing && fresh(existing.createdAt, now)) continue;
    const img = await createReferenceImage(model, w.kind, w.description);
    w.store[w.id] = { url: img.url, key: null, createdAt: new Date(now).toISOString() };
    made = true;
  }
  const firstPerson = Object.values(refs.characters)[0];
  const firstPlace = Object.values(refs.environments)[0];
  plan.character = firstPerson ?? null;
  plan.setting = firstPlace ?? null;
  return { made, stale: null };
}

/** The clip put back to waiting for another attempt (its rejected file is dropped; the review stays in its attempt log). */
function resetForAnotherAttempt(clip: ClipState): void {
  if (clip.videoKey) void getObjectStorage().delete(clip.videoKey).catch(() => undefined);
  Object.assign(clip, { status: "waiting" as const, taskId: null, attempts: 0, videoKey: null, lastFrameUrl: null, sourceVideoUrl: null, finishedAt: null, tokens: null, usd: null, prompt: null });
}

const top = (findings: Array<{ severity: string; message: string }>, n = 3) =>
  findings
    .filter((f) => f.severity !== "minor")
    .slice(0, n)
    .map((f) => f.message)
    .join(" ");

/**
 * One bounded step: plan the video, make a missing reference image, submit the next clip, check the
 * running one, or inspect a finished one. Safe to call again and again. The caller holds the lease.
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

  // 0. Before anything is paid for: the brand and claims are checked, speech is settled and a fresh creative plan is made and validated.
  // (A project made before the brand check existed has no manifest: it is blocked from starting and, if it is already part-way, carries on the way it began.)
  if (!plan.creative && project.brand?.manifest && clips.every((c) => c.status === "waiting" && c.attempts === 0)) {
    try {
      const prepared = await prepareCreative(project);
      plan.creative = prepared.creative;
      plan.speech = prepared.speech;
      plan.capabilities = prepared.capabilities;
      plan.references = { characters: {}, environments: {} };
      plan.character = null;
      plan.setting = null;
      // The plan derived each scene's length from its narration and action: the clips follow it.
      const rebuilt = clipsFor(prepared.script, model);
      const estimate = rebuilt.reduce((t, c, i) => t + estimateClipUsd(model, plan.resolution as VideoResolution, plan.ratio as "9:16", c.seconds, plan.chainVideo && i > 0 ? rebuilt[i - 1]!.seconds : 0), 0);
      plan.estimatedUsd = Math.round(estimate * 100) / 100;
      plan.budgetUsd = budgetFor(estimate);
      await save({ plan, chosen_script: prepared.script, clips: rebuilt });
      return "working";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await save({ status: "failed", error: message });
      return "failed";
    }
  }

  // 1. The clips, one after another: each opens from where the last one ended only when the plan says it continues.
  for (const clip of clips) {
    if (clip.status === "succeeded") continue;
    if (clip.status === "failed") return "failed";

    if (clip.status === "waiting") {
      const previous = clips[clip.number - 2];
      if (previous && previous.status !== "succeeded") return "working";

      if (plan.creative) {
        const refs = await ensureReferences(project, plan, clips, clip, now);
        if (refs.stale) {
          clip.status = "failed";
          clip.unresolved = true;
          clip.error = "The reference images for this video expired (they last 24 hours). Regenerate from clip 1 to keep the people and places the same.";
          await save({ clips, plan, status: "failed", error: clip.error });
          return "failed";
        }
        if (refs.made) {
          await save({ plan });
          return "working";
        }
      } else {
        // Projects made before the creative plan existed keep their original single presenter and location.
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
        if (clip.number > 1 && ((plan.character && !fresh(plan.character.createdAt, now)) || (plan.setting && !fresh(plan.setting.createdAt, now)))) {
          clip.status = "failed";
          clip.error = "The reference images for this video expired (they last 24 hours). Regenerate from clip 1 to keep the person the same.";
          await save({ clips, status: "failed", error: clip.error });
          return "failed";
        }
      }

      // Never start paying for a clip after the operator has stopped or paused the video.
      const latest = await getProject(projectId);
      if (!latest || latest.status !== "generating") return "idle";

      // Rejected attempts are paid for too: stop at the cap instead of retrying without limit.
      const estimate = estimateClipUsd(model, plan.resolution as VideoResolution, plan.ratio as "9:16", clip.seconds, plan.chainVideo && clip.number > 1 ? (clips[clip.number - 2]?.seconds ?? 0) : 0);
      if (plan.budgetUsd && spentUsd(clips) + estimate > plan.budgetUsd + 0.005) {
        clip.status = "failed";
        clip.unresolved = true;
        clip.error = `Stopped before clip ${clip.number}: another attempt would pass this video's cost cap of $${plan.budgetUsd.toFixed(2)} (already spent $${spentUsd(clips).toFixed(2)} including rejected attempts).`;
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
          seed: clip.attempts > 0 || (clip.qaAttempts ?? 0) > 0 ? Math.floor(Math.random() * 2_000_000_000) : undefined,
        });
        clip.status = "running";
        clip.taskId = task.id;
        clip.attempts += 1;
        clip.prompt = request.prompt;
        clip.error = null;
        clip.attemptLog = [...(clip.attemptLog ?? []), { attempt: (clip.qaAttempts ?? 0) + 1, taskId: task.id, prompt: request.prompt, corrections: clip.corrections ?? [], report: null, usd: null, startedAt: new Date(now).toISOString() }];
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

    if (clip.status === "reviewing") {
      const attempt = (clip.qaAttempts ?? 0) + 1;
      let report: QaReport;
      try {
        report = await reviewDownloadedClip(project, plan, clip);
      } catch (error) {
        // A review that could not run is never an approval.
        const message = error instanceof Error ? error.message : String(error);
        report = {
          subject: { kind: "clip", clip: clip.number },
          attempt,
          checkedAt: new Date(now).toISOString(),
          verdict: "unresolved",
          findings: [{ code: "review_failed", severity: "critical", category: "technical", message: `The clip could not be inspected (${message}).`, evidence: message, correction: "", source: "rule" }],
          checks: [],
          framesInspected: 0,
          limitations: ["The review could not run."],
        };
      }
      // A critical finding can never be approved, whatever the verdict says.
      if (report.verdict === "pass" && hasCritical(report.findings)) report = { ...report, verdict: "unresolved" };
      clip.qa = report;
      const log = clip.attemptLog ?? [];
      const last = log[log.length - 1];
      const corrections = nextCorrections(report.findings);
      if (last) log[log.length - 1] = recordAttempt(clip, report, clip.usd, last.corrections, last.startedAt);
      clip.attemptLog = log;

      if (report.verdict === "pass") {
        clip.status = "succeeded";
        clip.error = null;
        clip.corrections = [];
        clip.unresolved = false;
        if (needsReview(plan.checkpoint, clip.number, clips.length) && !clip.approved) {
          // Wait here: the operator checks this clip before the next one is paid for.
          await save({ clips, status: "paused" });
          return "paused";
        }
        await save({ clips });
        continue;
      }

      if (report.verdict === "retry") {
        const add = secondsToAdd(report.findings, clip, model);
        const extra: Partial<VideoProject> = {};
        if (add > 0 && plan.creative) {
          // The speech ran past the clip: give the last scene of the clip the seconds it needs, in the plan and the script alike.
          const lastScene = Math.max(...clip.sceneNumbers);
          clip.seconds += add;
          plan.creative.scenes = plan.creative.scenes.map((s) => (s.number === lastScene ? { ...s, seconds: s.seconds + add } : s));
          extra.chosen_script = applyPlanDurations(script, plan.creative);
        }
        resetForAnotherAttempt(clip);
        clip.qaAttempts = attempt;
        clip.corrections = corrections;
        clip.error = `Attempt ${attempt} was not approved (${top(report.findings)}). Trying again with these corrections.`;
        await save({ clips, plan, ...extra });
        return "working";
      }

      if (report.verdict === "redesign" && plan.creative && (clip.redesigns ?? 0) < MAX_REDESIGNS) {
        try {
          plan.creative = await redesignClipScenes(project, plan, clip, report.findings);
          resetForAnotherAttempt(clip);
          clip.redesigns = (clip.redesigns ?? 0) + 1;
          clip.qaAttempts = 0;
          clip.corrections = [];
          clip.error = `The same problem kept coming back (${top(report.findings)}), so the shot was redesigned and is being made again.`;
          await save({ clips, plan });
          return "working";
        } catch (error) {
          logger.warn("Could not redesign a failing shot", { projectId, clip: clip.number, error: error instanceof Error ? error.message : String(error) });
        }
      }

      // Nothing more can be done automatically: say exactly what is wrong instead of shipping it.
      clip.status = "failed";
      clip.unresolved = true;
      clip.error = `Clip ${clip.number} could not be approved after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${top(report.findings) || report.limitations.join(" ") || "the review could not approve it"}`;
      await save({ clips, status: "failed", error: clip.error });
      return "failed";
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
      clip.error = null;
      const log = clip.attemptLog ?? [];
      if (log.length) log[log.length - 1] = { ...log[log.length - 1]!, usd: clip.usd };
      clip.attemptLog = log;

      if (plan.creative) {
        // The clip counts as made only once it has been inspected.
        clip.status = "reviewing";
        await save({ clips });
        return "working";
      }
      clip.status = "succeeded";
      if (needsReview(plan.checkpoint, clip.number, clips.length) && !clip.approved) {
        // Wait here: the operator checks this clip before the next one is paid for.
        await save({ clips, status: "paused" });
        return "paused";
      }
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
  // Planning and inspecting a clip take longer than submitting or polling one, so they hold the lease longer.
  const peek = await getProject(projectId);
  const heavy = Boolean(peek?.plan && (!peek.plan.creative || peek.clips?.some((c) => c.status === "reviewing")));
  if (!(await claimProjectLease(projectId, heavy ? HEAVY_LEASE_MS : LEASE_MS))) return "idle";
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
    if (last === "failed" || last === "paused") return last;
    if (last === "idle") {
      const p = await getProject(projectId);
      if (!p || p.status !== "generating") return last;
    }
    await sleep(POLL_EVERY_MS);
  }
  return last;
}

/**
 * Stop making the video. Clips already made are kept. A clip that is being made is cancelled if
 * BytePlus allows it (a queued task can be; one already running may still finish and be charged).
 */
export async function stopGeneration(projectId: string): Promise<VideoProject> {
  const project = await getProject(projectId);
  if (!project?.plan || !project.clips) throw new Error("There is nothing to stop.");
  const model = project.plan.model as SeedanceModelKey;
  const clips = await Promise.all(
    project.clips.map(async (c) => {
      if (c.status !== "running") return c;
      if (c.taskId) await cancelVideoTask(model, c.taskId).catch(() => undefined);
      return { ...c, status: "waiting" as const, taskId: null, attempts: 0, error: "Stopped by you." };
    }),
  );
  return updateProject(projectId, { clips, status: "stopped", error: null });
}

/** Carry on after a pause (the clip just checked is approved) or after a stop. */
export async function continueGeneration(projectId: string): Promise<VideoProject> {
  const project = await getProject(projectId);
  if (!project?.plan || !project.clips) throw new Error("There is nothing to continue.");
  if (project.status !== "paused" && project.status !== "stopped") return project;
  // Everything made so far has been looked at, so it does not pause again on the same clips.
  const clips = project.clips.map((c) => (c.status === "succeeded" ? { ...c, approved: true } : c));
  return updateProject(projectId, { clips, status: "generating", error: null });
}

/**
 * Make clip `fromClip` and every clip after it again (each one opens from where the one before it
 * ended, so a change in the middle changes what follows). Earlier clips are kept.
 */
export async function regenerateFrom(projectId: string, fromClip: number, options: { replan?: boolean } = {}): Promise<VideoProject> {
  const project = await getProject(projectId);
  if (!project?.plan || !project.clips) throw new Error("There is no video to regenerate yet.");
  const storage = getObjectStorage();
  const clips = project.clips.map((c) => {
    if (c.number < fromClip) return c;
    if (c.videoKey) void storage.delete(c.videoKey).catch(() => undefined);
    // The attempt log stays: what a rejected take cost and why it was rejected is part of the video's history.
    return { ...c, approved: false, status: "waiting" as const, taskId: null, attempts: 0, error: null, videoKey: null, lastFrameUrl: null, sourceVideoUrl: null, finishedAt: null, tokens: null, usd: null, prompt: null, qa: null, corrections: [], qaAttempts: 0, redesigns: 0, unresolved: false };
  });
  // From clip 1 the references are made fresh too, so a new take starts from new, matching people and places.
  const replan = Boolean(options.replan) && fromClip === 1;
  const plan: GenerationPlan = {
    ...project.plan,
    character: fromClip === 1 ? null : project.plan.character,
    setting: fromClip === 1 ? null : project.plan.setting,
    references: fromClip === 1 ? { characters: {}, environments: {} } : project.plan.references,
    // A new plan is made from scratch only when asked for; otherwise the approved plan is kept and only the shots are made again.
    creative: replan ? null : project.plan.creative,
    speech: replan ? null : project.plan.speech,
  };
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
  const status = project.status === "generating" ? "generating" : project.status === "clips_ready" ? "clips_ready" : project.status === "paused" ? "paused" : project.status === "stopped" ? "stopped" : project.status === "assembling" ? "assembling" : project.status === "done" ? "done" : project.status === "failed" && clips.length ? "failed" : "idle";
  return {
    status,
    // The reference images' addresses and the prompts stay on the server.
    plan: project.plan
      ? (({ speech, ...rest }) => ({
          ...rest,
          references: undefined,
          character: Boolean(project.plan!.character),
          setting: Boolean(project.plan!.setting),
          speech: speech ? { uncertain: speech.lines.flatMap((l) => l.uncertain), terms: speech.lexicon.entries.length } : null,
        }))(project.plan)
      : null,
    clips: clips.map((c) => ({
      number: c.number,
      seconds: c.seconds,
      sceneNumbers: c.sceneNumbers,
      status: c.status,
      attempts: c.attempts,
      attemptCount: c.attemptLog?.length ?? 0,
      qa: c.qa ?? null,
      corrections: c.corrections,
      qaAttempts: c.qaAttempts,
      redesigns: c.redesigns,
      unresolved: c.unresolved,
      approved: c.approved,
      error: c.error,
      finishedAt: c.finishedAt,
      tokens: c.tokens,
      usd: c.usd,
      hasVideo: Boolean(c.videoKey),
      videoUrl: c.videoKey ? `/api/creatives/video/${project.id}/clips/${c.number}?v=${encodeURIComponent(c.finishedAt ?? "")}` : null,
    })),
    reviewClip: project.status === "paused" ? (clips.filter((c) => c.status === "succeeded").at(-1)?.number ?? null) : null,
    remainingUsd: (() => {
      const plan = project.plan;
      if (!plan) return 0;
      const left = clips.filter((c) => c.status !== "succeeded");
      return Math.round(left.reduce((t, c) => t + estimateClipUsd(plan.model as SeedanceModelKey, plan.resolution as VideoResolution, plan.ratio as "9:16", c.seconds, plan.chainVideo && c.number > 1 ? (clips[c.number - 2]?.seconds ?? 0) : 0), 0) * 100) / 100;
    })(),
    final: project.final
      ? (({ key, reviewKey, subtitles, ...rest }) => {
          const v = encodeURIComponent(rest.createdAt ?? "");
          const base = `/api/creatives/video/${project.id}/final`;
          return {
            ...rest,
            videoUrl: key && rest.state === "done" ? `${base}?v=${v}` : null,
            reviewUrl: reviewKey ? `${base}?review=1&v=${v}` : null,
            srtUrl: subtitles && rest.state === "done" ? `${base}?subtitles=srt&v=${v}` : null,
            vttUrl: subtitles && rest.state === "done" ? `${base}?subtitles=vtt&v=${v}` : null,
            subtitleCues: subtitles?.cues ?? 0,
          };
        })(project.final)
      : null,
    spentUsd: spentUsd(clips),
    blocked: ["confirmed", "clips_ready", "done"].includes(project.status) ? blockedReason(project) : null,
    error: project.error,
  };
}

export { availableSeedanceModels, SEEDANCE_SPECS };
