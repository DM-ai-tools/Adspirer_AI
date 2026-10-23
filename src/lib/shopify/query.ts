import { getConnection, loadCatalog } from "./store";
import {
  SHOPIFY_STALE_HOURS,
  type ShopifyCollection,
  type ShopifyProduct,
  type ShopifyProductStatus,
  type ShopifyVariant,
} from "./types";

/**
 * Pure read functions over the synced Shopify catalogue (backs the chat tools).
 * Money out is major units rounded to 2 dp; unknown values are null, never 0.
 */

export const SALES_NOTE =
  "Sales are line revenue after product and code discounts, before order-level discounts, shipping and tax; " +
  "gross of refunds (refunded and removed units still count); cancelled and test orders are excluded; " +
  "windows are the rolling 30 and 60 days up to the sync time.";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export type ShopifyReadMeta = {
  synced_at: string | null;
  synced_ago: string | null;
  stale: boolean;
  currency: string | null;
  note: string;
};

export type ShopifyUnavailable =
  | { connected: false; message: string }
  | { connected: true; synced_at: null; message: string };

const money = (cents: number): number => Math.round(cents) / 100;
const moneyOrNull = (cents: number | null): number | null => (cents === null ? null : money(cents));
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Server-side relative time ("3 hours ago"). */
export function describeAgo(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Said wherever synced data is shown while the latest sync failed. */
export function describeFailedSync(error: string, syncedAgo: string): string {
  return `The latest sync failed (${error}); data is from the last successful sync ${syncedAgo}.`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

type Loaded = {
  meta: ShopifyReadMeta;
  collections: ShopifyCollection[];
  products: ShopifyProduct[];
  variants: ShopifyVariant[];
};

async function load(clientId: string, now: Date): Promise<Loaded | ShopifyUnavailable> {
  const conn = await getConnection(clientId);
  if (!conn) {
    return { connected: false, message: "No Shopify store is connected for this client." };
  }
  // last_sync_error is fixed text written by the sync (never raw Shopify output).
  const failed = conn.last_sync_status === "error" ? (conn.last_sync_error ?? "no reason recorded") : null;
  if (!conn.last_sync_at) {
    return {
      connected: true,
      synced_at: null,
      message: failed
        ? `The Shopify store is connected but not synced yet: the latest sync failed (${failed}). Ask an admin to check the connection and run a sync.`
        : "The Shopify store is connected but not synced yet. Ask an admin to run a sync.",
    };
  }
  const ageHours = (now.getTime() - new Date(conn.last_sync_at).getTime()) / 3_600_000;
  const stale = ageHours > SHOPIFY_STALE_HOURS;
  const synced_ago = describeAgo(conn.last_sync_at, now);
  let note = SALES_NOTE;
  if (stale) {
    note += ` Data is stale: last synced ${synced_ago} (older than ${SHOPIFY_STALE_HOURS} hours), so numbers may not reflect the store now.`;
  }
  if (failed) note += ` ${describeFailedSync(failed, synced_ago)}`;
  const catalog = await loadCatalog(clientId);
  return {
    meta: { synced_at: conn.last_sync_at, synced_ago, stale, currency: conn.currency, note },
    ...catalog,
  };
}

const unavailable = (x: Loaded | ShopifyUnavailable): x is ShopifyUnavailable => "message" in x;

const eq = (a: string | null | undefined, b: string): boolean => (a ?? "").toLowerCase() === b.toLowerCase();
const has = (a: string | null | undefined, b: string): boolean => (a ?? "").toLowerCase().includes(b.toLowerCase());

/** Gids of collections matching a title or handle. Unknown -> null. */
function collectionFilter(collections: ShopifyCollection[], wanted: string): Set<string> | null {
  const w = wanted.trim();
  const hits = collections.filter((c) => eq(c.title, w) || eq(c.handle, w));
  if (hits.length === 0) return null;
  return new Set(hits.map((c) => c.gid));
}

function unknownCollectionNote(meta: ShopifyReadMeta, wanted: string, collections: ShopifyCollection[]): string {
  const titles = collections.map((c) => c.title).join(", ") || "none";
  return `${meta.note} No collection matches "${wanted}". Available collections: ${titles}.`;
}

function sortRows<T>(rows: T[], key: (r: T) => number | string | null, desc: boolean): T[] {
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1; // nulls always last
    if (y === null) return -1;
    const cmp = typeof x === "string" && typeof y === "string" ? x.localeCompare(y) : (x as number) - (y as number);
    return desc ? -cmp : cmp;
  });
}


