import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated } from "@/lib/authz/assert";
import { nowIso } from "@/lib/utils";
import type { Notification } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const patchSchema = z.object({
  ids: z.array(z.string().min(1)).optional(),
  all: z.boolean().optional(),
});

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get("unread") === "1";

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      let notifications = getDemoStore().notifications.filter(
        (n) => n.user_id === user.id,
      );
      if (unreadOnly) {
        notifications = notifications.filter((n) => !n.read_at);
      }
      notifications = notifications.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
      return jsonOk({ notifications });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    let query = supabase
      .from("notifications")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (unreadOnly) query = query.is("read_at", null);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({ notifications: (data ?? []) as Notification[] });
  });
}

export async function PATCH(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const body = await parseBody(request, patchSchema);
    if (!body.all && (!body.ids || body.ids.length === 0)) {
      throw new Error("Provide ids or all=true to mark notifications read");
    }

    const ts = nowIso();
    const config = getConfig();

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const updated: Notification[] = [];
      for (const n of store.notifications) {
        if (n.user_id !== user.id) continue;
        if (body.all || body.ids?.includes(n.id)) {
          n.read_at = ts;
          updated.push(n);
        }
      }
      return jsonOk({ notifications: updated, markedRead: updated.length });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    let query = supabase
      .from("notifications")
      .update({ read_at: ts })
      .eq("user_id", user.id)
      .select("*");
    if (!body.all && body.ids) {
      query = query.in("id", body.ids);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({
      notifications: (data ?? []) as Notification[],
      markedRead: (data ?? []).length,
    });
  });
}
