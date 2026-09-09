import type { Message, Task, TaskStatus } from "@/types";
import {
  describeInteractivePayloads,
  GENERIC_FALLBACK_REPLY,
} from "@/lib/agent/reply-format";

const TERMINAL_TASK: TaskStatus[] = [
  "done",
  "error",
  "waiting_approval",
  "cancelled",
];

function isFillerContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  if (trimmed === GENERIC_FALLBACK_REPLY) return true;
  // Live status lines look like `_Fetching account overview…_`
  if (/^_[^_\n]+_$/.test(trimmed)) return true;
  return false;
}

/** Never show the empty-turn sign-off when interactive UI is on screen. */
export function resolveAssistantDisplay(
  content: string,
  ui: Record<string, unknown> | null | undefined,
): string {
  const trimmed = content.trim();
  if (trimmed && trimmed !== GENERIC_FALLBACK_REPLY) return content;
  return describeInteractivePayloads(ui ?? {}) ?? content;
}

/**
 * A stream that dropped before `done`, or a reload mid-run, can leave
 * `streaming: true` on an assistant row forever. Reconcile against the linked
 * task so the bubble matches what actually happened server-side.
 *
 * Critical: only the message that belongs to `task` may take content from
 * `task.agent_state.summary`. Applying one task summary to every assistant
 * row made older chat history all show the latest reply after reload.
 */
export function reconcileAssistantMessage(
  message: Message,
  task: Task | null,
): Message {
  if (message.role !== "assistant" || !task) return message;

  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const messageTaskId =
    typeof meta.taskId === "string" ? meta.taskId : null;

  // Never rewrite history for a different turn.
  if (messageTaskId && messageTaskId !== task.id) {
    return message;
  }
  // Orphan rows without a taskId: only touch while still marked streaming.
  if (!messageTaskId && !meta.streaming) {
    return message;
  }

  const taskUi =
    task.agent_state?.ui && typeof task.agent_state.ui === "object"
      ? (task.agent_state.ui as Record<string, unknown>)
      : null;
  const messageUi =
    meta.ui && typeof meta.ui === "object"
      ? (meta.ui as Record<string, unknown>)
      : null;
  const ui = messageUi ?? taskUi;

  const taskSummary =
    typeof task.agent_state?.summary === "string"
      ? task.agent_state.summary.trim()
      : "";
  const streaming = Boolean(meta.streaming);
  const taskTerminal = TERMINAL_TASK.includes(task.status);
  const taskRunning =
    task.status === "running" || task.status === "queued";

  const buildMeta = (overrides: Record<string, unknown> = {}) => ({
    ...meta,
    taskId: messageTaskId ?? task.id,
    ui: ui ?? meta.ui ?? null,
    pendingApprovalId:
      typeof task.agent_state?.pending_approval_id === "string"
        ? task.agent_state.pending_approval_id
        : (meta.pendingApprovalId ?? null),
    pendingApprovalIds: Array.isArray(task.agent_state?.pending_approval_ids)
      ? task.agent_state.pending_approval_ids
      : (meta.pendingApprovalIds ?? null),
    isReport: Boolean(task.agent_state?.report ?? meta.isReport),
    reportTitle:
      task.agent_state?.report &&
      typeof (task.agent_state.report as { title?: unknown }).title === "string"
        ? (task.agent_state.report as { title: string }).title
        : ((meta.reportTitle as string | null | undefined) ?? null),
    ...overrides,
  });

  if (streaming && taskRunning && taskSummary) {
    return {
      ...message,
      content: resolveAssistantDisplay(taskSummary, ui),
      metadata: buildMeta({
        streaming: true,
        status: task.status,
        phase: task.agent_state?.phase ?? meta.phase,
        label: task.agent_state?.statusLabel ?? meta.label,
      }),
    };
  }

  if (streaming && taskTerminal) {
    const nextContent = taskSummary
      ? resolveAssistantDisplay(taskSummary, ui)
      : resolveAssistantDisplay(message.content, ui);
    return {
      ...message,
      content: nextContent || message.content,
      metadata: buildMeta({
        streaming: false,
        liveStatus: false,
        status: task.status,
        phase: task.agent_state?.phase ?? meta.phase,
        label: task.agent_state?.statusLabel ?? meta.label,
      }),
    };
  }

  // Finished rows: keep stored content. Only fill filler / attach missing UI.
  if (!streaming) {
    const needsContentFill = isFillerContent(message.content) && Boolean(taskSummary);
    const needsUi = Boolean(ui && !messageUi && taskUi);
    if (!needsContentFill && !needsUi) {
      return message;
    }
    return {
      ...message,
      content: needsContentFill
        ? resolveAssistantDisplay(taskSummary, ui)
        : resolveAssistantDisplay(message.content, ui),
      metadata: buildMeta(),
    };
  }

  return message;
}

export function reconcileConversationMessages(
  messages: Message[],
  task: Task | null,
): Message[] {
  if (!task) return messages;
  return messages.map((m) => reconcileAssistantMessage(m, task));
}
