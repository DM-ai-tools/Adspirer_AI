import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { resolveProvider } from "@/lib/adspirer/client";
import { resolvePrimaryAccountId } from "@/lib/agent/adspirer-agent";
import { loadMappedMetaAccounts } from "@/lib/adspirer/resolve-meta-account";
import { pickAllowedAccount } from "@/lib/meta/campaign-options";
import { jsonOk, withApiHandler } from "@/lib/api/response";

/**
 * GET /api/meta/campaigns?clientId=…&accountId=…
 * The campaigns ads can be added to on the client's mapped ad account (not archived or deleted), newest
 * first, with whether the budget sits on the campaign or on its ad sets.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    if (!clientId) throw new Error("clientId required");
    await assertClientAccess(user.id, clientId);

    const mapped = (await loadMappedMetaAccounts(clientId))
      .filter((a) => a.access_status === "granted")
      .map((a) => a.meta_account_id);
    const accountId = pickAllowedAccount(url.searchParams.get("accountId"), mapped, await resolvePrimaryAccountId(clientId));
    if (!accountId) {
      throw new Error("No Meta ad account is mapped to this client. Connect Facebook in the Workspace header, then map an account under Connections.");
    }

    const provider = await resolveProvider();
    const campaigns = (await provider.listCampaigns(accountId))
      .filter((c) => c.status === "ACTIVE" || c.status === "PAUSED")
      .sort((a, b) => String(b.updated_time ?? b.created_time ?? "").localeCompare(String(a.updated_time ?? a.created_time ?? "")))
      .map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        budgetLevel: c.daily_budget_cents || c.lifetime_budget_cents ? ("campaign" as const) : ("ad_set" as const),
      }));
    return jsonOk({ accountId, campaigns });
  });
}
