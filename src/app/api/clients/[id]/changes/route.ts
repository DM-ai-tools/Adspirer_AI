import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { listChanges } from "@/lib/changes/change-log";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ id: string }> };

/** The client's change log, newest first, with display names for the people in it. */
export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const changes = await listChanges(id);
    const ids = [...new Set(changes.flatMap((c) => [c.approved_by, c.executed_by]).filter((v): v is string => Boolean(v)))];
    const people: Record<string, string> = {};
    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      for (const p of getDemoStore().profiles) {
        if (ids.includes(p.id)) people[p.id] = p.full_name || p.email;
      }
    } else if (ids.length) {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const { data } = await createAdminClient().from("profiles").select("id, full_name, email").in("id", ids);
      for (const p of data ?? []) people[String(p.id)] = String(p.full_name || p.email);
    }
    return jsonOk({ changes, people });
  });
}
