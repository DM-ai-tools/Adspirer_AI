import { nanoid } from "nanoid";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
  getAccessibleClientIds,
} from "@/lib/authz/assert";
import { isAdmin } from "@/lib/security/roles";
import { nowIso } from "@/lib/utils";
import type { Conversation } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";
import {
  mapConversationRow,
  newEntityId,
  toConversationInsert,
} from "@/lib/db/live-maps";

const createSchema = z.object({
  clientId: z.string().min(1),
  title: z.string().min(1).optional(),
});

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      let conversations = store.conversations;
      if (clientId) {
        await assertClientAccess(user.id, clientId);
        conversations = conversations.filter((c) => c.client_id === clientId);
      } else if (!isAdmin(user.profile)) {
        const allowed = new Set(
          store.userClientAccess
            .filter((a) => a.user_id === user.id)
            .map((a) => a.client_id),
        );
        conversations = conversations.filter((c) => allowed.has(c.client_id));
      }
      return jsonOk({
        conversations: conversations
          .slice()
          .sort(
            (a, b) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
          ),
      });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    let query = supabase
      .from("conversations")
      .select("*")
      .order("updated_at", { ascending: false });
    if (clientId) {
      await assertClientAccess(user.id, clientId);
      query = query.eq("client_id", clientId);
    } else {
      const allowed = await getAccessibleClientIds(user);
      if (allowed) query = query.in("client_id", allowed);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({
      conversations: (data ?? []).map((row) =>
        mapConversationRow(row as Record<string, unknown>),
      ),
    });
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const body = await parseBody(request, createSchema);
    await assertClientAccess(user.id, body.clientId);

    const ts = nowIso();
    const config = getConfig();
    const conversation: Conversation = {
      id:
        config.isDemoMode || !config.hasSupabase
          ? `conv_${nanoid(10)}`
          : newEntityId(),
      client_id: body.clientId,
      task_id: null,
      created_by: user.id,
      title: body.title ?? null,
      created_at: ts,
      updated_at: ts,
    };

    if (config.isDemoMode || !config.hasSupabase) {
      getDemoStore().conversations.push(conversation);
      return jsonOk({ conversation }, 201);
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("conversations")
      .insert(toConversationInsert(conversation))
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return jsonOk(
      { conversation: mapConversationRow(data as Record<string, unknown>) },
      201,
    );
  });
}
