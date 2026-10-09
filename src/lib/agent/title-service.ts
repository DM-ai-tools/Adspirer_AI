import {
  generateChatTitle,
  isDefaultConversationTitle,
  type ChatTitleContext,
} from "@/lib/agent/title";
import type { Conversation } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { nowIso } from "@/lib/utils";
import { mapConversationRow } from "@/lib/db/live-maps";

/**
 * Suggestion-chip prompts. They read the same for every client, so a title
 * built from them alone is generic — those threads are titled after the first
 * reply instead.
 */
const STARTER_PROMPTS = [
  "audit the account and summarize spend, delivery, and risks",
  "which campaigns or ads are spending without results in the last 14 days, and what should we change?",
  "optimize ads in this account",
  "create a meta campaign for this account",
];

function normalizePrompt(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "");
}

export function isStarterPrompt(text: string): boolean {
  const normalized = normalizePrompt(text);
  return STARTER_PROMPTS.some((p) => normalizePrompt(p) === normalized);
}

/** Quoted names ("Spring Sale – UK") the operator typed in the message. */
export function extractMentionedNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/["“']([^"“”'\n]{3,60})["”']/g)) {
    names.add(match[1].trim());
  }
  return [...names].slice(0, 5);
}

/** Short date suffix used to tell same-titled threads apart, e.g. "9 Oct". */
export function shortDateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

async function loadTitleContext(
  conversation: Conversation,
  firstUserMessage: string,
): Promise<ChatTitleContext> {
  const config = getConfig();
  let clientName: string | null = null;
  let accountNames: string[] = [];
  try {
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      clientName =
        store.clients.find((c) => c.id === conversation.client_id)?.name ?? null;
      accountNames = store.connectedMetaAccounts
        .filter((a) => a.client_id === conversation.client_id)
        .map((a) => a.meta_account_name);
    } else {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const [{ data: client }, { data: accounts }] = await Promise.all([
        supabase
          .from("clients")
          .select("name")
          .eq("id", conversation.client_id)
          .maybeSingle(),
        supabase
          .from("connected_meta_accounts")
          .select("meta_account_name")
          .eq("mapped_client_id", conversation.client_id)
          .limit(5),
      ]);
      clientName = typeof client?.name === "string" ? client.name : null;
      accountNames = (accounts ?? [])
        .map((a) => String(a.meta_account_name ?? ""))
        .filter(Boolean);
    }
  } catch {
    // Title context is best-effort.
  }
  const lower = firstUserMessage.toLowerCase();
  return {
    clientName,
    entityNames: [
      ...extractMentionedNames(firstUserMessage),
      // Account names only when the operator referred to them.
      ...accountNames.filter((n) => lower.includes(n.toLowerCase())),
    ],
  };
}

/** Other conversations for this client already using `title` (case-insensitive). */
async function titleTaken(
  conversation: Conversation,
  title: string,
): Promise<boolean> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().conversations.some(
      (c) =>
        c.id !== conversation.id &&
        c.client_id === conversation.client_id &&
        (c.title ?? "").trim().toLowerCase() === title.toLowerCase(),
    );
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data } = await createAdminClient()
    .from("conversations")
    .select("id")
    .eq("client_id", conversation.client_id)
    .neq("id", conversation.id)
    .ilike("title", title.replace(/[%_\\]/g, (m) => `\\${m}`))
    .limit(1);
  return Boolean(data?.length);
}

/** Append a date (then a time) until the title is unique for this client. */
async function dedupeTitle(
  conversation: Conversation,
  title: string,
): Promise<string> {
  try {
    if (!(await titleTaken(conversation, title))) return title;
    const created = conversation.created_at || nowIso();
    const withDate = `${title} · ${shortDateLabel(created)}`;
    if (!(await titleTaken(conversation, withDate))) return withDate;
    const time = new Date(created).toISOString().slice(11, 16);
    return `${withDate} ${time}`;
  } catch {
    return title;
  }
}

/**
 * Title a conversation that still has the default name. Starter prompts are
 * deferred until `replyExcerpt` is available (see `titleConversationAfterReply`).
 * The write is conditional on the title still being the default, so two
 * concurrent callers cannot both rename the thread.
 */
export async function maybeAutoTitleConversation(
  conversation: Conversation,
  firstUserMessage: string,
  options?: { replyExcerpt?: string | null },
): Promise<Conversation> {
  if (!isDefaultConversationTitle(conversation.title)) {
    return conversation;
  }
  if (isStarterPrompt(firstUserMessage) && !options?.replyExcerpt?.trim()) {
    return conversation;
  }

  const context = await loadTitleContext(conversation, firstUserMessage);
  const generated = await generateChatTitle(firstUserMessage, {
    ...context,
    replyExcerpt: options?.replyExcerpt ?? null,
  });
  const title = await dedupeTitle(conversation, generated);
  const ts = nowIso();
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const stored = getDemoStore().conversations.find(
      (c) => c.id === conversation.id,
    );
    if (stored && !isDefaultConversationTitle(stored.title)) return stored;
    conversation.title = title;
    conversation.updated_at = ts;
    return conversation;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  let update = supabase
    .from("conversations")
    .update({ title, updated_at: ts })
    .eq("id", conversation.id);
  update = conversation.title
    ? update.eq("title", conversation.title)
    : update.is("title", null);
  const { data, error } = await update.select("*").maybeSingle();
  if (error) {
    conversation.title = title;
    conversation.updated_at = ts;
    return conversation;
  }
  if (!data) {
    // Someone else titled it first — return what is stored.
    const { data: current } = await supabase
      .from("conversations")
      .select("*")
      .eq("id", conversation.id)
      .maybeSingle();
    return current
      ? mapConversationRow(current as Record<string, unknown>)
      : conversation;
  }
  return mapConversationRow(data as Record<string, unknown>);
}

/**
 * Starter-prompt threads are titled once the first reply exists, using a short
 * excerpt of it. No-op for threads that already have a title.
 */
export async function titleConversationAfterReply(
  conversation: Conversation,
  firstUserMessage: string,
  reply: string,
): Promise<Conversation> {
  if (!isStarterPrompt(firstUserMessage)) return conversation;
  return maybeAutoTitleConversation(conversation, firstUserMessage, {
    replyExcerpt: reply.slice(0, 600),
  });
}

export {
  generateChatTitle,
  isDefaultConversationTitle,
  isV2ChatTitle,
  withV2ChatTitle,
  DEFAULT_CHAT_TITLE,
  DEFAULT_V2_CHAT_TITLE,
} from "@/lib/agent/title";
