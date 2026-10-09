import { nanoid } from "nanoid";
import type { ConnectedMetaAccount } from "@/types";
import type { MetaAdsProvider } from "@/lib/adspirer/provider";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { resolveProvider } from "@/lib/adspirer/client";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";
import type { ConnectionSource } from "@/lib/adspirer/connection-source";

export type { ConnectionSource } from "@/lib/adspirer/connection-source";
export { getConnectionSources } from "@/lib/adspirer/connection-source";

export interface SyncAccountsResult {
  upserted: ConnectedMetaAccount[];
  count: number;
}

/**
 * Pull accessible Meta accounts from a provider and upsert into
 * connected_meta_accounts (demo store or Supabase).
 */
export async function syncConnectedMetaAccounts(options?: {
  clientId?: string | null;
  source?: ConnectionSource;
  provider?: MetaAdsProvider;
}): Promise<SyncAccountsResult> {
  const source: ConnectionSource = options?.source ?? "facebook_oauth";
  const provider =
    options?.provider ??
    (source === "facebook_oauth"
      ? await resolveProvider("meta_direct")
      : await resolveProvider());

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
        existing.raw = mergeSourceMeta(existing.raw, source, provider.name);
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
          raw: mergeSourceMeta(null, source, provider.name),
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
      source,
    });

    return { upserted, count: upserted.length };
  }

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
      .select("id, account_name, mapped_client_id, raw_metadata")
      .eq("external_account_id", account.meta_account_id)
      .maybeSingle();

    const existingName = (existingRow?.account_name as string | undefined) ?? "";
    const resolvedName =
      !looksLikeIdName(displayName)
        ? displayName
        : !looksLikeIdName(existingName)
          ? existingName
          : displayName;

    const existingRaw =
      (existingRow?.raw_metadata as Record<string, unknown> | null) ?? null;

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
      raw_metadata: mergeSourceMeta(existingRaw, source, provider.name),
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

    // Keep the client's cached account label fresh, but never rename the
    // client itself — operators name clients, not the ad account.
    if (mapped.client_id && !looksLikeIdName(resolvedName)) {
      await supabase
        .from("clients")
        .update({
          meta_account_name: resolvedName,
          meta_account_id: account.meta_account_id,
          updated_at: ts,
        })
        .eq("id", mapped.client_id);
    }
  }

  return { upserted, count: upserted.length };
}

function mergeSourceMeta(
  existing: Record<string, unknown> | null | undefined,
  source: ConnectionSource,
  providerName: string,
): Record<string, unknown> {
  const prev = existing ?? {};
  const prevSources = Array.isArray(prev.sources)
    ? (prev.sources as string[])
    : prev.synced_via
      ? [String(prev.synced_via)]
      : [];
  const sources = [...new Set([...prevSources, source])];
  return {
    ...prev,
    synced_via: source,
    sources,
    provider: providerName,
    last_source_sync: source,
  };
}

function looksLikeIdName(value: string | null | undefined): boolean {
  if (!value) return true;
  const n = value.trim();
  return /^act_\d+$/i.test(n) || /^\d{8,}$/.test(n);
}
