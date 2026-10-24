import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { createAdminClient } from "@/lib/supabase/admin";
import { nowIso } from "@/lib/utils";
import type { ShopifyConnection, ShopifySalesRow, ShopifySyncCounts } from "./types";

/**
 * Persistence for the Shopify connection and its synced sales (demo store or Supabase).
 * The connection row holds only the encrypted token: never log it or pass it to a
 * browser-facing response. The catalogue is read live (live.ts) and never stored; the
 * old catalogue tables (00013) are only ever cleared here, never written or read.
 */

const CONNECTION = "shopify_connection";
const COLLECTIONS = "shopify_collections";
const PRODUCTS = "shopify_products";
const VARIANTS = "shopify_variants";
const SALES = "shopify_sales";
const CHUNK = 500;
const PAGE = 1000;

function inDemoStore(): boolean {
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase;
}

function copyConnection(row: ShopifyConnection): ShopifyConnection {
  return {
    ...row,
    scopes: [...row.scopes],
    last_sync_counts: row.last_sync_counts ? { ...row.last_sync_counts } : null,
  };
}

export async function getConnection(clientId: string): Promise<ShopifyConnection | null> {
  if (inDemoStore()) {
    const row = getDemoStore().shopifyConnections.find((c) => c.client_id === clientId);
    return row ? copyConnection(row) : null;
  }
  const { data, error } = await createAdminClient().from(CONNECTION).select("*").eq("client_id", clientId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ShopifyConnection | null) ?? null;
}

/** Sync status for a store that has never been synced (also used when the store changes). */
const NEVER_SYNCED = {
  last_sync_at: null,
  last_sync_status: "never" as const,
  last_sync_error: null,
  last_sync_counts: null,
};

/**
 * Saves (or replaces) the client's connection. Reconnecting the same store keeps its
 * sync status and sales; connecting a different store drops the old store's sales
 * (and any leftover rows of the old catalogue sync) and resets the sync status to "never".
 */
export async function saveConnection(input: {
  clientId: string;
  shopDomain: string;
  shopName: string | null;
  currency: string | null;
  scopes: string[];
  accessTokenEncrypted: string;
  connectedBy: string | null;
}): Promise<ShopifyConnection> {
  const now = nowIso();
  if (inDemoStore()) {
    const store = getDemoStore();
    const fields = {
      shop_domain: input.shopDomain,
      shop_name: input.shopName,
      currency: input.currency,
      access_token_encrypted: input.accessTokenEncrypted,
      scopes: [...input.scopes],
      connected_by: input.connectedBy,
      updated_at: now,
    };
    const existing = store.shopifyConnections.find((c) => c.client_id === input.clientId);
    if (existing) {
      const storeChanged = existing.shop_domain !== input.shopDomain;
      Object.assign(existing, fields, { connected_at: now }, storeChanged ? NEVER_SYNCED : {});
      if (storeChanged) store.shopifySales = store.shopifySales.filter((r) => r.client_id !== input.clientId);
      return copyConnection(existing);
    }
    const row: ShopifyConnection = {
      id: randomUUID(),
      client_id: input.clientId,
      ...fields,
      connected_at: now,
      last_sync_at: null,
      last_sync_status: "never",
      last_sync_error: null,
      last_sync_counts: null,
      created_at: now,
    };
    store.shopifyConnections.push(row);
    return copyConnection(row);
  }

  const previous = await getConnection(input.clientId);
  const storeChanged = previous !== null && previous.shop_domain !== input.shopDomain;
  // Sync status columns are sent only when the store changed, so reconnecting the same
  // store keeps them.
  const { data, error } = await createAdminClient()
    .from(CONNECTION)
    .upsert(
      {
        client_id: input.clientId,
        shop_domain: input.shopDomain,
        shop_name: input.shopName,
        currency: input.currency,
        access_token_encrypted: input.accessTokenEncrypted,
        scopes: input.scopes,
        connected_by: input.connectedBy,
        connected_at: now,
        ...(storeChanged ? NEVER_SYNCED : {}),
      },
      { onConflict: "client_id" },
    )
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  if (storeChanged) {
    // After the status reset, so a failed delete leaves old rows under a "never synced"
    // status (chat reads nothing) rather than the old store's data under the new name.
    await deleteCatalogRows(input.clientId);
    await deleteSalesRows(input.clientId);
  }
  return data as ShopifyConnection;
}

export async function setSyncStatus(
  clientId: string,
  patch: { status: "running" | "ok" | "error"; error?: string | null; counts?: ShopifySyncCounts },
): Promise<void> {
  const now = nowIso();
  const fields: Record<string, unknown> = {
    last_sync_status: patch.status,
    last_sync_error: patch.error ?? null,
    // Explicit so a repeat "running" write still changes the row (heartbeat) on Supabase.
    updated_at: now,
  };
  if (patch.status === "ok") fields.last_sync_at = now;
  if (patch.counts) fields.last_sync_counts = patch.counts;

  if (inDemoStore()) {
    const row = getDemoStore().shopifyConnections.find((c) => c.client_id === clientId);
    if (!row) return;
    Object.assign(row, fields, { updated_at: now, ...(patch.counts ? { last_sync_counts: { ...patch.counts } } : {}) });
    return;
  }
  const { error } = await createAdminClient().from(CONNECTION).update(fields).eq("client_id", clientId);
  if (error) throw new Error(error.message);
}

