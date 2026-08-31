import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import {
  getConnectionSources,
  type ConnectionSource,
} from "@/lib/adspirer/connection-source";
import { nowIso } from "@/lib/utils";
import type { ConnectedMetaAccount } from "@/types";

export type RemoveConnectedAccountResult = {
  accountId: string;
  deleted: boolean;
  remainingSources?: ConnectionSource[];
};

function stripSource(
  account: ConnectedMetaAccount,
  source: ConnectionSource,
): ConnectionSource[] {
  return getConnectionSources(account).filter((s) => s !== source);
}

async function findAccountRow(
  accountId: string,
): Promise<ConnectedMetaAccount | null> {
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    return (
      store.connectedMetaAccounts.find(
        (a) => a.id === accountId || a.meta_account_id === accountId,
      ) ?? null
    );
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { mapConnectedMetaAccountRow } = await import("@/lib/adspirer/db-map");
  const supabase = createAdminClient();

  const { data: byId } = await supabase
    .from("connected_meta_accounts")
    .select("*")
    .eq("id", accountId)
    .maybeSingle();

  if (byId) {
    return mapConnectedMetaAccountRow(byId as Record<string, unknown>);
  }

  const { data: byExternal } = await supabase
    .from("connected_meta_accounts")
    .select("*")
    .eq("external_account_id", accountId)
    .maybeSingle();

  return byExternal
    ? mapConnectedMetaAccountRow(byExternal as Record<string, unknown>)
    : null;
}

/**
 * Remove a synced Meta ad account from Connections.
 * If the row was synced via multiple sources, only the requested source is removed.
 */
export async function removeConnectedMetaAccount(
  accountId: string,
  options?: { source?: ConnectionSource },
): Promise<RemoveConnectedAccountResult> {
  const account = await findAccountRow(accountId);
  if (!account) {
    throw new Error("Connected Meta account not found");
  }

  const sources = getConnectionSources(account);
  const source = options?.source;
  const shouldStripSource =
    Boolean(source) && sources.length > 1 && sources.includes(source!);
  const ts = nowIso();
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.connectedMetaAccounts.findIndex((a) => a.id === account.id);
    if (idx === -1) {
      throw new Error("Connected Meta account not found");
    }

    if (shouldStripSource && source) {
      const remaining = stripSource(account, source);
      const row = store.connectedMetaAccounts[idx];
      row.raw = {
        ...(row.raw ?? {}),
        sources: remaining,
        synced_via: remaining[0],
        last_source_removed: source,
      };
      row.updated_at = ts;
      return { accountId: row.id, deleted: false, remainingSources: remaining };
    }

    store.connectedMetaAccounts.splice(idx, 1);
    return { accountId: account.id, deleted: true };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();

  if (shouldStripSource && source) {
    const remaining = stripSource(account, source);
    const { error } = await supabase
      .from("connected_meta_accounts")
      .update({
        raw_metadata: {
          ...(account.raw ?? {}),
          sources: remaining,
          synced_via: remaining[0],
          last_source_removed: source,
        },
        updated_at: ts,
      })
      .eq("id", account.id);

    if (error) throw new Error(error.message);
    return { accountId: account.id, deleted: false, remainingSources: remaining };
  }

  const { error } = await supabase
    .from("connected_meta_accounts")
    .delete()
    .eq("id", account.id);

  if (error) throw new Error(error.message);
  return { accountId: account.id, deleted: true };
}

/** Deactivate the shared Adspirer OAuth service account. */
export async function disconnectAdspirerServiceAccount(): Promise<void> {
  const config = getConfig();
  const ts = nowIso();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    for (const account of store.adspirerServiceAccounts) {
      account.is_active = false;
      account.updated_at = ts;
    }
    return;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("adspirer_service_account")
    .update({
      is_active: false,
      connection_status: "disconnected",
      updated_at: ts,
    })
    .eq("is_active", true);

  if (error) throw new Error(error.message);
}
