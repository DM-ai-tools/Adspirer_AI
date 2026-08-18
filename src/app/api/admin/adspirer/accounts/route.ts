import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { getActiveServiceAccount } from "@/lib/adspirer/token-service";
import { mapConnectedMetaAccountRow } from "@/lib/adspirer/db-map";
import type { ConnectedMetaAccount } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const serviceAccount = await getActiveServiceAccount();
    const config = getConfig();

    if (config.isDemoMode || !config.hasSupabase) {
      return jsonOk({
        serviceAccount: serviceAccount
          ? {
              id: serviceAccount.id,
              label: serviceAccount.label,
              is_active: serviceAccount.is_active,
              token_expires_at: serviceAccount.token_expires_at,
              scopes: serviceAccount.scopes,
              last_refreshed_at: serviceAccount.last_refreshed_at,
            }
          : null,
        accounts: getDemoStore().connectedMetaAccounts,
        apiKeyConfigured: Boolean(config.ADSPIRER_API_KEY),
      });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("connected_meta_accounts")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    return jsonOk({
      serviceAccount: serviceAccount
        ? {
            id: serviceAccount.id,
            label: serviceAccount.label,
            is_active: serviceAccount.is_active,
            token_expires_at: serviceAccount.token_expires_at,
            scopes: serviceAccount.scopes,
            last_refreshed_at: serviceAccount.last_refreshed_at,
          }
        : null,
      accounts: (data ?? []).map((row) =>
        mapConnectedMetaAccountRow(row as Record<string, unknown>),
      ) as ConnectedMetaAccount[],
      apiKeyConfigured: Boolean(config.ADSPIRER_API_KEY),
    });
  });
}
