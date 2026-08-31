import type { ConnectedMetaAccount } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import {
  getConnectionSources,
  type ConnectionSource,
} from "@/lib/adspirer/connection-source";
import { getWorkspaceContext } from "@/lib/runtime/workspace-context";

function grantedAccounts(
  accounts: ConnectedMetaAccount[],
): ConnectedMetaAccount[] {
  return accounts.filter((a) => a.access_status === "granted");
}

function sortByRecentSync(
  accounts: ConnectedMetaAccount[],
): ConnectedMetaAccount[] {
  return [...accounts].sort((a, b) => {
    const aTs = a.last_synced_at ? Date.parse(a.last_synced_at) : 0;
    const bTs = b.last_synced_at ? Date.parse(b.last_synced_at) : 0;
    return bTs - aTs;
  });
}

function normalizeActId(value: string): string {
  return value.startsWith("act_") ? value : `act_${value}`;
}

/** All Meta ad accounts mapped to a client (granted or not). */
export async function loadMappedMetaAccounts(
  clientId: string,
): Promise<ConnectedMetaAccount[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().connectedMetaAccounts.filter(
      (a) => a.client_id === clientId,
    );
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { mapConnectedMetaAccountRow } = await import("@/lib/adspirer/db-map");
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("connected_meta_accounts")
    .select("*")
    .eq("mapped_client_id", clientId)
    .order("last_synced_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((row) =>
    mapConnectedMetaAccountRow(row as Record<string, unknown>),
  );
}

async function loadClientPreferredMetaAccountId(
  clientId: string,
): Promise<string | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const client = getDemoStore().clients.find((c) => c.id === clientId);
    const id = (client as { meta_account_id?: string } | undefined)
      ?.meta_account_id;
    return id ? normalizeActId(id) : null;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("clients")
    .select("meta_account_id")
    .eq("id", clientId)
    .maybeSingle();

  const id = data?.meta_account_id as string | undefined;
  return id ? normalizeActId(id) : null;
}

function pickPrimaryAccount(
  accounts: ConnectedMetaAccount[],
  options?: {
    preferredAccountId?: string | null;
    preferSource?: ConnectionSource;
  },
): ConnectedMetaAccount | null {
  const granted = grantedAccounts(accounts);
  if (!granted.length) return null;

  if (options?.preferredAccountId) {
    const preferred = normalizeActId(options.preferredAccountId);
    const exact = granted.find(
      (a) => normalizeActId(a.meta_account_id) === preferred,
    );
    if (exact) return exact;
  }

  const preferSource =
    options?.preferSource ??
    (getWorkspaceContext()?.version === "v2" ? "facebook_oauth" : undefined);

  if (preferSource) {
    const fromSource = sortByRecentSync(
      granted.filter((a) => getConnectionSources(a).includes(preferSource)),
    );
    if (fromSource.length) return fromSource[0];
  }

  return sortByRecentSync(granted)[0] ?? null;
}

/** Primary act_* id used by V2 chat and Meta API routes for this client. */
export async function resolvePrimaryAccountId(
  clientId: string,
): Promise<string | null> {
  const accounts = await loadMappedMetaAccounts(clientId);
  const granted = grantedAccounts(accounts);
  if (!granted.length) return null;

  const ctxAccountId = getWorkspaceContext()?.metaAccountId;
  if (ctxAccountId) {
    const override = normalizeActId(ctxAccountId);
    const match = granted.find(
      (a) => normalizeActId(a.meta_account_id) === override,
    );
    if (match) return match.meta_account_id;
  }

  const preferredAccountId = await loadClientPreferredMetaAccountId(clientId);
  return (
    pickPrimaryAccount(granted, { preferredAccountId })?.meta_account_id ?? null
  );
}

export async function resolvePrimaryMetaAccount(
  clientId: string,
): Promise<ConnectedMetaAccount | null> {
  const accounts = await loadMappedMetaAccounts(clientId);
  const granted = grantedAccounts(accounts);
  if (!granted.length) return null;

  const ctxAccountId = getWorkspaceContext()?.metaAccountId;
  if (ctxAccountId) {
    const override = normalizeActId(ctxAccountId);
    const match = granted.find(
      (a) => normalizeActId(a.meta_account_id) === override,
    );
    if (match) return match;
  }

  const preferredAccountId = await loadClientPreferredMetaAccountId(clientId);
  return pickPrimaryAccount(granted, { preferredAccountId });
}
