import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import type { ClientService } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { googleCategoryCandidates } from "@/lib/google/category-candidates";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/clients/:id/services/google-candidates
 * Categories from the client's mapped GA4 property and Search Console site,
 * last 90 days. Read-only. Never fails the request: not mapped, a revoked
 * connection or a Google error returns "unavailable" with the reason.
 */
export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const config = getConfig();
    let websiteUrl: string | null = null;
    let existing: ClientService[] = [];
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      websiteUrl = store.clients.find((c) => c.id === id)?.website_url ?? null;
      existing = store.clientServices.filter((s) => s.client_id === id);
    } else {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const { data: client } = await supabase
        .from("clients")
        .select("website_url")
        .eq("id", id)
        .maybeSingle();
      websiteUrl = (client as { website_url: string | null } | null)?.website_url ?? null;
      const { data: rows } = await supabase
        .from("client_services")
        .select("*")
        .eq("client_id", id);
      existing = (rows ?? []) as ClientService[];
    }
    return jsonOk(await googleCategoryCandidates({ clientId: id, existing, websiteUrl }));
  });
}
