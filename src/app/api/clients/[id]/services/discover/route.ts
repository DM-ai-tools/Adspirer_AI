import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import type { ClientService } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { logger } from "@/lib/observability/logger";
import {
  discoverCategoryCandidates,
  mapSiteUrls,
  type CategoryCandidate,
} from "@/lib/scraping/site-map";

type RouteContext = { params: Promise<{ id: string }> };

const unavailable = { candidates: [] as CategoryCandidate[], source: "unavailable" as const };

/**
 * GET /api/clients/:id/services/discover
 * Scans the client's website for category pages. Never fails the request:
 * a missing key, missing website or Firecrawl error returns "unavailable".
 */
export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { id } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, id);

    const config = getConfig();
    if (!config.hasFirecrawl) return jsonOk(unavailable);

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
    if (!siteUrl) return jsonOk(unavailable);

    try {
      const urls = await mapSiteUrls(siteUrl);
      return jsonOk({
        candidates: discoverCategoryCandidates(urls, siteUrl, existing),
        source: "firecrawl" as const,
      });
    } catch (error) {
      logger.warn("Category scan: site map failed", {
        clientId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonOk(unavailable);
    }
  });
}
