import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated } from "@/lib/authz/assert";
import { syncConnectedMetaAccounts } from "@/lib/adspirer/account-sync";
import { jsonOk, withApiHandler } from "@/lib/api/response";

/**
 * POST /api/auth/meta/sync
 * Syncs ad accounts from the user's Facebook OAuth token into connected_meta_accounts.
 */
export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    let clientId: string | null = null;
    try {
      const body = (await request.json()) as { clientId?: string };
      clientId = body.clientId ?? null;
    } catch {
      // empty body is fine
    }

    const result = await syncConnectedMetaAccounts({
      source: "facebook_oauth",
      clientId,
    });

    return jsonOk({ count: result.count, accounts: result.upserted });
  });
}
