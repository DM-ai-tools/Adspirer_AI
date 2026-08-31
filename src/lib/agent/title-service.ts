import {
  generateChatTitle,
  isDefaultConversationTitle,
  isV2ChatTitle,
  withV2ChatTitle,
} from "@/lib/agent/title";
import type { Conversation } from "@/types";
import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/utils";
import { mapConversationRow } from "@/lib/db/live-maps";

export async function maybeAutoTitleConversation(
  conversation: Conversation,
  firstUserMessage: string,
  options?: { workspaceVersion?: "v1" | "v2" },
): Promise<Conversation> {
  if (!isDefaultConversationTitle(conversation.title)) {
    return conversation;
  }

  let title = await generateChatTitle(firstUserMessage);
  if (options?.workspaceVersion === "v2" || isV2ChatTitle(conversation.title)) {
    title = withV2ChatTitle(title);
  }
  const ts = nowIso();
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    conversation.title = title;
    conversation.updated_at = ts;
    return conversation;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("conversations")
    .update({ title, updated_at: ts })
    .eq("id", conversation.id)
    .select("*")
    .single();
  if (error) {
    conversation.title = title;
    conversation.updated_at = ts;
    return conversation;
  }
  return mapConversationRow(data as Record<string, unknown>);
}

export {
  generateChatTitle,
  isDefaultConversationTitle,
  isV2ChatTitle,
  withV2ChatTitle,
  DEFAULT_CHAT_TITLE,
  DEFAULT_V2_CHAT_TITLE,
} from "@/lib/agent/title";
