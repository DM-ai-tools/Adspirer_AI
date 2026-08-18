import { nanoid } from "nanoid";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapMessageRow, newEntityId, toMessageInsert } from "@/lib/db/live-maps";
import { nowIso } from "@/lib/utils";
import type { Message } from "@/types";

export type WorkflowEventType =
  | "creative_generating"
  | "creative_ready"
  | "creative_failed"
  | "creative_selected"
  | "creative_rejected"
  | "creative_revised"
  | "approval_approved"
  | "approval_rejected"
  | "approval_executed"
  | "approval_failed"
  | "competitor_research_ready";

export async function appendWorkflowMessage(input: {
  conversationId: string;
  taskId?: string | null;
  eventType: WorkflowEventType;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<Message> {
  const config = getConfig();
  const message: Message = {
    id:
      config.isDemoMode || !config.hasSupabase
        ? `msg_${nanoid(10)}`
        : newEntityId(),
    conversation_id: input.conversationId,
    role: "assistant",
    content: input.content,
    tool_call_id: null,
    metadata: {
      workflowEvent: input.eventType,
      taskId: input.taskId ?? null,
      ...input.metadata,
    },
    created_at: nowIso(),
  };

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    store.messages.push(message);
    const conv = store.conversations.find((c) => c.id === input.conversationId);
    if (conv) conv.updated_at = message.created_at;
    return message;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("messages")
    .upsert(toMessageInsert(message, input.taskId ?? null));
  if (error) throw new Error(error.message);
  await supabase
    .from("conversations")
    .update({ updated_at: message.created_at })
    .eq("id", input.conversationId);
  return message;
}

export async function resolveConversationForTask(
  taskId: string,
): Promise<string | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const task = getDemoStore().tasks.find((t) => t.id === taskId);
    return task?.conversation_id ?? null;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("tasks")
    .select("conversation_id")
    .eq("id", taskId)
    .maybeSingle();
  return (data?.conversation_id as string | null) ?? null;
}

export async function listWorkflowMessages(
  conversationId: string,
): Promise<Message[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore()
      .messages.filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) =>
    mapMessageRow(row as Record<string, unknown>),
  );
}