const LIST_CAP = 30;

function distinctSorted(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b)).slice(0, LIST_CAP);
}

/** Note appended when a filtered query matches nothing, so an empty result is explained. */
function missNote(
  applied: Array<[string, string | undefined]>,
  options: { vendors: string[]; types: string[]; sku?: string },
): string {
  const used = applied.filter(([, v]) => v !== undefined && v !== "");
  if (used.length === 0) return "";
  let note = ` No rows matched ${used.map(([k, v]) => `${k}="${v}"`).join(", ")}.`;
  if (used.some(([k]) => k === "vendor")) note += ` Available vendors: ${options.vendors.join(", ") || "none"}.`;
  if (used.some(([k]) => k === "product_type")) note += ` Available product types: ${options.types.join(", ") || "none"}.`;
  if (options.sku) note += ` No variant has the exact SKU "${options.sku}"; try search for a partial match.`;
  return note;
}

function sortNote(requested: string | undefined, used: string, valid: string[]): string {
  let note = "";
  if (requested !== undefined && !valid.includes(requested)) {
    note += ` Unknown sort_by '${requested}', used ${used}.`;
  }
  if (used === "stock") note += " Sorted by stock: untracked stock is listed last.";
  return note;
}

function variantsByProduct(variants: ShopifyVariant[]): Map<string, ShopifyVariant[]> {
  const m = new Map<string, ShopifyVariant[]>();
  for (const v of variants) {
    const list = m.get(v.product_gid);
    if (list) list.push(v);
    else m.set(v.product_gid, [v]);
  }
  return m;
}

export type ProductRow = {
  title: string;
  vendor: string;
  product_type: string;
  status: string;
  collections: string[];
  variants: number;
  stock_units: number | null;
  untracked_variants: number;
  price_min: number | null;
  price_max: number | null;
  units_30d: number;
  revenue_30d: number;
  units_60d: number;
  revenue_60d: number;
};

export async function queryProducts(
  clientId: string,
  args: {
    search?: string;
    collection?: string;
    vendor?: string;
    product_type?: string;
    status?: ShopifyProductStatus;
    sort_by?: "units_30d" | "revenue_30d" | "units_60d" | "revenue_60d" | "stock" | "title";
    desc?: boolean;
    limit?: number;
  },
  now: Date = new Date(),
): Promise<(ShopifyReadMeta & { rows: ProductRow[]; total_matches: number }) | ShopifyUnavailable> {
  const data = await load(clientId, now);
  if (unavailable(data)) return data;
  const { meta, collections, products, variants } = data;
  const titleByGid = new Map(collections.map((c) => [c.gid, c.title]));
  const byProduct = variantsByProduct(variants);

  let note = meta.note;
  let list = products;
  if (args.collection) {
    const gids = collectionFilter(collections, args.collection);
    if (!gids) {
      return { ...meta, note: unknownCollectionNote(meta, args.collection, collections), rows: [], total_matches: 0 };
    }
    list = list.filter((p) => p.collection_gids.some((g) => gids.has(g)));
  }
  if (args.search) list = list.filter((p) => has(p.title, args.search!) || has(p.handle, args.search!));
  if (args.vendor) list = list.filter((p) => eq(p.vendor, args.vendor!.trim()));
  if (args.product_type) list = list.filter((p) => eq(p.product_type, args.product_type!.trim()));
  if (args.status) list = list.filter((p) => p.status === args.status);

  const rows = list.map((p): ProductRow => {
    const vs = byProduct.get(p.gid) ?? [];
    const tracked = vs.filter((v) => v.inventory_quantity !== null);
    const prices = vs.map((v) => v.price_cents);
    return {
      title: p.title,
      vendor: p.vendor,
      product_type: p.product_type,
      status: p.status,
      collections: p.collection_gids.map((g) => titleByGid.get(g)).filter((t): t is string => !!t),
      variants: vs.length,
      stock_units: tracked.length ? tracked.reduce((s, v) => s + (v.inventory_quantity ?? 0), 0) : null,
      untracked_variants: vs.length - tracked.length,
      price_min: prices.length ? money(Math.min(...prices)) : null,
      price_max: prices.length ? money(Math.max(...prices)) : null,
      units_30d: vs.reduce((s, v) => s + v.units_30d, 0),
      revenue_30d: money(vs.reduce((s, v) => s + v.revenue_30d_cents, 0)),
      units_60d: vs.reduce((s, v) => s + v.units_60d, 0),
      revenue_60d: money(vs.reduce((s, v) => s + v.revenue_60d_cents, 0)),
    };
  });

  const sortBy = args.sort_by ?? "units_30d";
  const key: Record<string, (r: ProductRow) => number | string | null> = {
    units_30d: (r) => r.units_30d,
    revenue_30d: (r) => r.revenue_30d,
    units_60d: (r) => r.units_60d,
    revenue_60d: (r) => r.revenue_60d,
    stock: (r) => r.stock_units,
    title: (r) => r.title,
  };
  const usedSort = key[sortBy] ? sortBy : "units_30d";
  const desc = args.desc ?? usedSort !== "title";
  const sorted = sortRows(rows, key[usedSort], desc);
  note += sortNote(args.sort_by, usedSort, Object.keys(key));
  if (sorted.length === 0) {
    note += missNote(
      [
        ["search", args.search],
        ["vendor", args.vendor],
        ["product_type", args.product_type],
        ["status", args.status],
      ],
      { vendors: distinctSorted(products.map((p) => p.vendor)), types: distinctSorted(products.map((p) => p.product_type)) },
    );
  }
  if (rows.some((r) => r.untracked_variants > 0)) {
    note +=
      " stock_units counts tracked variants only (null if none are tracked); untracked variants have unlimited stock and are shown in untracked_variants.";
  }
  return { ...meta, note, rows: sorted.slice(0, clampLimit(args.limit)), total_matches: sorted.length };
}

