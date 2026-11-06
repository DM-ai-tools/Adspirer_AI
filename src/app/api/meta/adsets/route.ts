import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { resolveProvider } from "@/lib/adspirer/client";
import { resolvePrimaryAccountId } from "@/lib/agent/adspirer-agent";
import { loadMappedMetaAccounts } from "@/lib/adspirer/resolve-meta-account";
import { pickAllowedAccount } from "@/lib/meta/campaign-options";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { summariseTargeting } from "@/lib/meta/adset-summary";

/**
 * GET /api/meta/adsets?clientId=…&campaignId=…&accountId=…
 * The ad sets already in a campaign (not archived or deleted), so ads can be added to one as it is.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    const campaignId = url.searchParams.get("campaignId");
    if (!clientId) throw new Error("clientId required");
    if (!campaignId || !/^\d+$/.test(campaignId)) throw new Error("campaignId required");
    await assertClientAccess(user.id, clientId);

    const mapped = (await loadMappedMetaAccounts(clientId)).filter((a) => a.access_status === "granted").map((a) => a.meta_account_id);
    const accountId = pickAllowedAccount(url.searchParams.get("accountId"), mapped, await resolvePrimaryAccountId(clientId));
    if (!accountId) throw new Error("No Meta ad account is mapped to this client.");

    const provider = await resolveProvider();
    // The campaign must be on this client's account: list the account's campaigns and check.
    const campaigns = await provider.listCampaigns(accountId);
    if (!campaigns.some((c) => c.id === campaignId)) throw new Error("That campaign is not in this ad account.");

    const adsets = (await provider.listAdSets(accountId, campaignId))
      .filter((a) => a.status === "ACTIVE" || a.status === "PAUSED")
      .map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        optimizationGoal: a.optimization_goal ?? null,
        dailyBudgetCents: a.daily_budget_cents || null,
        destinationType: a.destination_type ?? null,
        needsLeadForm: a.destination_type === "ON_AD",
        audience: summariseTargeting(a.targeting_summary),
      }));
    return jsonOk({ accountId, adsets });
  });
}
