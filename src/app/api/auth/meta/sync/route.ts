import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated } from "@/lib/authz/assert";
import { syncConnectedMetaAccounts } from "@/lib/adspirer/account-sync";
import { jsonOk, withApiHandler } from "@/lib/api/response";

/**
 * POST /api/auth/meta/sync
 * Syncs ad accounts from the user's Facebook OAuth token into connected_meta_accounts.
 * Mapping an account to a client is a separate, access-checked step
 * (the admin "map account" flow) — this route never maps.
 */
export async function POST() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const result = await syncConnectedMetaAccounts({
      source: "facebook_oauth",
    });

    return jsonOk({ count: result.count, accounts: result.upserted });
  });
}
