import type { Message } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapMessageRow } from "@/lib/db/live-maps";
import { sanitizeHistoryContent } from "@/lib/agent/reply-format";

const MAX_MESSAGES = 24;
const MAX_CHARS = 48_000;

export type AgentHistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

/**
 * Load recent conversation turns for the agent context window.
 * Keeps the newest messages within a message + character budget.
 * Strips machine JSON from assistant turns so the model keeps writing prose.
 */
export async function loadConversationHistory(
  conversationId: string | null | undefined,
  options?: { excludeMessageId?: string },
): Promise<AgentHistoryMessage[]> {
  if (!conversationId) return [];

  const messages = await fetchMessages(conversationId);
  const filtered = messages.filter((m) => {
    if (options?.excludeMessageId && m.id === options.excludeMessageId) {
      return false;
    }
    return m.role === "user" || m.role === "assistant" || m.role === "system";
  });

  return truncateHistory(
    filtered.map((m) => ({
      role: m.role as AgentHistoryMessage["role"],
      content:
        m.role === "assistant"
          ? sanitizeHistoryContent(m.content)
          : m.content,
    })),
  );
}

export function truncateHistory(
  messages: AgentHistoryMessage[],
): AgentHistoryMessage[] {
  const recent = messages.slice(-MAX_MESSAGES);
  let total = 0;
  const kept: AgentHistoryMessage[] = [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const len = recent[i].content.length;
    if (kept.length > 0 && total + len > MAX_CHARS) break;
    kept.unshift(recent[i]);
    total += len;
  }
  return kept;
}

async function fetchMessages(conversationId: string): Promise<Message[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore()
      .messages.filter((m) => m.conversation_id === conversationId)
      .slice()
      .sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(80);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) =>
    mapMessageRow(row as Record<string, unknown>),
  );
}
