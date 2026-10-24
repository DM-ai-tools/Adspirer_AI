import { getConnection, loadSales } from "./store";
import { SHOPIFY_STALE_HOURS, type ShopifySalesRow } from "./types";

/**
 * Reads over the synced Shopify sales (backs the `shopify_sales` chat tool), plus the
 * freshness helpers the context line shares. Products, SKUs, stock, price and cost are
 * read live (live.ts), never from here. Money out is major units rounded to 2 dp from
 * integer cents; output rows are built from explicit fields only.
 */

export const SALES_NOTE =
  "Sales are line revenue after product and code discounts, before order-level discounts, shipping and tax; " +
  "gross of refunds (refunded and removed units still count); cancelled and test orders are excluded; " +
  "custom (non-product) line items and lines whose product no longer exists are excluded; " +
  "windows are the rolling 30 and 60 days up to the sync time.";

export const SALES_SOURCE = "Shopify (synced sales)";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const LIST_CAP = 30;

export type ShopifyUnavailable =
  | { connected: false; source: typeof SALES_SOURCE; message: string }
  | { connected: true; source: typeof SALES_SOURCE; synced_at: null; message: string };

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

/** True when a sync time is older than SHOPIFY_STALE_HOURS. */
export function isStale(iso: string, now: Date): boolean {
  return (now.getTime() - new Date(iso).getTime()) / 3_600_000 > SHOPIFY_STALE_HOURS;
}

/** Stale-data sentence shared by the sales result. */
function staleNote(syncedAgo: string): string {
  return `Data is stale: last synced ${syncedAgo} (older than ${SHOPIFY_STALE_HOURS} hours), so numbers may not reflect the store now.`;
}

const money = (cents: number): number => Math.round(cents) / 100;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export const SALES_GROUPS = ["variant", "product", "vendor", "product_type"] as const;
export type SalesGroupBy = (typeof SALES_GROUPS)[number];
export const SALES_SORTS = ["units", "revenue"] as const;
export type SalesSortBy = (typeof SALES_SORTS)[number];
export type SalesWindow = 30 | 60;

export type SalesArgs = {
  search?: string;
  vendor?: string;
  product_type?: string;
  sku?: string;
  /** Not a sales filter (order lines carry no collection): answered with a note and no rows. */
  collection?: string;
  group_by?: SalesGroupBy;
  window?: SalesWindow;
  sort_by?: SalesSortBy;
  desc?: boolean;
  limit?: number;
};

export type SalesRow = {
  /** Group label: "Product / Variant", product title, vendor or product type. */
  group: string;
  /** Product title when the group is one product or variant, else null. */
  product: string | null;
  /**
   * Variant title from the order line, for a variant row (else null). Null also for a
   * product's single default variant, so it says nothing about deletion: see deleted_variant.
   */
  variant: string | null;
  /** True when the order lines' variant no longer exists in Shopify (no variant id); for a
   * grouped row, only when every variant in the group is deleted. */
  deleted_variant: boolean;
  /** The SKU when every variant in the group has the same one, else null. */
  sku: string | null;
  vendor: string | null;
  product_type: string | null;
  /** Sold variants in the group. */
  variants: number;
  /** Units and revenue in `window` days. */
  units: number;
  revenue: number;
  /** Units and revenue in `other_window` days. */
  units_other_window: number;
  revenue_other_window: number;
};

export type SalesTotals = {
  units: number;
  revenue: number;
  units_other_window: number;
  revenue_other_window: number;
};

export type SalesResult = {
  source: typeof SALES_SOURCE;
  synced_at: string;
  synced_ago: string;
  stale: boolean;
  currency: string | null;
  window: SalesWindow;
  other_window: SalesWindow;
  group_by: SalesGroupBy;
  sort_by: SalesSortBy;
  rows: SalesRow[];
  /** Groups matching the filters (rows may be fewer after the limit). */
  total_groups: number;
  /** Over every matching group, not just the rows shown. */
  totals: SalesTotals;
  note: string;
};

export const COLLECTION_SALES_NOTE =
  "The collection filter is not available for sales; use shopify_products with collection to list that collection's products, then shopify_sales with search, vendor or product_type.";

const NO_SALES_ROW_NOTE =
  "Only variants sold in the last 60 days have a sales row: a product with no row sold 0 units in that time (shopify_products lists the catalogue).";

const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/** Words of the search text (split on spaces), lowercased; every word must appear. */
function searchWords(search: string | undefined): string[] {
  return lc(search).split(/\s+/).filter(Boolean).slice(0, 8);
}

function distinctSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, LIST_CAP);
}

