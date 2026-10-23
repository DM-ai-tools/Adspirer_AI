import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { createAdminClient } from "@/lib/supabase/admin";
import { nowIso } from "@/lib/utils";
import type {
  ShopifyCollection,
  ShopifyConnection,
  ShopifyProduct,
  ShopifySyncCounts,
  ShopifyVariant,
} from "./types";

/**
 * Persistence for the Shopify connection and its synced catalogue (demo store or
 * Supabase). The connection row holds only the encrypted token: never log it or
 * pass it to a browser-facing response.
 */

const CONNECTION = "shopify_connection";
const COLLECTIONS = "shopify_collections";
const PRODUCTS = "shopify_products";
const VARIANTS = "shopify_variants";
const CHUNK = 500;
const PAGE = 1000;

export type ShopifyCatalog = {
  collections: ShopifyCollection[];
  products: ShopifyProduct[];
  variants: ShopifyVariant[];
};

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

function copyProduct(row: ShopifyProduct): ShopifyProduct {
  return { ...row, collection_gids: [...row.collection_gids] };
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
 * sync status and catalogue; connecting a different store drops the old store's
 * catalogue rows and resets the sync status to "never".
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
      if (storeChanged) {
        const other = <T extends { client_id: string }>(rows: T[]) => rows.filter((r) => r.client_id !== input.clientId);
        store.shopifyCollections = other(store.shopifyCollections);
        store.shopifyProducts = other(store.shopifyProducts);
        store.shopifyVariants = other(store.shopifyVariants);
      }
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

async function upsertChunks(table: string, rows: Array<Record<string, unknown>>): Promise<void> {
  const db = createAdminClient();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict: "client_id,gid" });
    if (error) throw new Error(error.message);
  }
}

/**
 * Write the new catalogue, then drop rows the sync did not touch. Rows are tagged with a
 * fresh synced_run; if any upsert fails nothing is deleted and the old data stays.
 */
export async function replaceCatalog(clientId: string, data: ShopifyCatalog): Promise<void> {
  if (inDemoStore()) {
    const store = getDemoStore();
    const keep = <T extends { client_id: string }>(rows: T[]) => rows.filter((r) => r.client_id !== clientId);
    store.shopifyCollections = [...keep(store.shopifyCollections), ...data.collections.map((r) => ({ ...r, client_id: clientId }))];
    store.shopifyProducts = [...keep(store.shopifyProducts), ...data.products.map((r) => ({ ...copyProduct(r), client_id: clientId }))];
    store.shopifyVariants = [...keep(store.shopifyVariants), ...data.variants.map((r) => ({ ...r, client_id: clientId }))];
    return;
  }

  const run = randomUUID();
  const now = nowIso();
  const tag = <T extends object>(rows: T[]) =>
    rows.map((r) => ({ ...r, client_id: clientId, synced_run: run, updated_at: now }));

  await upsertChunks(COLLECTIONS, tag(data.collections));
  await upsertChunks(PRODUCTS, tag(data.products));
  await upsertChunks(VARIANTS, tag(data.variants));

  const db = createAdminClient();
  for (const table of [COLLECTIONS, PRODUCTS, VARIANTS]) {
    const { error } = await db.from(table).delete().eq("client_id", clientId).neq("synced_run", run);
    if (error) throw new Error(error.message);
  }
}

export async function loadCatalog(clientId: string): Promise<ShopifyCatalog> {
  if (inDemoStore()) {
    const store = getDemoStore();
    return {
      collections: store.shopifyCollections.filter((r) => r.client_id === clientId).map((r) => ({ ...r })),
      products: store.shopifyProducts.filter((r) => r.client_id === clientId).map(copyProduct),
      variants: store.shopifyVariants.filter((r) => r.client_id === clientId).map((r) => ({ ...r })),
    };
  }
  const db = createAdminClient();
  const read = async <T>(table: string): Promise<T[]> => {
    // PostgREST caps a response at 1000 rows, so page until a short page comes back.
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await db
        .from(table)
        .select("*")
        .eq("client_id", clientId)
        .order("gid")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const page = (data as T[] | null) ?? [];
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  };
  const [collections, products, variants] = await Promise.all([
    read<ShopifyCollection>(COLLECTIONS),
    read<ShopifyProduct>(PRODUCTS),
    read<ShopifyVariant>(VARIANTS),
  ]);
  return { collections, products, variants };
}

/** Client ids that have a Shopify connection (for the cron sync). */
export async function listConnectedClientIds(): Promise<string[]> {
  if (inDemoStore()) return getDemoStore().shopifyConnections.map((c) => c.client_id);
  const { data, error } = await createAdminClient().from(CONNECTION).select("client_id");
  if (error) throw new Error(error.message);
  return ((data as Array<{ client_id: string }> | null) ?? []).map((r) => r.client_id);
}

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
    store.shopifyCollections = store.shopifyCollections.filter((r) => r.client_id !== clientId);
    store.shopifyProducts = store.shopifyProducts.filter((r) => r.client_id !== clientId);
    store.shopifyVariants = store.shopifyVariants.filter((r) => r.client_id !== clientId);
    return;
  }
  const db = createAdminClient();
  for (const table of [VARIANTS, PRODUCTS, COLLECTIONS, CONNECTION]) {
    const { error } = await db.from(table).delete().eq("client_id", clientId);
    if (error) throw new Error(error.message);
  }
}
