import type { Message } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapMessageRow } from "@/lib/db/live-maps";
import { sanitizeHistoryContent } from "@/lib/agent/reply-format";

const MAX_MESSAGES = 24;
const MAX_CHARS = 48_000;
/** Rows fetched from the DB — the newest ones, not the oldest. */
const FETCH_LIMIT = 80;
/** Older assistant replies (full audits) are cut to this many characters. */
const PAST_REPLY_CHARS = 1_500;
/** The latest reply stays fuller so "explain point 3" follow-ups still work. */
const LATEST_REPLY_CHARS = 6_000;
const TRUNCATION_NOTE = "[earlier report truncated]";

/** Cut a long reply at a line boundary and mark it as truncated. */
export function truncatePastReply(content: string, limit: number): string {
  if (content.length <= limit) return content;
  const head = content.slice(0, limit);
  const lastBreak = head.lastIndexOf("\n");
  const cut = lastBreak > limit * 0.6 ? head.slice(0, lastBreak) : head;
  return `${cut.trimEnd()}\n\n${TRUNCATION_NOTE}`;
}

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

  const latestAssistantIndex = filtered.map((m) => m.role).lastIndexOf("assistant");
  return truncateHistory(
    filtered.map((m, index) => ({
      role: m.role as AgentHistoryMessage["role"],
      content:
        m.role === "assistant"
          ? truncatePastReply(
              sanitizeHistoryContent(m.content),
              index === latestAssistantIndex
                ? LATEST_REPLY_CHARS
                : PAST_REPLY_CHARS,
            )
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
    // Newest first so long threads keep their latest turns, then back to
    // chronological order for the model.
    .order("created_at", { ascending: false })
    .limit(FETCH_LIMIT);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => mapMessageRow(row as Record<string, unknown>))
    .reverse();
}
