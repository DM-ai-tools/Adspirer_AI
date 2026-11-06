/**
 * Progress of writing the scripts, shown as a bar with an estimate.
 *
 * The server records which stage it is in (a real signal). Inside a stage the model call has no
 * finer progress to report, so the bar creeps toward the next stage using that stage's typical
 * duration, and never reaches it until the server says the stage is done. Pure, so the browser
 * and the tests share it.
 */

export type ScriptStage = "reading" | "understanding" | "writing" | "verifying" | "done";

export const SCRIPT_STAGES: Array<{ key: Exclude<ScriptStage, "done">; label: string; from: number; to: number; typicalSeconds: number }> = [
  { key: "reading", label: "Reading your website and images", from: 0, to: 25, typicalSeconds: 15 },
  { key: "understanding", label: "Working out the audience, pains and proof", from: 25, to: 40, typicalSeconds: 12 },
  { key: "writing", label: "Writing three scripts, each with its own angle", from: 40, to: 85, typicalSeconds: 40 },
  { key: "verifying", label: "Verifying facts, tone and timing, and fixing weak scenes", from: 85, to: 98, typicalSeconds: 25 },
];

export type ScriptProgress = {
  stage: ScriptStage;
  /** When the whole job started, and when the current stage did (ISO). */
  startedAt: string;
  stageStartedAt: string;
};

export function initialProgress(now = new Date()): ScriptProgress {
  const t = now.toISOString();
  return { stage: "reading", startedAt: t, stageStartedAt: t };
}

export function advanceProgress(previous: ScriptProgress | null, stage: ScriptStage, now = new Date()): ScriptProgress {
  const t = now.toISOString();
  return { stage, startedAt: previous?.startedAt ?? t, stageStartedAt: t };
}

export type ProgressView = { percent: number; label: string; secondsLeft: number | null; slow: boolean };

/** What to show right now: the percentage, the stage's label, and about how long is left. */
export function viewProgress(progress: ScriptProgress | null, now = Date.now()): ProgressView {
  if (!progress) return { percent: 2, label: "Starting…", secondsLeft: null, slow: false };
  if (progress.stage === "done") return { percent: 100, label: "Scripts ready", secondsLeft: 0, slow: false };
  const index = SCRIPT_STAGES.findIndex((s) => s.key === progress.stage);
  const stage = SCRIPT_STAGES[Math.max(index, 0)]!;
  const inStage = Math.max(0, (now - Date.parse(progress.stageStartedAt)) / 1000);
  // Creep through at most 92% of the stage's span, so the bar never claims a stage is finished early.
  const share = Math.min(inStage / stage.typicalSeconds, 0.92);
  const percent = Math.round(stage.from + (stage.to - stage.from) * share);
  const laterSeconds = SCRIPT_STAGES.slice(Math.max(index, 0) + 1).reduce((t, s) => t + s.typicalSeconds, 0);
  const left = Math.max(stage.typicalSeconds - inStage, 0) + laterSeconds;
  const slow = inStage > stage.typicalSeconds * 1.6;
  return { percent, label: stage.label, secondsLeft: slow ? null : Math.round(left), slow };
}
