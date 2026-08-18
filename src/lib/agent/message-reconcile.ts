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
 */
export function reconcileAssistantMessage(
  message: Message,
  task: Task | null,
): Message {
  if (message.role !== "assistant") return message;

  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const taskId =
    typeof meta.taskId === "string"
      ? meta.taskId
      : task?.id ?? null;

  const taskUi =
    task?.agent_state?.ui && typeof task.agent_state.ui === "object"
      ? (task.agent_state.ui as Record<string, unknown>)
      : null;
  const messageUi =
    meta.ui && typeof meta.ui === "object"
      ? (meta.ui as Record<string, unknown>)
      : null;
  const ui = taskUi ?? messageUi;

  const taskSummary =
    typeof task?.agent_state?.summary === "string"
      ? task.agent_state.summary.trim()
      : "";
  const content = resolveAssistantDisplay(message.content, ui);
  const resolvedContent = taskSummary
    ? resolveAssistantDisplay(taskSummary, ui)
    : content;

  const streaming = Boolean(meta.streaming);
  const taskTerminal = task ? TERMINAL_TASK.includes(task.status) : false;
  const taskRunning = task
    ? task.status === "running" || task.status === "queued"
    : false;

  if (!streaming && !taskSummary && resolvedContent === message.content) {
    return message;
  }

  if (streaming && taskRunning && taskSummary) {
    return {
      ...message,
      content: resolvedContent,
      metadata: {
        ...meta,
        taskId,
        streaming: true,
        status: task?.status ?? meta.status,
        phase: task?.agent_state?.phase ?? meta.phase,
        label: task?.agent_state?.statusLabel ?? meta.label,
        ui: ui ?? meta.ui ?? null,
        pendingApprovalId:
          typeof task?.agent_state?.pending_approval_id === "string"
            ? task.agent_state.pending_approval_id
            : meta.pendingApprovalId ?? null,
        pendingApprovalIds: Array.isArray(
          task?.agent_state?.pending_approval_ids,
        )
          ? task.agent_state.pending_approval_ids
          : meta.pendingApprovalIds ?? null,
        isReport: Boolean(task?.agent_state?.report ?? meta.isReport),
        reportTitle:
          task?.agent_state?.report &&
          typeof (task.agent_state.report as { title?: unknown }).title ===
            "string"
            ? (task.agent_state.report as { title: string }).title
            : (meta.reportTitle as string | null | undefined) ?? null,
      },
    };
  }

  if (streaming && taskTerminal) {
    return {
      ...message,
      content: resolvedContent || message.content,
      metadata: {
        ...meta,
        taskId,
        streaming: false,
        liveStatus: false,
        status: task?.status ?? "done",
        phase: task?.agent_state?.phase ?? meta.phase,
        label: task?.agent_state?.statusLabel ?? meta.label,
        ui: ui ?? meta.ui ?? null,
        pendingApprovalId:
          typeof task?.agent_state?.pending_approval_id === "string"
            ? task.agent_state.pending_approval_id
            : meta.pendingApprovalId ?? null,
        pendingApprovalIds: Array.isArray(
          task?.agent_state?.pending_approval_ids,
        )
          ? task.agent_state.pending_approval_ids
          : meta.pendingApprovalIds ?? null,
        isReport: Boolean(task?.agent_state?.report ?? meta.isReport),
        reportTitle:
          task?.agent_state?.report &&
          typeof (task.agent_state.report as { title?: unknown }).title ===
            "string"
            ? (task.agent_state.report as { title: string }).title
            : (meta.reportTitle as string | null | undefined) ?? null,
      },
    };
  }

  if (
    !streaming &&
    (resolvedContent !== message.content ||
      (ui && !messageUi && taskUi))
  ) {
    return {
      ...message,
      content: resolvedContent,
      metadata: {
        ...meta,
        ui: ui ?? meta.ui ?? null,
      },
    };
  }

  return message;
}

export function reconcileConversationMessages(
  messages: Message[],
  task: Task | null,
): Message[] {
  return messages.map((m) => reconcileAssistantMessage(m, task));
}
