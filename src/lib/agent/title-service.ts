import {
  generateChatTitle,
  isDefaultConversationTitle,
} from "@/lib/agent/title";
import type { Conversation } from "@/types";
import { getConfig } from "@/lib/config";
import { nowIso } from "@/lib/utils";
import { mapConversationRow } from "@/lib/db/live-maps";

export async function maybeAutoTitleConversation(
  conversation: Conversation,
  firstUserMessage: string,
): Promise<Conversation> {
  if (!isDefaultConversationTitle(conversation.title)) {
    return conversation;
  }

  // There is a single workspace now, so titles no longer carry a "V2" marker
  // (legacy marked titles are still cleaned up for display).
  const title = await generateChatTitle(firstUserMessage);
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