/** Client ids that have a Shopify connection (for the cron sync). */
export async function listConnectedClientIds(): Promise<string[]> {
  if (inDemoStore()) return getDemoStore().shopifyConnections.map((c) => c.client_id);
  const { data, error } = await createAdminClient().from(CONNECTION).select("client_id");
  if (error) throw new Error(error.message);
  return ((data as Array<{ client_id: string }> | null) ?? []).map((r) => r.client_id);
}

async function deleteSalesRows(clientId: string): Promise<void> {
  const { error } = await createAdminClient().from(SALES).delete().eq("client_id", clientId);
  if (error) throw new Error(error.message);
}

type SalesInput = Omit<ShopifySalesRow, "client_id">;

/**
 * Write the client's sales, then drop rows this run did not touch. Each chunk is tagged with
 * a fresh synced_run as it is written (no second copy of all rows); if any upsert (or the
 * onChunk callback) throws, nothing is deleted and the old rows stay. `onChunk` runs after
 * each written chunk, for the sync's heartbeat.
 */
export async function replaceSales(
  clientId: string,
  rows: SalesInput[],
  onChunk?: () => Promise<void>,
): Promise<void> {
  if (inDemoStore()) {
    // Built apart and swapped in at the end, so a throwing onChunk leaves the old rows.
    const next: ShopifySalesRow[] = [];
    for (let i = 0; i < rows.length; i += CHUNK) {
      for (const r of rows.slice(i, i + CHUNK)) next.push({ ...r, client_id: clientId });
      if (onChunk) await onChunk();
    }
    const store = getDemoStore();
    store.shopifySales = [...store.shopifySales.filter((r) => r.client_id !== clientId), ...next];
    return;
  }

  const db = createAdminClient();
  const run = randomUUID();
  const now = nowIso();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({ ...r, client_id: clientId, synced_run: run, updated_at: now }));
    const { error } = await db.from(SALES).upsert(chunk, { onConflict: "client_id,variant_key" });
    if (error) throw new Error(error.message);
    if (onChunk) await onChunk();
  }
  const { error } = await db.from(SALES).delete().eq("client_id", clientId).neq("synced_run", run);
  if (error) throw new Error(error.message);
}

/** The columns loadSales reads: the same fields on both backends (no synced_run / updated_at). */
const SALES_COLUMNS = [
  "client_id",
  "variant_key",
  "variant_gid",
  "product_gid",
  "product_title",
  "variant_title",
  "sku",
  "vendor",
  "product_type",
  "units_30d",
  "revenue_30d_cents",
  "units_60d",
  "revenue_60d_cents",
] as const satisfies ReadonlyArray<keyof ShopifySalesRow>;

/** A fresh row holding exactly the ShopifySalesRow fields (anything else is dropped). */
function pickSales(row: ShopifySalesRow): ShopifySalesRow {
  return {
    client_id: row.client_id,
    variant_key: row.variant_key,
    variant_gid: row.variant_gid,
    product_gid: row.product_gid,
    product_title: row.product_title,
    variant_title: row.variant_title,
    sku: row.sku,
    vendor: row.vendor,
    product_type: row.product_type,
    units_30d: row.units_30d,
    revenue_30d_cents: row.revenue_30d_cents,
    units_60d: row.units_60d,
    revenue_60d_cents: row.revenue_60d_cents,
  };
}

export async function loadSales(clientId: string): Promise<ShopifySalesRow[]> {
  if (inDemoStore()) {
    return getDemoStore().shopifySales.filter((r) => r.client_id === clientId).map(pickSales);
  }
  const db = createAdminClient();
  const out: ShopifySalesRow[] = [];
  // PostgREST caps a response at 1000 rows, so page until a short page comes back.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(SALES)
      .select(SALES_COLUMNS.join(","))
      .eq("client_id", clientId)
      .order("variant_key")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const page = (data as unknown as ShopifySalesRow[] | null) ?? [];
    out.push(...page.map(pickSales));
    if (page.length < PAGE) return out;
  }
}

/** Clears leftover rows of the old catalogue sync (tables from 00013, no longer written). */
async function deleteCatalogRows(clientId: string): Promise<void> {
  const db = createAdminClient();
  for (const table of [VARIANTS, PRODUCTS, COLLECTIONS]) {
    const { error } = await db.from(table).delete().eq("client_id", clientId);
    if (error) throw new Error(error.message);
  }
}

export async function deleteConnection(clientId: string): Promise<void> {
  if (inDemoStore()) {
    const store = getDemoStore();
    store.shopifyConnections = store.shopifyConnections.filter((r) => r.client_id !== clientId);
    store.shopifySales = store.shopifySales.filter((r) => r.client_id !== clientId);
    return;
  }
  const db = createAdminClient();
  for (const table of [SALES, VARIANTS, PRODUCTS, COLLECTIONS, CONNECTION]) {
    const { error } = await db.from(table).delete().eq("client_id", clientId);
    if (error) throw new Error(error.message);
  }
}