export type VariantRow = {
  product: string;
  variant: string;
  sku: string | null;
  vendor: string;
  price: number;
  cost: number | null;
  margin_pct: number | null;
  stock: number | null;
  units_30d: number;
  revenue_30d: number;
  units_60d: number;
  revenue_60d: number;
};

export async function queryVariants(
  clientId: string,
  args: {
    sku?: string;
    search?: string;
    collection?: string;
    vendor?: string;
    sort_by?: "units_30d" | "revenue_30d" | "stock" | "price";
    desc?: boolean;
    limit?: number;
  },
  now: Date = new Date(),
): Promise<(ShopifyReadMeta & { rows: VariantRow[]; total_matches: number }) | ShopifyUnavailable> {
  const data = await load(clientId, now);
  if (unavailable(data)) return data;
  const { meta, collections, products, variants } = data;
  const byGid = new Map(products.map((p) => [p.gid, p]));

  let gids: Set<string> | null = null;
  if (args.collection) {
    gids = collectionFilter(collections, args.collection);
    if (!gids) {
      return { ...meta, note: unknownCollectionNote(meta, args.collection, collections), rows: [], total_matches: 0 };
    }
  }

  const pairs = variants
    .map((v) => ({ v, p: byGid.get(v.product_gid) }))
    .filter((x): x is { v: ShopifyVariant; p: ShopifyProduct } => !!x.p)
    .filter(({ v, p }) => {
      if (gids && !p.collection_gids.some((g) => gids!.has(g))) return false;
      if (args.sku && !eq(v.sku, args.sku.trim())) return false;
      if (args.vendor && !eq(p.vendor, args.vendor.trim())) return false;
      if (args.search && !(has(p.title, args.search) || has(v.title, args.search) || has(v.sku, args.search))) return false;
      return true;
    });

  const rows = pairs.map(
    ({ v, p }): VariantRow => ({
      product: p.title,
      variant: v.title,
      sku: v.sku,
      vendor: p.vendor,
      price: money(v.price_cents),
      cost: moneyOrNull(v.cost_cents),
      margin_pct:
        v.cost_cents !== null && v.price_cents > 0 ? round2(((v.price_cents - v.cost_cents) / v.price_cents) * 100) : null,
      stock: v.inventory_quantity,
      units_30d: v.units_30d,
      revenue_30d: money(v.revenue_30d_cents),
      units_60d: v.units_60d,
      revenue_60d: money(v.revenue_60d_cents),
    }),
  );

  const sortBy = args.sort_by ?? "units_30d";
  const key: Record<string, (r: VariantRow) => number | null> = {
    units_30d: (r) => r.units_30d,
    revenue_30d: (r) => r.revenue_30d,
    stock: (r) => r.stock,
    price: (r) => r.price,
  };
  const usedSort = key[sortBy] ? sortBy : "units_30d";
  const sorted = sortRows(rows, key[usedSort], args.desc ?? true);
  let note = `${meta.note} stock null means untracked (unlimited); cost null means no cost recorded.`;
  note += sortNote(args.sort_by, usedSort, Object.keys(key));
  if (sorted.length === 0) {
    note += missNote(
      [
        ["sku", args.sku],
        ["search", args.search],
        ["vendor", args.vendor],
      ],
      {
        vendors: distinctSorted(products.map((p) => p.vendor)),
        types: [],
        sku: args.sku?.trim() ? args.sku.trim() : undefined,
      },
    );
  }
  return { ...meta, note, rows: sorted.slice(0, clampLimit(args.limit)), total_matches: sorted.length };
}

