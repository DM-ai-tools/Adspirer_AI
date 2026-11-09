import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logger } from "@/lib/observability/logger";
import { getObjectStorage } from "@/lib/storage/r2";
import { providerCapabilities } from "@/lib/video/capabilities";
import { effectiveClaims } from "@/lib/video/claims";
import { runFfmpeg } from "@/lib/video/ffmpeg";
import { transcribeWords } from "@/lib/video/asr";
import { applyLexicon, buildLexicon, SEEDANCE_SPEECH_PROVIDER } from "@/lib/video/pronunciation";
import { compareSpokenToExpected } from "@/lib/video/subtitles";
import { planCreative, redesignScene, type PlanInput } from "@/lib/video/scene-plan";
import { correctionLines, createVisionReviewer, decideClip, redesignReasons, reviewClip } from "@/lib/video/clip-qa";
import { estimateClipUsd, SEEDANCE_SPECS, splitIntoClips, type SeedanceModelKey, type VideoResolution } from "@/lib/video/seedance";
import { unsourcedFigures, type VideoScript } from "@/lib/video/script";
import { withTimes } from "@/lib/video/overlays";
import { manifestReady, type ApprovedClaim, type BrandManifest, type ClipAttemptRecord, type CreativePlan, type QaFinding, type QaReport, type SceneBrief, type SpeechLine } from "@/lib/video/pipeline-types";
import type { ClipState, GenerationPlan } from "@/lib/video/generation-types";
import type { VideoProject } from "@/lib/video/projects";

/** A clip may be made this many times in all (the first try and the corrected tries) before it is redesigned or reported. */
export const MAX_QA_ATTEMPTS = 3;
/** A shot that keeps failing the same way is redesigned this many times before it is reported as unresolved. */
export const MAX_REDESIGNS = 1;
/** Rejected clips are paid for: the whole video may cost this many times the estimate (a clip can be made about one and a half times over) before generation stops. */
export const RETRY_BUDGET_FACTOR = 2.5;

export const budgetFor = (estimatedUsd: number) => Math.round(estimatedUsd * RETRY_BUDGET_FACTOR * 100) / 100;

/** Everything that has been paid for on this video's clips, including attempts a review rejected. */
export function spentUsd(clips: ClipState[]): number {
  const total = clips.reduce((t, c) => {
    const logged = (c.attemptLog ?? []).reduce((a, r) => a + (r.usd ?? 0), 0);
    return t + (logged > 0 ? logged : (c.usd ?? 0));
  }, 0);
  return Math.round(total * 100) / 100;
}

/** Why the brand is not ready, in the operator's words, or null. */
export function brandBlockers(manifest: BrandManifest | null | undefined): string | null {
  if (!manifest) return "The brand has not been checked yet. Check the brand first so the video uses the verified company name and logo.";
  if (manifestReady(manifest)) return null;
  const blocking = manifest.issues.filter((i) => i.severity === "blocking");
  return `The brand check found ${blocking.length === 1 ? "a problem" : `${blocking.length} problems`} to resolve first: ${blocking.map((i) => i.message).join(" ")}`;
}

/** Figures in the script that no approved claim backs, as one sentence, or null. */
export function claimBlockers(script: VideoScript, manifest: BrandManifest, claims: ApprovedClaim[] = manifest.claims): string | null {
  const open = unsourcedFigures(script, claims);
  if (!open.length) return null;
  return `Some figures in the script have no recorded source: ${open.slice(0, 6).map((o) => `"${o.figure}" (${o.where})`).join(", ")}. Add the source (a stat, an image, the offer details) or edit the script.`;
}

