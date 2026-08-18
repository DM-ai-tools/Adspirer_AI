import { nanoid } from "nanoid";
import type { ConnectedMetaAccount } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getLiveAdspirerProvider, getProvider } from "@/lib/adspirer/client";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";

export interface SyncAccountsResult {
  upserted: ConnectedMetaAccount[];
  count: number;
}

/**
 * Pull accessible Meta accounts from the provider and upsert into
 * connected_meta_accounts (demo store or Supabase).
 */
export async function syncConnectedMetaAccounts(options?: {
  clientId?: string | null;
}): Promise<SyncAccountsResult> {
  const provider = getLiveAdspirerProvider() ?? getProvider();
  const accounts = await provider.listAccessibleAccounts();
  const ts = nowIso();
  const config = getConfig();

  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const upserted: ConnectedMetaAccount[] = [];

    for (const account of accounts) {
      const existing = store.connectedMetaAccounts.find(
        (a) => a.meta_account_id === account.meta_account_id,
      );

      if (existing) {
        existing.meta_account_name = account.meta_account_name;
        existing.currency = account.currency ?? existing.currency;
        existing.timezone = account.timezone ?? existing.timezone;
        existing.business_id = account.business_id ?? existing.business_id;
        existing.last_synced_at = ts;
        existing.updated_at = ts;
        if (options?.clientId) existing.client_id = options.clientId;
        upserted.push(existing);
      } else {
        const row: ConnectedMetaAccount = {
          id: `meta_acc_${nanoid(8)}`,
          client_id: options?.clientId ?? null,
          meta_account_id: account.meta_account_id,
          meta_account_name: account.meta_account_name,
          currency: account.currency ?? null,
          timezone: account.timezone ?? null,
          business_id: account.business_id ?? null,
          access_status: "granted",
          access_method: "direct_grant",
          last_synced_at: ts,
          raw: { synced_via: provider.name },
          created_at: ts,
          updated_at: ts,
        };
        store.connectedMetaAccounts.push(row);
        upserted.push(row);
      }
    }

    logger.info("Synced connected Meta accounts (demo)", {
      count: upserted.length,
      provider: provider.name,
    });

    return { upserted, count: upserted.length };
  }

  // Live Supabase path
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { mapConnectedMetaAccountRow } = await import("@/lib/adspirer/db-map");
  const supabase = createAdminClient();
  const upserted: ConnectedMetaAccount[] = [];

  for (const account of accounts) {
    const displayName = looksLikeIdName(account.meta_account_name)
      ? account.meta_account_id
      : account.meta_account_name;

    const { data: existingRow } = await supabase
      .from("connected_meta_accounts")
      .select("id, account_name, mapped_client_id")
      .eq("external_account_id", account.meta_account_id)
      .maybeSingle();

    const existingName = (existingRow?.account_name as string | undefined) ?? "";
    const resolvedName =
      !looksLikeIdName(displayName)
        ? displayName
        : !looksLikeIdName(existingName)
          ? existingName
          : displayName;

    const payload = {
      mapped_client_id:
        options?.clientId ??
        (existingRow?.mapped_client_id as string | null | undefined) ??
        null,
      external_account_id: account.meta_account_id,
      account_name: resolvedName,
      currency: account.currency ?? null,
      timezone: account.timezone ?? null,
      business_id: account.business_id ?? null,
      access_status: "granted" as const,
      status: "active" as const,
      last_synced_at: ts,
      updated_at: ts,
      raw_metadata: { synced_via: provider.name },
    };

    const { data, error } = await supabase
      .from("connected_meta_accounts")
      .upsert(payload, { onConflict: "external_account_id" })
      .select("*")
      .single();

    if (error) {
      logger.error("Failed to upsert connected Meta account", {
        meta_account_id: account.meta_account_id,
        error: error.message,
      });
      continue;
    }

    const mapped = mapConnectedMetaAccountRow(data as Record<string, unknown>);
    upserted.push(mapped);

    // Keep linked client label in sync when we finally learn the display name.
    if (mapped.client_id && !looksLikeIdName(resolvedName)) {
      await supabase
        .from("clients")
        .update({
          name: resolvedName,
          meta_account_name: resolvedName,
          meta_account_id: account.meta_account_id,
          updated_at: ts,
        })
        .eq("id", mapped.client_id);
    }
  }

  return { upserted, count: upserted.length };
}

function looksLikeIdName(value: string | null | undefined): boolean {
  if (!value) return true;
  const n = value.trim();
  return /^act_\d+$/i.test(n) || /^\d{8,}$/.test(n);
}
