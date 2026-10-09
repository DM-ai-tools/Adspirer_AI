import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { runTask } from "@/lib/agent/task-runner";
import { runTaskV2 } from "@/lib/agent/task-runner-v2";
import { toMessageInsert } from "@/lib/db/live-maps";
import type { Message, Task } from "@/types";

/**
 * One chat turn: run the agent task and keep the assistant message row in
 * sync while it runs. Shared by the streaming route (inline runs) and the
 * Trigger.dev job (background runs) so both persist exactly the same thing.
 */

export type TurnEmit = (event: string, data: unknown) => void;

/** Minimum gap between streamed `delta` events — tokens arrive far faster. */
const DELTA_FLUSH_MS = 50;

export async function saveMessage(message: Message, taskId?: string | null) {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.messages.findIndex((m) => m.id === message.id);
    if (idx >= 0) store.messages[idx] = message;
    else store.messages.push(message);
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("messages")
    .upsert(toMessageInsert(message, taskId));
  if (error) throw new Error(error.message);
}

/** Metadata stored on the assistant message once the task settles. */
export function finalAssistantMetadata(task: Task): Record<string, unknown> {
  const state = task.agent_state ?? {};
  const report = state.report as { title?: unknown; data?: unknown } | undefined;
  return {
    taskId: task.id,
    status: task.status,
    streaming: false,
    pendingApprovalId:
      typeof state.pending_approval_id === "string"
        ? state.pending_approval_id
        : null,
    pendingApprovalIds: Array.isArray(state.pending_approval_ids)
      ? state.pending_approval_ids
      : null,
    ui: state.ui ?? null,
    isReport: Boolean(report),
    reportTitle: report && typeof report.title === "string" ? report.title : null,
    reportData:
      report && typeof report === "object" && "data" in report
        ? (report.data ?? null)
        : null,
  };
}

export async function runAgentTurn(input: {
  taskId: string;
  assistantMessage: Message;
  useMetaDirect: boolean;
  metaAccountId?: string;
  /** Background jobs have no session cookie — load this user's Meta token. */
  actingUserId?: string;
  /** Streams events to the client (inline runs only). */
  emit?: TurnEmit;
  /** How often to persist the in-progress reply. */
  persistEveryMs?: number;
}): Promise<{ task: Task; message: Message }> {
  const { assistantMessage, emit } = input;
  const persistEveryMs = input.persistEveryMs ?? 400;
  let lastPersist = 0;
  let lastDeltaSent = 0;
  let lastStatusKey = "";

  try {
    const onProgress: NonNullable<Parameters<typeof runTask>[1]>["onProgress"] = async (event) => {
      // The full task (steps, ui) only changes on status transitions.
      // Re-sending it with every token made payloads grow quadratically.
      const statusKey = `${event.phase}|${event.label}|${event.task.status}`;
      const isTokenEvent = Boolean(event.delta);
      if (!isTokenEvent || statusKey !== lastStatusKey) {
        lastStatusKey = statusKey;
        emit?.("progress", {
          phase: event.phase,
          label: event.label,
          task: event.task,
          summary:
            typeof event.summary === "string" && !isTokenEvent
              ? event.summary
              : undefined,
        });
      }

      const taskUi = event.task.agent_state?.ui ?? null;
      if (event.delta || event.summary != null) {
        assistantMessage.content =
          event.summary ??
          (event.delta
            ? assistantMessage.content + event.delta
            : assistantMessage.content);
        assistantMessage.metadata = {
          ...(assistantMessage.metadata ?? {}),
          taskId: input.taskId,
          status: event.task.status,
          streaming: true,
          phase: event.phase,
          label: event.label,
          liveStatus: false,
          ui: taskUi ?? assistantMessage.metadata?.ui ?? null,
        };
        const now = Date.now();
        if (!isTokenEvent || now - lastDeltaSent >= DELTA_FLUSH_MS) {
          lastDeltaSent = now;
          emit?.("delta", {
            content: assistantMessage.content,
            label: event.label,
            phase: event.phase,
            ui: taskUi,
          });
        }
        if (now - lastPersist > persistEveryMs) {
          lastPersist = now;
          // Fire-and-forget — awaiting DB writes stalls token flush.
          void saveMessage(assistantMessage, input.taskId).catch(() => undefined);
        }
      } else if (event.label) {
        // Live status in the bubble while tools run (no token stream yet).
        if (!assistantMessage.content || assistantMessage.metadata?.liveStatus) {
          assistantMessage.content = `_${event.label}_`;
          assistantMessage.metadata = {
            ...(assistantMessage.metadata ?? {}),
            taskId: input.taskId,
            status: event.task.status,
            streaming: true,
            phase: event.phase,
            label: event.label,
            liveStatus: true,
            ui: taskUi ?? assistantMessage.metadata?.ui ?? null,
          };
          emit?.("delta", {
            content: assistantMessage.content,
            label: event.label,
            phase: event.phase,
            ui: taskUi,
          });
          if (!emit) {
            // Background runs: the status line is how a tailing client sees progress.
            void saveMessage(assistantMessage, input.taskId).catch(() => undefined);
          }
        }
      }
    };

    const task = input.useMetaDirect
      ? await runTaskV2(input.taskId, {
          metaAccountId: input.metaAccountId,
          actingUserId: input.actingUserId,
          onProgress,
        })
      : await runTask(input.taskId, { onProgress });

    assistantMessage.content =
      typeof task.agent_state?.summary === "string"
        ? task.agent_state.summary
        : assistantMessage.content || `Task ${task.status}`;
    assistantMessage.metadata = finalAssistantMetadata(task);
    await saveMessage(assistantMessage, task.id);
    return { task, message: assistantMessage };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed";
    assistantMessage.content =
      assistantMessage.content && !assistantMessage.metadata?.liveStatus
        ? assistantMessage.content
        : `Something went wrong while processing that request: ${message}`;
    assistantMessage.metadata = {
      taskId: input.taskId,
      status: "error",
      streaming: false,
      error: message,
    };
    await saveMessage(assistantMessage, input.taskId).catch(() => undefined);
    throw error;
  }
}
