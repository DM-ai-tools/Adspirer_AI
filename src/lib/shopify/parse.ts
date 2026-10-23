/**
 * Bulk operation queries and pure JSONL parsing for the Shopify sync.
 * No customer personal data is ever selected (no customer, email, phone or addresses).
 */
import { toCents } from "./domain";
import {
  SHOPIFY_PRODUCT_STATUSES,
  type ShopifyCollection,
  type ShopifyProduct,
  type ShopifyProductStatus,
  type ShopifyVariant,
} from "./types";

type Line = Record<string, unknown>;
type CatalogVariant = Omit<
  ShopifyVariant,
  "units_30d" | "revenue_30d_cents" | "units_60d" | "revenue_60d_cents"
>;
type Sales = { units_30d: number; revenue_30d_cents: number; units_60d: number; revenue_60d_cents: number };

/**
 * Bulk operations allow a single top-level field, at most 5 connections and connections
 * nested at most 2 levels deep. This uses 3 connections (products, product.collections,
 * product.variants), each nested one level under products. Collections are read through
 * their products, so a collection with no products is not synced.
 */
export const CATALOG_BULK_QUERY = `{
  products {
    edges {
      node {
        id title handle vendor productType status
        collections { edges { node { id handle title } } }
        variants {
          edges {
            node {
              id title sku price inventoryPolicy inventoryQuantity
              inventoryItem { tracked unitCost { amount } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Connections: orders and order.lineItems (2 of the 5 allowed, one level nested). Date
 * values in search syntax must be quoted. Line revenue is discountedTotalSet with code
 * discounts included: after product and code discounts, before order-level discounts,
 * shipping and tax, and including refunded and removed units (as quantity does).
 */
export function ORDERS_BULK_QUERY(sinceIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(sinceIso)) {
    throw new Error("sinceIso must be a UTC ISO timestamp");
  }
  return `{
  orders(query: "created_at:>='${sinceIso}'") {
    edges {
      node {
        id createdAt cancelledAt test
        lineItems {
          edges {
            node {
              id quantity
              variant { id }
              discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount } }
            }
          }
        }
      }
    }
  }
}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Known ProductStatus values (2026-10); anything else is stored as UNKNOWN, never ACTIVE. */
function productStatus(value: string): ShopifyProductStatus {
  return (SHOPIFY_PRODUCT_STATUSES as readonly string[]).includes(value) ? (value as ShopifyProductStatus) : "UNKNOWN";
}

export type ParsedCatalog = { collections: ShopifyCollection[]; products: ShopifyProduct[]; variants: CatalogVariant[] };
export type SalesSummary = { byVariant: Map<string, Sales>; orders: number; skippedLineItems: number };

/**
 * Single-pass catalogue builder for a bulk result streamed one line at a time. Shopify writes
 * every nested connection's objects after their parent ("all nested connections appear after
 * their parents in the file", bulk-operations/queries guide), so a child is attached when it
 * arrives; a child whose product was never seen is ignored. Only the rows to be saved are
 * kept, never the raw lines.
 */
