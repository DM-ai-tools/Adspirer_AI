/**
 * Bulk operation queries and pure JSONL parsing for the Shopify sync.
 * No customer personal data is ever selected (no customer, email, phone or addresses).
 */
import { toCents } from "./domain";
import type { ShopifyCollection, ShopifyProduct, ShopifyVariant } from "./types";

type Line = Record<string, unknown>;
type CatalogVariant = Omit<
  ShopifyVariant,
  "units_30d" | "revenue_30d_cents" | "units_60d" | "revenue_60d_cents"
>;
type Sales = { units_30d: number; revenue_30d_cents: number; units_60d: number; revenue_60d_cents: number };

/** Connections: collections, products, product.collections, product.variants (4 of the 5 allowed). */
export const CATALOG_BULK_QUERY = `{
  collections {
    edges { node { id handle title productsCount { count } } }
  }
  products {
    edges {
      node {
        id title handle vendor productType status
        collections { edges { node { id } } }
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

/** Connections: orders and order.lineItems (2 of the 5 allowed). */
export function ORDERS_BULK_QUERY(sinceIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(sinceIso)) {
    throw new Error("sinceIso must be a UTC ISO timestamp");
  }
  return `{
  orders(query: "created_at:>=${sinceIso}") {
    edges {
      node {
        id createdAt cancelledAt test
        lineItems {
          edges {
            node {
              id quantity
              variant { id }
              discountedTotalSet { shopMoney { amount } }
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

export function parseCatalog(
  clientId: string,
  lines: Line[],
): { collections: ShopifyCollection[]; products: ShopifyProduct[]; variants: CatalogVariant[] } {
  const collections: ShopifyCollection[] = [];
  const products: ShopifyProduct[] = [];
  const variants: CatalogVariant[] = [];
  const productByGid = new Map<string, ShopifyProduct>();

  // Parents precede children in bulk output, but index products first so order never matters.
  for (const l of lines) {
    const id = str(l.id);
    if (l.__parentId === undefined && id.startsWith("gid://shopify/Product/")) {
      const status = str(l.status);
      const p: ShopifyProduct = {
        client_id: clientId,
        gid: id,
        title: str(l.title),
        handle: str(l.handle),
        vendor: str(l.vendor),
        product_type: str(l.productType),
        status: status === "DRAFT" || status === "ARCHIVED" ? status : "ACTIVE",
        collection_gids: [],
      };
      products.push(p);
      productByGid.set(id, p);
    }
  }

  for (const l of lines) {
    const id = str(l.id);
    const parent = typeof l.__parentId === "string" ? l.__parentId : null;
    if (parent === null) {
      if (id.startsWith("gid://shopify/Collection/")) {
        const pc = isObj(l.productsCount) ? Number(l.productsCount.count) : 0;
        collections.push({
          client_id: clientId,
          gid: id,
          handle: str(l.handle),
          title: str(l.title),
          products_count: Number.isFinite(pc) ? pc : 0,
        });
      }
      continue;
    }
    const product = productByGid.get(parent);
    if (!product) continue;
    if (id.startsWith("gid://shopify/Collection/")) {
      if (!product.collection_gids.includes(id)) product.collection_gids.push(id);
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
  }
  return { collections, products, variants };
}

export function aggregateSales(
  lines: Line[],
  now: Date,
): { byVariant: Map<string, Sales>; orders: number; skippedLineItems: number } {
  const DAY = 86_400_000;
  const t30 = now.getTime() - 30 * DAY;
  const t60 = now.getTime() - 60 * DAY;
  const byVariant = new Map<string, Sales>();
  // order gid -> counts in 30d (true) or only 60d (false); excluded orders are absent
  const valid = new Map<string, boolean>();
  let skippedLineItems = 0;

  for (const l of lines) {
    if (l.__parentId !== undefined || !str(l.id).startsWith("gid://shopify/Order/")) continue;
    if (l.cancelledAt || l.test === true) continue;
    const t = Date.parse(str(l.createdAt));
    if (!Number.isFinite(t) || t < t60) continue;
    valid.set(str(l.id), t >= t30);
  }

  for (const l of lines) {
    if (typeof l.__parentId !== "string") continue;
    const in30 = valid.get(l.__parentId);
    if (in30 === undefined) continue;
    const variantId = isObj(l.variant) ? str(l.variant.id) : "";
    if (!variantId) {
      skippedLineItems += 1;
      continue;
    }
    const qty = typeof l.quantity === "number" ? Math.max(0, l.quantity) : 0;
    const money = isObj(l.discountedTotalSet) && isObj(l.discountedTotalSet.shopMoney)
      ? l.discountedTotalSet.shopMoney.amount
      : null;
    const cents = toCents(money as string | null) ?? 0;
    const s = byVariant.get(variantId) ?? { units_30d: 0, revenue_30d_cents: 0, units_60d: 0, revenue_60d_cents: 0 };
    s.units_60d += qty;
    s.revenue_60d_cents += cents;
    if (in30) {
      s.units_30d += qty;
      s.revenue_30d_cents += cents;
    }
    byVariant.set(variantId, s);
  }
  return { byVariant, orders: valid.size, skippedLineItems };
}