export function planInputFor(project: VideoProject, script: VideoScript, manifest: BrandManifest): PlanInput {
  const capabilities = providerCapabilities();
  return {
    brandName: manifest.name.value ?? "",
    product: manifest.offer.value ?? script.title,
    audience: manifest.audience.value ?? "",
    offer: manifest.offer.value ?? script.title,
    platform: `Meta Reels and Stories, ${project.inputs.format} vertical video, watched mostly muted`,
    objective: `${script.angle.name} (${script.angle.stage}): ${script.pain}`,
    targetSeconds: project.inputs.targetSeconds,
    locale: project.inputs.locale,
    script: {
      style: script.style,
      character: script.character,
      setting: script.setting,
      scenes: script.scenes.map((s) => ({ number: s.number, line: s.line, seconds: s.seconds, speaker: s.speaker, keywords: s.keywords, stat: s.stat, assetId: s.assetId, visual: s.visual, camera: s.camera, sound: s.sound })),
    },
    assets: project.assets.map((a) => ({ id: a.id, name: a.name, summary: a.analysis?.summary ?? a.caption, stats: a.analysis?.stats ?? [] })),
    claims: effectiveClaims(project.brand),
    capabilities,
    maxSeconds: 60,
  };
}

/** The script with each scene as long as the creative plan says (it derived the length from narration and action). */
export function applyPlanDurations(script: VideoScript, plan: CreativePlan): VideoScript {
  const seconds = new Map(plan.scenes.map((s) => [s.number, Math.max(2, Math.round(s.seconds))]));
  const timed = withTimes(script.scenes.map((s) => ({ ...s, seconds: seconds.get(s.number) ?? s.seconds })));
  const total = timed.length ? timed[timed.length - 1]!.end : 0;
  return { ...script, scenes: timed, durationSeconds: total };
}

