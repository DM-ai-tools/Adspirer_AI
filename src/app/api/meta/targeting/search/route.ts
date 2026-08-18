import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { getLiveAdspirerProvider, getProvider } from "@/lib/adspirer/client";
import { resolvePrimaryAccountId } from "@/lib/agent/adspirer-agent";
import { jsonOk, withApiHandler } from "@/lib/api/response";

const ALLOWED_TYPES = new Set([
  "interest",
  "behavior",
  "demographic",
  "life_event",
  "location",
  "locale",
  "employer",
  "job_title",
  "school",
  "major",
]);

const BROWSABLE_CATEGORIES: Record<string, string> = {
  interest: "interests",
  behavior: "behaviors",
  demographic: "demographics",
  life_event: "life_events",
};

/**
 * GET /api/meta/targeting/search?clientId=&searchType=interest&query=fitness
 * Searchable Meta detailed targeting via Adspirer search_meta_targeting.
 * An empty query browses the category via browse_meta_targeting.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    const searchType = (url.searchParams.get("searchType") || "interest").trim();
    const query = (url.searchParams.get("query") || "").trim();
    if (!clientId) throw new Error("clientId required");
    if (!ALLOWED_TYPES.has(searchType)) {
      throw new Error(`Invalid searchType: ${searchType}`);
    }
    await assertClientAccess(user.id, clientId);

    const accountId =
      url.searchParams.get("accountId") ||
      (await resolvePrimaryAccountId(clientId));
    if (!accountId) {
      throw new Error(
        "No Meta ad account is mapped to this client. Connect one under Adspirer Connection.",
      );
    }

    const provider = getLiveAdspirerProvider() ?? getProvider();

    // With no query yet, browse the category so operators see real options
    // instead of an empty box. Locations have no browsable category.
    if (query.length < 2) {
      const category = BROWSABLE_CATEGORIES[searchType];
      if (!category || !provider.browseTargeting) {
        return jsonOk({ accountId, searchType, query, options: [] });
      }
      const options = await provider.browseTargeting(accountId, {
        category,
        limit: 50,
      });
      return jsonOk({ accountId, searchType, query, browsed: true, options });
    }

    if (!provider.searchTargeting) {
      throw new Error("Targeting search is not available on this provider");
    }
    const options = await provider.searchTargeting(accountId, {
      search_type: searchType,
      query,
      limit: 25,
      country_code: url.searchParams.get("countryCode") ?? undefined,
    });
    return jsonOk({ accountId, searchType, query, options });
  });
}
