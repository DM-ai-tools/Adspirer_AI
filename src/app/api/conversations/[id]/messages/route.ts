import { nanoid } from "nanoid";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { createTask } from "@/lib/agent/task-runner";
import { createTaskV2 } from "@/lib/agent/task-runner-v2";
import {
  runAgentTurn,
  saveMessage,
  type TurnEmit,
} from "@/lib/agent/run-turn";
import type {
  RunAgentTurnPayload,
  runAgentTurnTask,
} from "../../../../../../trigger/run-agent-turn";
import { maybeAutoTitleConversation } from "@/lib/agent/title-service";
import { nowIso } from "@/lib/utils";
import type { Conversation, Message, Task } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import {
  mapConversationRow,
  mapMessageRow,
  newEntityId,
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

/** Audits gather Meta data, scrape landing pages and run a multi-step model loop. */
export const maxDuration = 300;

/**
 * Live workspaces always run against Meta directly with the operator's
 * Facebook OAuth token; demo mode uses the mock provider.
 */
function usesMetaDirect(): boolean {
  const config = getConfig();
  return !(config.isDemoMode || !config.hasSupabase);
}

/** Background job turns: the route tails the DB this long before handing off. */
const TAIL_BUDGET_MS = (maxDuration - 20) * 1000;
/** If no worker starts the job by then, run the turn inline instead. */
const JOB_START_TIMEOUT_MS = 20_000;

function backgroundRunsEnabled(): boolean {
  const config = getConfig();
  return (
    config.AGENT_BACKGROUND_RUNS &&
    Boolean(config.TRIGGER_SECRET_KEY) &&
    !(config.isDemoMode || !config.hasSupabase)
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadMessage(id: string): Promise<Message | null> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data } = await createAdminClient()
    .from("messages")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  return data ? mapMessageRow(data as Record<string, unknown>) : null;
}

/**
 * Stream a background turn by tailing the rows the job updates. Returns the
 * settled task + message, "not_started" when no worker picked the job up, or
 * null when the client left / the tail budget ran out (the job keeps going and
 * the client's poller takes over).
 */
async function tailBackgroundTurn(input: {
  taskId: string;
  messageId: string;
  send: TurnEmit;
  isClosed: () => boolean;
}): Promise<{ task: Task; message: Message } | "not_started" | null> {
  const started = Date.now();
  let lastStatusKey = "";
  let lastContent = "";
  while (!input.isClosed() && Date.now() - started < TAIL_BUDGET_MS) {
    await sleep(900);
    const [task, message] = await Promise.all([
      getTask(input.taskId).catch(() => null),
      loadMessage(input.messageId),
    ]);
    if (!task) continue;
    if (task.status === "queued" && Date.now() - started > JOB_START_TIMEOUT_MS) {
      return "not_started";
    }
    const label =
      typeof task.agent_state?.statusLabel === "string"
        ? task.agent_state.statusLabel
        : "";
    const phase =
      typeof task.agent_state?.phase === "string" ? task.agent_state.phase : "";
    const statusKey = `${task.status}|${phase}|${label}`;
    if (statusKey !== lastStatusKey) {
      lastStatusKey = statusKey;
      input.send("progress", { phase, label, task });
    }
    if (message && message.content !== lastContent) {
      lastContent = message.content;
      input.send("delta", {
        content: message.content,
        label,
        phase,
        ui: task.agent_state?.ui ?? null,
      });
    }
    if (message && message.metadata?.streaming === false) {
      return { task, message };
    }
  }
  return null;
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
  const useV2 = usesMetaDirect();
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

  const touchConversation = async () => {
    if (!(config.isDemoMode || !config.hasSupabase)) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      await supabase.from("conversations").update({ updated_at: ts }).eq("id", id);
    } else {
      const conv = getDemoStore().conversations.find((c) => c.id === id);
      if (conv) conv.updated_at = ts;
    }
  };

  // ChatGPT-style title from the first user request (an LLM call on the first
  // message). It runs alongside the agent instead of delaying the stream.
  const titled = maybeAutoTitleConversation(conversation, body.content).catch(
    () => conversation,
  );

  await Promise.all([saveMessage(userMessage), touchConversation()]);

  if (body.runAgent === false) {
    conversation = await titled;
    return jsonOk({ message: userMessage, task: null, conversation }, 201);
  }

  const taskInput = {
    clientId: conversation.client_id,
    createdBy: user.id,
    title: body.content.slice(0, 120),
    goal: body.content,
    conversationId: id,
  };
  let task = useV2 ? await createTaskV2(taskInput) : await createTask(taskInput);

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
  await Promise.all([
    linkConversationTask(id, task.id),
    saveMessage(assistantMessage, task.id),
  ]);

  const turnInput = {
    taskId: task.id,
    assistantMessage,
    useMetaDirect: useV2,
    metaAccountId: body.metaAccountId,
  };

  if (!wantStream) {
    conversation = await titled;
    return withApiHandler(async () => {
      const result = await runAgentTurn(turnInput);
      task = result.task;
      return jsonOk(
        {
          message: userMessage,
          task,
          assistantMessage: result.message,
          conversation,
        },
        201,
      );
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // If the operator closes the tab, keep running the task to completion
      // (it is persisted) and just stop writing to the dead stream.
      let closed = false;
      const send: TurnEmit = (event, data) => {
        if (closed) return;
        try {
          controller.enqueue(sseEncode(event, data));
        } catch {
          closed = true;
        }
      };

      try {
        send("user_message", { message: userMessage });
        send("assistant_message", { message: assistantMessage });
        send("task", { task });
        void titled.then((next) => {
          conversation = next;
          send("conversation", { conversation });
        });

        let settled: { task: Task; message: Message } | null = null;

        if (backgroundRunsEnabled()) {
          // Long audits run as a Trigger.dev job; this stream just tails it.
          const { tasks, runs } = await import("@trigger.dev/sdk");
          const payload: RunAgentTurnPayload = { ...turnInput, userId: user.id };
          const handle = await tasks.trigger<typeof runAgentTurnTask>(
            "run-agent-turn",
            payload,
          );
          const tailed = await tailBackgroundTurn({
            taskId: task.id,
            messageId: assistantMessage.id,
            send,
            isClosed: () => closed,
          });
          if (tailed === "not_started") {
            // No worker picked it up (e.g. trigger dev not running): cancel
            // so it can't run twice, then answer inline.
            await runs.cancel(handle.id).catch(() => undefined);
            settled = await runAgentTurn({ ...turnInput, emit: send });
          } else {
            settled = tailed;
          }
        } else {
          settled = await runAgentTurn({ ...turnInput, emit: send });
        }

        if (settled) {
          task = settled.task;
          conversation = await titled;
          send("done", {
            task,
            message: settled.message,
            conversation,
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Agent run failed";
        send("error", { message, taskId: task.id });
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        }
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
