import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import type { ClientService } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { scanSiteCandidates } from "@/lib/scraping/site-scan";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/clients/:id/services/discover
 * Scans the client's website for category pages. Never fails the request:
 * a missing key, missing website or Firecrawl error returns "unavailable"
 * with the reason, so the page can say which one it was.
 */
export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const config = getConfig();
    // Checked before the client is read, so an unconfigured scan costs nothing.
    if (!config.hasFirecrawl) return jsonOk(await scanSiteCandidates({ siteUrl: null, existing: [], clientId: id }));

    let siteUrl: string | null = null;
    let existing: ClientService[] = [];
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      siteUrl = store.clients.find((c) => c.id === id)?.website_url ?? null;
      existing = store.clientServices.filter((s) => s.client_id === id);
    } else {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const { data: client } = await supabase
        .from("clients")
        .select("website_url")
        .eq("id", id)
        .maybeSingle();
      siteUrl = (client as { website_url: string | null } | null)?.website_url ?? null;
      const { data: rows } = await supabase
        .from("client_services")
        .select("*")
        .eq("client_id", id);
      existing = (rows ?? []) as ClientService[];
    }
    return jsonOk(await scanSiteCandidates({ siteUrl, existing, clientId: id }));
  });
}