export type SummaryRow = {
  group: string;
  products: number;
  variants: number;
  stock_units: number | null;
  untracked_variants: number;
  units_30d: number;
  revenue_30d: number;
  units_60d: number;
  revenue_60d: number;
  margin_pct: number | null;
  cost_coverage: string;
};

const NO_COLLECTION = "(no collection)";

export async function summarizeCatalog(
  clientId: string,
  args: { group_by: "vendor" | "product_type" | "collection" },
  now: Date = new Date(),
): Promise<(ShopifyReadMeta & { rows: SummaryRow[] }) | ShopifyUnavailable> {
  const data = await load(clientId, now);
  if (unavailable(data)) return data;
  const { meta, collections, products, variants } = data;
  const titleByGid = new Map(collections.map((c) => [c.gid, c.title]));
  const byProduct = variantsByProduct(variants);

  const groups = new Map<string, ShopifyProduct[]>();
  const add = (g: string, p: ShopifyProduct) => {
    const list = groups.get(g);
    if (list) list.push(p);
    else groups.set(g, [p]);
  };
  for (const p of products) {
    if (args.group_by === "collection") {
      // Unknown collection gids are skipped (a raw gid is never shown as a group name).
      const titles = new Set(
        p.collection_gids.map((g) => titleByGid.get(g)).filter((t): t is string => t !== undefined),
      );
      if (titles.size === 0) add(NO_COLLECTION, p);
      for (const t of titles) add(t || "(untitled collection)", p);
    } else {
      add((args.group_by === "vendor" ? p.vendor : p.product_type) || "(none)", p);
    }
  }

  const rows = [...groups.entries()].map(([group, ps]): SummaryRow => {
    const vs = ps.flatMap((p) => byProduct.get(p.gid) ?? []);
    const trackedVs = vs.filter((v) => v.inventory_quantity !== null);
    const sold = vs.filter((v) => v.units_60d > 0);
    const costed = sold.filter((v) => v.cost_cents !== null && v.revenue_60d_cents > 0);
    const rev = costed.reduce((s, v) => s + v.revenue_60d_cents, 0);
    const cost = costed.reduce((s, v) => s + (v.cost_cents ?? 0) * v.units_60d, 0);
    return {
      group,
      products: ps.length,
      variants: vs.length,
      stock_units: trackedVs.length ? trackedVs.reduce((s, v) => s + (v.inventory_quantity ?? 0), 0) : null,
      untracked_variants: vs.length - trackedVs.length,
      units_30d: vs.reduce((s, v) => s + v.units_30d, 0),
      revenue_30d: money(vs.reduce((s, v) => s + v.revenue_30d_cents, 0)),
      units_60d: vs.reduce((s, v) => s + v.units_60d, 0),
      revenue_60d: money(vs.reduce((s, v) => s + v.revenue_60d_cents, 0)),
      margin_pct: rev > 0 ? round2(((rev - cost) / rev) * 100) : null,
      cost_coverage: `cost known for ${costed.length} of ${sold.length} variants sold`,
    };
  });

  rows.sort((a, b) => b.revenue_60d - a.revenue_60d);
  let note = `${meta.note} margin_pct uses the 60-day window over variants with a recorded cost; stock_units counts tracked variants only (null if none are tracked); untracked variants have unlimited stock and are counted in untracked_variants.`;
  if (args.group_by === "collection") {
    note += ` A product in several collections is counted in each collection, so totals across groups can exceed the catalogue total. Products in no collection are grouped under "${NO_COLLECTION}".`;
  }
  return { ...meta, note, rows };
}
