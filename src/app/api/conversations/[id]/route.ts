import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { nowIso } from "@/lib/utils";
import type { Conversation } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import { mapConversationRow } from "@/lib/db/live-maps";

type RouteContext = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

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

export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const conversation = await getConversation(id);
    await assertClientAccess(user.id, conversation.client_id);
    return jsonOk({ conversation });
  });
}

export async function PATCH(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const conversation = await getConversation(id);
    await assertClientAccess(user.id, conversation.client_id);

    const body = await parseBody(request, patchSchema);
    const ts = nowIso();
    const nextTitle = body.title?.trim() || conversation.title;

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      conversation.title = nextTitle;
      conversation.updated_at = ts;
      return jsonOk({ conversation });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("conversations")
      .update({ title: nextTitle, updated_at: ts })
      .eq("id", id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return jsonOk({
      conversation: mapConversationRow(data as Record<string, unknown>),
    });
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const conversation = await getConversation(id);
    await assertClientAccess(user.id, conversation.client_id);

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      store.conversations = store.conversations.filter((c) => c.id !== id);
      store.messages = store.messages.filter((m) => m.conversation_id !== id);
      return jsonOk({ deleted: true });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    // Messages cascade via FK; tasks keep conversation_id null via ON DELETE SET NULL.
    const { error } = await supabase.from("conversations").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return jsonOk({ deleted: true });
  });
}