export function createCatalogBuilder(clientId: string): {
  push: (line: Line) => void;
  finish: () => ParsedCatalog;
} {
  const products: ShopifyProduct[] = [];
  const variants: CatalogVariant[] = [];
  const productByGid = new Map<string, ShopifyProduct>();
  // Collections come only as children of products: gid -> row plus the products seen in it.
  const collectionByGid = new Map<string, { row: ShopifyCollection; products: Set<string> }>();

  const push = (l: Line): void => {
    const id = str(l.id);
    if (l.__parentId === undefined) {
      if (id.startsWith("gid://shopify/Product/")) {
        const p: ShopifyProduct = {
          client_id: clientId,
          gid: id,
          title: str(l.title),
          handle: str(l.handle),
          vendor: str(l.vendor),
          product_type: str(l.productType),
          status: productStatus(str(l.status)),
          collection_gids: [],
        };
        products.push(p);
        productByGid.set(id, p);
      }
      return;
    }
    const parent = typeof l.__parentId === "string" ? l.__parentId : null;
    if (parent === null) return;
    const product = productByGid.get(parent);
    if (!product) return;
    if (id.startsWith("gid://shopify/Collection/")) {
      if (!product.collection_gids.includes(id)) product.collection_gids.push(id);
      let c = collectionByGid.get(id);
      if (!c) {
        c = {
          row: { client_id: clientId, gid: id, handle: str(l.handle), title: str(l.title), products_count: 0 },
          products: new Set(),
        };
        collectionByGid.set(id, c);
      }
      c.products.add(parent);
    } else if (id.startsWith("gid://shopify/ProductVariant/")) {
      const item = isObj(l.inventoryItem) ? l.inventoryItem : {};
      const unitCost = isObj(item.unitCost) ? item.unitCost.amount : null;
      const tracked = item.tracked === true;
      const unlimited = !tracked || l.inventoryPolicy === "CONTINUE";
      const qty = typeof l.inventoryQuantity === "number" ? l.inventoryQuantity : null;
      variants.push({
        client_id: clientId,
        gid: id,
        product_gid: parent,
        title: str(l.title),
        sku: typeof l.sku === "string" && l.sku !== "" ? l.sku : null,
        price_cents: toCents(l.price as string) ?? 0,
        cost_cents: toCents(unitCost as string | null),
        inventory_quantity: unlimited || qty === null ? null : Math.max(0, qty),
      });
    }
  };

  const finish = (): ParsedCatalog => {
    const collections = [...collectionByGid.values()].map(({ row, products: seen }) => ({
      ...row,
      products_count: seen.size,
    }));
    return { collections, products, variants };
  };
  return { push, finish };
}

export function parseCatalog(clientId: string, lines: Line[]): ParsedCatalog {
  const builder = createCatalogBuilder(clientId);
  for (const l of lines) builder.push(l);
  return builder.finish();
}

/**
 * Single-pass sales aggregator for an orders bulk result streamed one line at a time (line
 * items come after their order, as for the catalogue). Keeps one entry per counted order
 * (in the 30-day window or only the 60-day one) and the per-variant sums; line items are
 * folded in as they arrive and never kept.
 */
export function createSalesAggregator(now: Date): { push: (line: Line) => void; finish: () => SalesSummary } {
  const DAY = 86_400_000;
  const t30 = now.getTime() - 30 * DAY;
  const t60 = now.getTime() - 60 * DAY;
  const byVariant = new Map<string, Sales>();
  // order gid -> counts in 30d (true) or only 60d (false); excluded orders are absent
  const valid = new Map<string, boolean>();
  let skippedLineItems = 0;

  const push = (l: Line): void => {
    if (l.__parentId === undefined) {
      if (!str(l.id).startsWith("gid://shopify/Order/")) return;
      if (l.cancelledAt || l.test === true) return;
      const t = Date.parse(str(l.createdAt));
      if (!Number.isFinite(t) || t < t60) return;
      valid.set(str(l.id), t >= t30);
      return;
    }
    if (typeof l.__parentId !== "string") return;
    const in30 = valid.get(l.__parentId);
    if (in30 === undefined) return;
    const variantId = isObj(l.variant) ? str(l.variant.id) : "";
    if (!variantId) {
      skippedLineItems += 1;
      return;
    }
    const qty = typeof l.quantity === "number" ? Math.max(0, l.quantity) : 0;
    const money = isObj(l.discountedTotalSet) && isObj(l.discountedTotalSet.shopMoney)
      ? l.discountedTotalSet.shopMoney.amount
      : null;
    const cents = toCents(money as string | null) ?? 0;
    let s = byVariant.get(variantId);
    if (!s) {
      s = { units_30d: 0, revenue_30d_cents: 0, units_60d: 0, revenue_60d_cents: 0 };
      byVariant.set(variantId, s);
    }
    s.units_60d += qty;
    s.revenue_60d_cents += cents;
    if (in30) {
      s.units_30d += qty;
      s.revenue_30d_cents += cents;
    }
  };

  return { push, finish: () => ({ byVariant, orders: valid.size, skippedLineItems }) };
}

export function aggregateSales(lines: Line[], now: Date): SalesSummary {
  const aggregator = createSalesAggregator(now);
  for (const l of lines) aggregator.push(l);
  return aggregator.finish();
}
