import type { Task } from "@/types";

/** A running/queued task silent for longer than this was killed mid-run. */
export const STALE_TASK_MS = 6 * 60 * 1000;

export const STALE_TASK_MESSAGE =
  "This run stopped unexpectedly — please send your message again.";

export function isTaskStale(task: Task, now = Date.now()): boolean {
  if (task.status !== "running" && task.status !== "queued") return false;
  const updated = Date.parse(task.updated_at);
  if (!Number.isFinite(updated)) return false;
  return now - updated > STALE_TASK_MS;
}

/**
 * Task as sent to the browser: without the model transcript
 * (`agent_state.messages`), which can be large and is server-only.
 */
export function toPublicTask(task: Task): Task;
export function toPublicTask(task: Task | null): Task | null;
export function toPublicTask(task: Task | null): Task | null {
  if (!task?.agent_state || !("messages" in task.agent_state)) return task;
  const agentState = { ...task.agent_state };
  delete agentState.messages;
  return { ...task, agent_state: agentState };
}
