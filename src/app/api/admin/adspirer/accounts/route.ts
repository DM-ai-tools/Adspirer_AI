import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { mapConnectedMetaAccountRow } from "@/lib/adspirer/db-map";
import type { ConnectedMetaAccount } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const config = getConfig();

    if (config.isDemoMode || !config.hasSupabase) {
      return jsonOk({ accounts: getDemoStore().connectedMetaAccounts });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("connected_meta_accounts")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    return jsonOk({
      accounts: (data ?? []).map((row) =>
        mapConnectedMetaAccountRow(row as Record<string, unknown>),
      ) as ConnectedMetaAccount[],
    });
  });
}