/** The clips for a script, grouped on scene boundaries within the model's longest request. */
export function clipsFor(script: VideoScript, model: SeedanceModelKey): ClipState[] {
  return splitIntoClips(script.scenes.map((s) => ({ number: s.number, seconds: s.seconds })), SEEDANCE_SPECS[model].maxSeconds).map((c, i) => ({
    number: i + 1,
    seconds: c.seconds,
    sceneNumbers: c.sceneNumbers,
    status: "waiting" as const,
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
}

export type PreparedCreative = { creative: CreativePlan; speech: NonNullable<GenerationPlan["speech"]>; script: VideoScript; capabilities: ReturnType<typeof providerCapabilities> };

/**
 * Everything decided before a single clip is paid for: the brand and the claims are checked, how
 * each term is said is settled, and a fresh creative plan is made and validated. Throws with a
 * plain explanation when something blocks the video.
 */
export async function prepareCreative(project: VideoProject): Promise<PreparedCreative> {
  const script = project.chosen_script;
  if (!script) throw new Error("Confirm a script first.");
  const manifest = project.brand?.manifest ?? null;
  const brand = brandBlockers(manifest);
  if (brand) throw new Error(brand);
  const claims = claimBlockers(script, manifest!, effectiveClaims(project.brand));
  if (claims) throw new Error(claims);

  const capabilities = providerCapabilities();
  const lexicon = await buildLexicon({
    lines: script.scenes.filter((s) => s.line.trim()).map((s) => ({ sceneNumber: s.number, text: s.line })),
    brandName: manifest!.name.value,
    locale: project.inputs.locale,
    overrides: project.inputs.pronunciations ?? {},
    campaign: `${manifest!.offer.value ?? script.title}. ${manifest!.audience.value ?? ""}`.trim(),
    provider: SEEDANCE_SPEECH_PROVIDER,
  });
  const lines: SpeechLine[] = script.scenes.filter((s) => s.line.trim()).map((s) => applyLexicon(s.number, s.line, lexicon));

  const input = planInputFor(project, script, manifest!);
  const creative = await planCreative(input);
  if (!creative.validation.ok) {
    const errors = creative.validation.issues.filter((i) => i.severity === "error");
    throw new Error(`The creative plan did not pass its checks, so nothing was generated: ${errors.slice(0, 5).map((i) => i.message).join(" ")}`);
  }
  return { creative, speech: { lexicon, lines }, script: applyPlanDurations(script, creative), capabilities };
}

// ------------------------------------------------------------------ continuity

export function briefsFor(plan: CreativePlan, clip: Pick<ClipState, "sceneNumbers">): SceneBrief[] {
  return clip.sceneNumbers.map((n) => plan.scenes.find((s) => s.number === n)).filter((s): s is SceneBrief => Boolean(s));
}

/**
 * What a clip is given to hold the look together: the people and places it shows, the previous
 * clip's last frame ONLY when this clip opens as a continuation of it (an unrelated scene is never
 * forced onto the previous ending), and the previous clip as a voice reference only when the same
 * person speaks in both.
 */
export function continuityFor(
  plan: CreativePlan,
  script: VideoScript,
  clip: Pick<ClipState, "sceneNumbers">,
  previous: Pick<ClipState, "sceneNumbers"> | undefined,
): { characterIds: string[]; environmentIds: string[]; continues: boolean; sameSpeaker: boolean } {
  const briefs = briefsFor(plan, clip);
  const first = briefs[0];
  const prevBriefs = previous ? briefsFor(plan, previous) : [];
  const continues = Boolean(first && previous && first.entry.mode === "continue_previous");
  const speaks = (b: SceneBrief) => script.scenes.find((s) => s.number === b.number)?.speaker === "on_camera" && Boolean(b.characterId);
  const speakerIds = new Set(briefs.filter(speaks).map((b) => b.characterId!));
  const prevSpeakerIds = new Set(prevBriefs.filter(speaks).map((b) => b.characterId!));
  const sameSpeaker = [...speakerIds].some((id) => prevSpeakerIds.has(id));
  const characterIds = [...new Set(briefs.map((b) => b.characterId).filter((id): id is string => Boolean(id)))];
  const environmentIds = [...new Set(briefs.map((b) => b.environmentId))];
  return { characterIds, environmentIds, continues, sameSpeaker };
}

// ------------------------------------------------------------------ the review of one clip

const wavOf = async (file: string, dir: string) => {
  const wav = path.join(dir, "speech.wav");
  await runFfmpeg(["-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  return wav;
};

async function referenceBytes(url: string | null | undefined): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Where each scene of a clip falls inside the clip, scaled to the clip's real length. */
export function windowsInClip(briefs: SceneBrief[], plannedSeconds: number, actualSeconds: number): Array<{ number: number; start: number; end: number }> {
  const factor = plannedSeconds > 0 ? actualSeconds / plannedSeconds : 1;
  let cursor = 0;
  return briefs.map((b) => {
    const start = cursor * factor;
    cursor += b.seconds;
    return { number: b.number, start, end: cursor * factor };
  });
}

export type ClipReview = { report: QaReport; findings: QaFinding[] };

/**
 * Inspect a downloaded clip over time: technical checks, sampled frames read by a vision model
 * (faces, hands, stray text and invented logos), and the speech against the transcript. The verdict
 * comes from the findings, the attempts used and the money left.
 */
export async function reviewDownloadedClip(project: VideoProject, plan: GenerationPlan, clip: ClipState, deps: { now?: () => string } = {}): Promise<QaReport> {
  const creative = plan.creative!;
  const storage = getObjectStorage();
  const bytes = clip.videoKey ? await storage.get(clip.videoKey) : null;
  if (!bytes) throw new Error(`Clip ${clip.number} is missing from storage.`);
  const dir = await mkdtemp(path.join(os.tmpdir(), "clipqa-"));
  try {
    const file = path.join(dir, `clip-${clip.number}.mp4`);
    await writeFile(file, bytes);
    const briefs = briefsFor(creative, clip);
    const script = project.chosen_script!;
    const speech = (plan.speech?.lines ?? []).filter((l) => clip.sceneNumbers.includes(l.sceneNumber));
    const expectsSpeech = speech.length > 0;

    let asr = null as Awaited<ReturnType<typeof transcribeWords>>;
    if (expectsSpeech) {
      try {
        asr = await transcribeWords(await (await import("node:fs/promises")).readFile(await wavOf(file, dir)));
      } catch (error) {
        logger.warn("Clip review: speech could not be transcribed", { clip: clip.number, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const characterId = briefs.map((b) => b.characterId).find((id): id is string => Boolean(id)) ?? null;
    const character = characterId ? creative.characters.find((c) => c.id === characterId) : undefined;
    const reference = characterId ? await referenceBytes(plan.references?.characters[characterId]?.url ?? plan.character?.url) : null;
    const attempt = (clip.qaAttempts ?? 0) + 1;
    const reviewer = createVisionReviewer();

    const base = await reviewClip(
      { file, clip: clip.number, attempt, scenes: briefs, characterDescription: character?.description ?? null, referenceImage: reference, expectedSeconds: clip.seconds, expectsSpeech, speech: [], asr, requireVision: true, workDir: dir },
      { reviewer },
    );
    const findings = [...base.findings];
    const checks = [...base.checks];
    const limitations = [...base.limitations];

    if (expectsSpeech) {
      const actual = base.checks.find((c) => /length|duration/i.test(c.name))?.detail.match(/([\d.]+)s/)?.[1];
      const seconds = actual ? Number(actual) : clip.seconds;
      const spoke = compareSpokenToExpected(speech, asr, windowsInClip(briefs, clip.seconds, seconds));
      findings.push(...spoke.findings);
      checks.push(...spoke.checks);
      if (!asr) limitations.push("Speech was not transcribed (no OPENAI_API_KEY or the call failed), so what was said could not be checked against the script.");
    }

    // A dead or wrong mouth in a scene where nobody is meant to speak is the vision reviewer's to flag; the rubric asks for it.
    void script;

    const attemptsUsed = attempt;
    const estimate = estimateClipUsd(plan.model as SeedanceModelKey, plan.resolution as VideoResolution, plan.ratio as "9:16", clip.seconds);
    const previousCodes = (clip.attemptLog ?? []).flatMap((r) => r.report?.findings.filter((f) => f.severity !== "minor").map((f) => f.code) ?? []);
    const decision = decideClip(findings, {
      attempt: attemptsUsed,
      maxAttempts: MAX_QA_ATTEMPTS,
      spentUsd: spentUsd([...(project.clips ?? []).filter((c) => c.number !== clip.number), { ...clip }]),
      budgetUsd: plan.budgetUsd ?? Number.POSITIVE_INFINITY,
      nextAttemptUsd: estimate,
      visionAvailable: Boolean(reviewer),
      requireVision: true,
      previousCodes,
    });
    return { ...base, attempt, verdict: decision.verdict, findings, checks, limitations, checkedAt: (deps.now ?? (() => new Date().toISOString()))() };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Seconds to add to a clip whose speech was cut off or ran past its end, within what the model allows. */
export function secondsToAdd(findings: QaFinding[], clip: Pick<ClipState, "seconds">, model: SeedanceModelKey): number {
  const clipped = findings.some((f) => f.category === "speech" && f.severity !== "minor" && /cut off|clipp|runs? (past|over)|truncat|ends? (abruptly|mid)|missing (the )?(last|final|end)/i.test(`${f.message} ${f.evidence}`));
  if (!clipped) return 0;
  return Math.max(0, Math.min(2, SEEDANCE_SPECS[model].maxSeconds - clip.seconds));
}

/** What a rejected attempt leaves behind: the review, kept so the failure can be explained later. */
export function recordAttempt(clip: ClipState, report: QaReport, usd: number | null, corrections: string[], startedAt: string): ClipAttemptRecord {
  return { attempt: report.attempt, taskId: clip.taskId, prompt: clip.prompt, corrections, report, usd, startedAt };
}

/** Targeted corrections for the next attempt, from the findings of the last one. */
export function nextCorrections(findings: QaFinding[]): string[] {
  return correctionLines(findings.filter((f) => f.severity !== "minor"));
}

/** Redesign the shots in a clip that keeps failing the same way: a different framing, action or method, same narration and length. */
export async function redesignClipScenes(project: VideoProject, plan: GenerationPlan, clip: ClipState, findings: QaFinding[]): Promise<CreativePlan> {
  let creative = plan.creative!;
  const script = project.chosen_script!;
  const manifest = project.brand!.manifest!;
  const input = planInputFor(project, script, manifest);
  const briefs = briefsFor(creative, clip);
  let cursor = 0;
  const targets = new Set<number>();
  for (const b of briefs) {
    const from = cursor;
    cursor += b.seconds;
    if (findings.some((f) => f.severity !== "minor" && (f.atSeconds === undefined || (f.atSeconds >= from && f.atSeconds < cursor)))) targets.add(b.number);
  }
  if (!targets.size && briefs[0]) targets.add(briefs[0].number);
  const reasons = redesignReasons(findings);
  for (const n of targets) creative = await redesignScene(input, creative, n, reasons);
  return creative;
}