const isDefaultTitle = (t: string | null): boolean => !t || t.trim().toLowerCase() === "default title";

function groupKey(r: ShopifySalesRow, by: SalesGroupBy): string {
  switch (by) {
    case "variant":
      return r.variant_key;
    case "product":
      return r.product_gid ?? `title:${r.product_title}`;
    case "vendor":
      return r.vendor || "(none)";
    case "product_type":
      return r.product_type || "(none)";
  }
}

function groupLabel(r: ShopifySalesRow, by: SalesGroupBy): string {
  switch (by) {
    case "variant":
      return isDefaultTitle(r.variant_title) ? r.product_title : `${r.product_title} / ${r.variant_title}`;
    case "product":
      return r.product_title;
    case "vendor":
      return r.vendor || "(none)";
    case "product_type":
      return r.product_type || "(none)";
  }
}

/** The shared value of a field across the group, or null when it differs. */
function same<T>(rows: ShopifySalesRow[], pick: (r: ShopifySalesRow) => T): T | null {
  const first = pick(rows[0]);
  return rows.every((r) => pick(r) === first) ? first : null;
}

type Group = { label: string; rows: ShopifySalesRow[]; units: number; cents: number; unitsOther: number; centsOther: number };

/**
 * Units and revenue from the synced `shopify_sales` rows, filtered, grouped and sorted.
 * Never synced -> a message, no numbers. Every result names its source and age, and says
 * when it is stale, when the latest sync failed (rows may then mix the last good save with
 * partial newer data) or when a sync is running.
 */
