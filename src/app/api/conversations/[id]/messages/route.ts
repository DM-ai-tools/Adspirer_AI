import { nanoid } from "nanoid";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { createTask, runTask } from "@/lib/agent/task-runner";
import { createTaskV2, runTaskV2 } from "@/lib/agent/task-runner-v2";
import { maybeAutoTitleConversation } from "@/lib/agent/title-service";
import { nowIso } from "@/lib/utils";
import type { Conversation, Message, Task } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import {
  mapConversationRow,
  mapMessageRow,
  newEntityId,
  toMessageInsert,
} from "@/lib/db/live-maps";
import { getTask } from "@/lib/agent/task-runner";
import { reconcileConversationMessages } from "@/lib/agent/message-reconcile";

const postSchema = z.object({
  content: z.string().min(1),
  runAgent: z.boolean().optional(),
  /** V2: explicit act_* to query (must be mapped to the conversation's client). */
  metaAccountId: z.string().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

function isV2Request(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname.startsWith("/api/v2/") || url.searchParams.get("workspace") === "v2";
}

async function getConversation(id: string): Promise<Conversation> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const found = getDemoStore().conversations.find((c) => c.id === id);
    if (!found) throw new Error(`Conversation not found: ${id}`);
    return found;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Conversation not found: ${id}`);
  return mapConversationRow(data as Record<string, unknown>);
}

async function saveMessage(message: Message, taskId?: string | null) {
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

async function linkConversationTask(conversationId: string, taskId: string) {
  const ts = nowIso();
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const conv = getDemoStore().conversations.find((c) => c.id === conversationId);
    if (conv) {
      conv.task_id = taskId;
      conv.updated_at = ts;
    }
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  await supabase
    .from("conversations")
    .update({ task_id: taskId, updated_at: ts })
    .eq("id", conversationId);
}

function sseEncode(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const conversation = await getConversation(id);
    await assertClientAccess(user.id, conversation.client_id);

    const config = getConfig();
    let messages: Message[];
    if (config.isDemoMode || !config.hasSupabase) {
      messages = getDemoStore().messages.filter(
        (m) => m.conversation_id === id,
      );
    } else {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", id)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      messages = (data ?? []).map((row) =>
        mapMessageRow(row as Record<string, unknown>),
      );
    }

    let task: Task | null = null;
    // Only reconcile the in-flight / orphaned streaming assistant row for the
    // conversation's latest task — never rewrite older turns' stored content.
    const streamingForLatestTask = messages.filter((m) => {
      if (m.role !== "assistant" || !m.metadata?.streaming) return false;
      const taskId = m.metadata?.taskId;
      return (
        !taskId ||
        !conversation.task_id ||
        taskId === conversation.task_id
      );
    });
    if (conversation.task_id && streamingForLatestTask.length > 0) {
      try {
        task = await getTask(conversation.task_id);
      } catch {
        task = null;
      }
    }

    return jsonOk({
      conversation,
      messages: task
        ? reconcileConversationMessages(messages, task)
        : messages,
    });
  });
}

export async function POST(request: Request, context: RouteContext) {
  const useV2 = isV2Request(request);
  const { id } = await context.params;
  const wantStream =
    request.headers.get("accept")?.includes("text/event-stream") ||
    new URL(request.url).searchParams.get("stream") === "1";

  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 },
    );
  }

  let conversation: Conversation;
  try {
    conversation = await getConversation(id);
    await assertClientAccess(user.id, conversation.client_id);
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: error instanceof Error ? error.message : "Access denied",
        },
      },
      { status: 403 },
    );
  }

  let body: z.infer<typeof postSchema>;
  try {
    body = await parseBody(request, postSchema);
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "BAD_REQUEST",
          message: error instanceof Error ? error.message : "Invalid body",
        },
      },
      { status: 400 },
    );
  }

  const ts = nowIso();
  const config = getConfig();
  const userMessage: Message = {
    id:
      config.isDemoMode || !config.hasSupabase
        ? `msg_${nanoid(10)}`
        : newEntityId(),
    conversation_id: id,
    role: "user",
    content: body.content,
    tool_call_id: null,
    metadata: null,
    created_at: ts,
  };

  await saveMessage(userMessage);
  if (!(config.isDemoMode || !config.hasSupabase)) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    await supabase.from("conversations").update({ updated_at: ts }).eq("id", id);
  } else {
    const conv = getDemoStore().conversations.find((c) => c.id === id);
    if (conv) conv.updated_at = ts;
  }

  // ChatGPT-style title from the first user request (OpenAI when configured).
  conversation = await maybeAutoTitleConversation(conversation, body.content, {
    workspaceVersion: useV2 ? "v2" : "v1",
  });

  if (body.runAgent === false) {
    return jsonOk({ message: userMessage, task: null, conversation }, 201);
  }

  let task = useV2
    ? await createTaskV2({
        clientId: conversation.client_id,
        createdBy: user.id,
        title: body.content.slice(0, 120),
        goal: body.content,
        conversationId: id,
      })
    : await createTask({
        clientId: conversation.client_id,
        createdBy: user.id,
        title: body.content.slice(0, 120),
        goal: body.content,
        conversationId: id,
      });
  await linkConversationTask(id, task.id);

  const assistantMessage: Message = {
    id:
      config.isDemoMode || !config.hasSupabase
        ? `msg_${nanoid(10)}`
        : newEntityId(),
    conversation_id: id,
    role: "assistant",
    content: "",
    tool_call_id: null,
    metadata: {
      taskId: task.id,
      status: "running",
      streaming: true,
    },
    created_at: nowIso(),
  };
  await saveMessage(assistantMessage, task.id);

  if (!wantStream) {
    return withApiHandler(async () => {
      task = await (useV2 ? runTaskV2 : runTask)(task.id, {
        metaAccountId: body.metaAccountId,
        onProgress: async (event) => {
          if (event.summary != null) {
            assistantMessage.content = event.summary;
            assistantMessage.metadata = {
              ...(assistantMessage.metadata ?? {}),
              taskId: task.id,
              status: event.task.status,
              streaming: true,
              phase: event.phase,
              label: event.label,
            };
            await saveMessage(assistantMessage, task.id);
          }
        },
      });

      const summary =
        typeof task.agent_state?.summary === "string"
          ? task.agent_state.summary
          : assistantMessage.content || `Task ${task.status}`;

      assistantMessage.content = summary;
      assistantMessage.metadata = {
        taskId: task.id,
        status: task.status,
        streaming: false,
        pendingApprovalId:
          typeof task.agent_state?.pending_approval_id === "string"
            ? task.agent_state.pending_approval_id
            : null,
        pendingApprovalIds: Array.isArray(task.agent_state?.pending_approval_ids)
          ? task.agent_state.pending_approval_ids
          : null,
        ui: task.agent_state?.ui ?? null,
        isReport: Boolean(task.agent_state?.report),
        reportTitle:
          task.agent_state?.report &&
          typeof (task.agent_state.report as { title?: unknown }).title ===
            "string"
            ? (task.agent_state.report as { title: string }).title
            : null,
        reportData:
          task.agent_state?.report &&
          typeof task.agent_state.report === "object" &&
          "data" in (task.agent_state.report as object)
            ? (task.agent_state.report as { data?: unknown }).data ?? null
            : null,
      };
      await saveMessage(assistantMessage, task.id);

      return jsonOk(
        { message: userMessage, task, assistantMessage, conversation },
        201,
      );
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(sseEncode(event, data));
      };

      try {
        send("user_message", { message: userMessage });
        send("conversation", { conversation });
        send("assistant_message", { message: assistantMessage });
        send("task", { task });

        let lastPersist = 0;
        task = await (useV2 ? runTaskV2 : runTask)(task.id, {
          metaAccountId: body.metaAccountId,
          onProgress: async (event) => {
            send("progress", {
              phase: event.phase,
              label: event.label,
              task: event.task,
              summary:
                typeof event.summary === "string" ? event.summary : undefined,
            });

            if (event.delta || event.summary != null) {
              const nextContent =
                event.summary ??
                (event.delta
                  ? assistantMessage.content + event.delta
                  : assistantMessage.content);
              assistantMessage.content = nextContent;
              const taskUi = event.task.agent_state?.ui ?? null;
              send("delta", {
                delta: event.delta ?? "",
                content: assistantMessage.content,
                label: event.label,
                phase: event.phase,
                ui: taskUi,
              });
              const now = Date.now();
              if (now - lastPersist > 400) {
                lastPersist = now;
                assistantMessage.metadata = {
                  ...(assistantMessage.metadata ?? {}),
                  taskId: task.id,
                  status: event.task.status,
                  streaming: true,
                  phase: event.phase,
                  label: event.label,
                  ui: taskUi ?? assistantMessage.metadata?.ui ?? null,
                };
                // Fire-and-forget — awaiting DB writes stalls token flush to the client.
                void saveMessage(assistantMessage, task.id).catch(() => undefined);
              }
            } else if (event.label) {
              const taskUi = event.task.agent_state?.ui ?? null;
              // Live status in the bubble while tools run (no token stream yet)
              const statusLine = `_${event.label}_`;
              if (
                !assistantMessage.content ||
                assistantMessage.metadata?.liveStatus
              ) {
                assistantMessage.content = statusLine;
                assistantMessage.metadata = {
                  ...(assistantMessage.metadata ?? {}),
                  taskId: task.id,
                  status: event.task.status,
                  streaming: true,
                  phase: event.phase,
                  label: event.label,
                  liveStatus: true,
                  ui: taskUi ?? assistantMessage.metadata?.ui ?? null,
                };
                send("delta", {
                  delta: "",
                  content: assistantMessage.content,
                  label: event.label,
                  phase: event.phase,
                  ui: taskUi,
                });
              }
            }
          },
        });

        const summary =
          typeof task.agent_state?.summary === "string"
            ? task.agent_state.summary
            : assistantMessage.content || `Task ${task.status}`;

        assistantMessage.content = summary;
        assistantMessage.metadata = {
          taskId: task.id,
          status: task.status,
          streaming: false,
          pendingApprovalId:
            typeof task.agent_state?.pending_approval_id === "string"
              ? task.agent_state.pending_approval_id
              : null,
          pendingApprovalIds: Array.isArray(
            task.agent_state?.pending_approval_ids,
          )
            ? task.agent_state.pending_approval_ids
            : null,
          ui: task.agent_state?.ui ?? null,
          isReport: Boolean(task.agent_state?.report),
          reportTitle:
            task.agent_state?.report &&
            typeof (task.agent_state.report as { title?: unknown }).title ===
              "string"
              ? (task.agent_state.report as { title: string }).title
              : null,
          reportData:
            task.agent_state?.report &&
            typeof task.agent_state.report === "object" &&
            "data" in (task.agent_state.report as object)
              ? (task.agent_state.report as { data?: unknown }).data ?? null
              : null,
        };
        await saveMessage(assistantMessage, task.id);

        send("done", {
          task,
          message: assistantMessage,
          conversation,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Agent run failed";
        assistantMessage.content =
          assistantMessage.content ||
          `Something went wrong while processing that request: ${message}`;
        assistantMessage.metadata = {
          taskId: task.id,
          status: "error",
          streaming: false,
          error: message,
        };
        await saveMessage(assistantMessage, task.id).catch(() => undefined);
        send("error", { message, taskId: task.id });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
