import { nanoid } from "nanoid";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { nowIso } from "@/lib/utils";
import type { UserClientAccess } from "@/types";
import { jsonOk, parseBody, withApiHandler } from "@/lib/api/response";

const putSchema = z.object({
  clientIds: z.array(z.string().min(1)),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const body = await parseBody(request, putSchema);
    const config = getConfig();
    const ts = nowIso();

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const profile = store.profiles.find((p) => p.id === id);
      if (!profile) throw new Error(`User not found: ${id}`);

      store.userClientAccess = store.userClientAccess.filter(
        (a) => a.user_id !== id,
      );
      const created: UserClientAccess[] = body.clientIds.map((clientId) => ({
        id: `uca_${nanoid(10)}`,
        user_id: id,
        client_id: clientId,
        granted_by: user.id,
        created_at: ts,
      }));
      store.userClientAccess.push(...created);
      return jsonOk({ userId: id, access: created });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    await supabase.from("user_client_access").delete().eq("user_id", id);

    if (body.clientIds.length === 0) {
      return jsonOk({ userId: id, access: [] as UserClientAccess[] });
    }

    const rows = body.clientIds.map((clientId) => ({
      user_id: id,
      client_id: clientId,
      granted_by: user.id,
    }));
    const { data, error } = await supabase
      .from("user_client_access")
      .insert(rows)
      .select("*");
    if (error) throw new Error(error.message);
    return jsonOk({
      userId: id,
      access: (data ?? []) as UserClientAccess[],
    });
  });
}
