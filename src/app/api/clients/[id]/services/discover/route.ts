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
  matchServicePages,
  type CategoryCandidate,
} from "@/lib/scraping/site-map";

type RouteContext = { params: Promise<{ id: string }> };

export type ScanUnavailableReason = "not_configured" | "no_website" | "scan_failed";

const unavailable = (reason: ScanUnavailableReason) => ({
  candidates: [] as CategoryCandidate[],
  source: "unavailable" as const,
  reason,
});

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
    if (!config.hasFirecrawl) return jsonOk(unavailable("not_configured"));

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
    if (!siteUrl) return jsonOk(unavailable("no_website"));

    try {
      const urls = await mapSiteUrls(siteUrl);
      let candidates = discoverCategoryCandidates(urls, siteUrl, existing);
      // No shop-style category pages (agencies, clinics): read the service
      // names from the site and match each to its own page in the map.
      if (!candidates.length) {
        const { scrapeWebsiteServices } = await import("@/lib/scraping/firecrawl");
        const scraped = await scrapeWebsiteServices(siteUrl);
        candidates = matchServicePages(
          scraped.services.map((s) => s.name),
          urls,
          siteUrl,
          existing,
        );
      }
      return jsonOk({ candidates, source: "firecrawl" as const });
    } catch (error) {
      logger.warn("Category scan: site map failed", {
        clientId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonOk(unavailable("scan_failed"));
    }
  });
}
