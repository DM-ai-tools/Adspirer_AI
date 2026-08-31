import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import {
  loadMappedMetaAccounts,
  resolvePrimaryMetaAccount,
} from "@/lib/adspirer/resolve-meta-account";
import { getConnectionSources } from "@/lib/adspirer/connection-source";
import { getConfig } from "@/lib/config";
import { jsonOk, withApiHandler } from "@/lib/api/response";

/**
 * GET /api/v2/clients/:clientId/meta-account
 * Workspace V2: which ad account chat will use for this client.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ clientId: string }> },
) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    const { clientId } = await context.params;
    await assertClientAccess(user.id, clientId);

    const [accounts, primary] = await Promise.all([
      loadMappedMetaAccounts(clientId),
      resolvePrimaryMetaAccount(clientId),
    ]);

    let facebookConnected = false;
    const config = getConfig();
    if (config.hasSupabase && !config.isDemoMode) {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();
      const { data } = await supabase
        .from("meta_oauth_tokens")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      facebookConnected = Boolean(data);
    }

    return jsonOk({
      clientId,
      facebookConnected,
      primaryAccount: primary
        ? {
            id: primary.id,
            meta_account_id: primary.meta_account_id,
            meta_account_name: primary.meta_account_name,
            access_status: primary.access_status,
            sources: getConnectionSources(primary),
            last_synced_at: primary.last_synced_at,
          }
        : null,
      mappedAccounts: accounts.map((a) => ({
        id: a.id,
        meta_account_id: a.meta_account_id,
        meta_account_name: a.meta_account_name,
        access_status: a.access_status,
        sources: getConnectionSources(a),
        last_synced_at: a.last_synced_at,
      })),
      ready: Boolean(primary && primary.access_status === "granted"),
    });
  });
}