export async function querySales(
  clientId: string,
  args: SalesArgs,
  now: Date = new Date(),
): Promise<SalesResult | ShopifyUnavailable> {
  const conn = await getConnection(clientId);
  if (!conn) {
    return { connected: false, source: SALES_SOURCE, message: "No Shopify store is connected for this client." };
  }
  // last_sync_error is fixed text written by the sync (never raw Shopify output).
  const failed = conn.last_sync_status === "error" ? (conn.last_sync_error ?? "no reason recorded") : null;
  if (!conn.last_sync_at) {
    return {
      connected: true,
      source: SALES_SOURCE,
      synced_at: null,
      message: failed
        ? `Shopify sales are not synced yet: the latest sync failed (${failed}). Ask an admin to check the connection and run a sync. Products, SKUs and stock can still be read live with shopify_products and shopify_variants.`
        : "Shopify sales are not synced yet. Ask an admin to run a sync. Products, SKUs and stock can still be read live with shopify_products and shopify_variants.",
    };
  }

  const notes: string[] = [SALES_NOTE];
  const synced_ago = describeAgo(conn.last_sync_at, now);
  const stale = isStale(conn.last_sync_at, now);
  if (stale) notes.push(staleNote(synced_ago));
  if (failed) {
    notes.push(
      describeFailedSync(failed, synced_ago),
      "Rows the failed sync saved before it stopped may be mixed in, so these numbers can combine the last successful sync with partial newer data.",
    );
  } else if (conn.last_sync_status === "running") {
    notes.push("A sync is running now: rows may mix the previous sync with new data until it finishes.");
  }

  let groupBy: SalesGroupBy = "variant";
  if (args.group_by !== undefined) {
    if ((SALES_GROUPS as readonly string[]).includes(args.group_by)) groupBy = args.group_by;
    else notes.push(`Unknown group_by '${String(args.group_by)}', grouped by variant.`);
  }
  let window: SalesWindow = 30;
  if (args.window !== undefined) {
    if (args.window === 30 || args.window === 60) window = args.window;
    else notes.push(`Unknown window '${String(args.window)}', used 30 days.`);
  }
  const otherWindow: SalesWindow = window === 30 ? 60 : 30;
  let sortBy: SalesSortBy = "units";
  if (args.sort_by !== undefined) {
    if ((SALES_SORTS as readonly string[]).includes(args.sort_by)) sortBy = args.sort_by;
    else notes.push(`Unknown sort_by '${String(args.sort_by)}', sorted by units.`);
  }
  const desc = args.desc ?? true;

  const base = {
    source: SALES_SOURCE,
    synced_at: conn.last_sync_at,
    synced_ago,
    stale,
    currency: conn.currency,
    window,
    other_window: otherWindow,
    group_by: groupBy,
    sort_by: sortBy,
  } as const;
  const emptyTotals: SalesTotals = { units: 0, revenue: 0, units_other_window: 0, revenue_other_window: 0 };

  if (args.collection !== undefined && args.collection.trim() !== "") {
    notes.push(COLLECTION_SALES_NOTE);
    return { ...base, rows: [], total_groups: 0, totals: emptyTotals, note: notes.join(" ") };
  }

  const all = await loadSales(clientId);
  const words = searchWords(args.search);
  const vendor = lc(args.vendor);
  const productType = lc(args.product_type);
  const sku = lc(args.sku);
  const matched = all.filter((r) => {
    if (vendor && lc(r.vendor) !== vendor) return false;
    if (productType && lc(r.product_type) !== productType) return false;
    if (sku && lc(r.sku) !== sku) return false;
    if (words.length) {
      const text = [r.product_title, r.variant_title, r.sku, r.vendor, r.product_type].map(lc).join(" ");
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });

  const unitsOf = (r: ShopifySalesRow, w: SalesWindow) => (w === 30 ? r.units_30d : r.units_60d);
  const centsOf = (r: ShopifySalesRow, w: SalesWindow) => (w === 30 ? r.revenue_30d_cents : r.revenue_60d_cents);
  const groups = new Map<string, Group>();
  for (const r of matched) {
    const key = groupKey(r, groupBy);
    let g = groups.get(key);
    if (!g) {
      g = { label: groupLabel(r, groupBy), rows: [], units: 0, cents: 0, unitsOther: 0, centsOther: 0 };
      groups.set(key, g);
    }
    g.rows.push(r);
    g.units += unitsOf(r, window);
    g.cents += centsOf(r, window);
    g.unitsOther += unitsOf(r, otherWindow);
    g.centsOther += centsOf(r, otherWindow);
  }

  const list = [...groups.values()];
  const metric = (g: Group) => (sortBy === "units" ? g.units : g.cents);
  const tie = (g: Group) => (sortBy === "units" ? g.cents : g.units);
  list.sort((a, b) => {
    const cmp = metric(a) - metric(b) || tie(a) - tie(b);
    if (cmp !== 0) return desc ? -cmp : cmp;
    return a.label.localeCompare(b.label);
  });

  const limit = clampLimit(args.limit);
  const shown = list.slice(0, limit);
  const rows = shown.map(
    (g): SalesRow => ({
      group: g.label,
      product: groupBy === "variant" || groupBy === "product" ? g.rows[0].product_title : null,
      variant: groupBy === "variant" ? g.rows[0].variant_title : null,
      deleted_variant: g.rows.every((r) => r.variant_gid === null),
      sku: same(g.rows, (r) => r.sku),
      vendor: same(g.rows, (r) => r.vendor),
      product_type: same(g.rows, (r) => r.product_type),
      variants: g.rows.length,
      units: g.units,
      revenue: money(g.cents),
      units_other_window: g.unitsOther,
      revenue_other_window: money(g.centsOther),
    }),
  );
  const totals: SalesTotals = {
    units: list.reduce((s, g) => s + g.units, 0),
    revenue: money(list.reduce((s, g) => s + g.cents, 0)),
    units_other_window: list.reduce((s, g) => s + g.unitsOther, 0),
    revenue_other_window: money(list.reduce((s, g) => s + g.centsOther, 0)),
  };

  notes.push(
    `units and revenue are for the last ${window} days; units_other_window and revenue_other_window for the last ${otherWindow} days.`,
  );
  if (list.length > shown.length) {
    notes.push(`Showing the first ${shown.length} of ${list.length} groups; totals cover all of them.`);
  }
  if (rows.some((r) => r.deleted_variant)) {
    notes.push(
      "Rows with deleted_variant true are order lines whose variant no longer exists in Shopify (kept by product and SKU).",
    );
  }
  if (list.length === 0) {
    const used = (
      [
        ["search", args.search],
        ["vendor", args.vendor],
        ["product_type", args.product_type],
        ["sku", args.sku],
      ] as Array<[string, string | undefined]>
    ).filter(([, v]) => v !== undefined && v.trim() !== "");
    if (used.length) notes.push(`No sales rows matched ${used.map(([k, v]) => `${k}="${v}"`).join(", ")}.`);
    if (args.sku?.trim()) notes.push(`No sold variant has the exact SKU "${args.sku.trim()}" (ignoring case).`);
    if (args.vendor?.trim()) notes.push(`Vendors with sales: ${distinctSorted(all.map((r) => r.vendor)).join(", ") || "none"}.`);
    if (args.product_type?.trim()) {
      notes.push(`Product types with sales: ${distinctSorted(all.map((r) => r.product_type)).join(", ") || "none"}.`);
    }
    notes.push(NO_SALES_ROW_NOTE);
  }

  return { ...base, rows, total_groups: list.length, totals, note: notes.join(" ") };
}
