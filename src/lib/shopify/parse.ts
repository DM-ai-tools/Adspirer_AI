/**
 * Bulk operation queries and pure JSONL parsing for the Shopify sync.
 * No customer personal data is ever selected (no customer, email, phone or addresses).
 */
import { toCents } from "./domain";
import type { ShopifySalesRow } from "./types";

type Line = Record<string, unknown>;

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
              id quantity title variantTitle sku vendor
              variant { id }
              product { id productType }
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

export type SalesRows = Omit<ShopifySalesRow, "client_id">[];
export type SalesSummary = {
  rows: SalesRows;
  orders: number;
  skippedLineItems: number;
};

/**
 * Single-pass sales aggregator for an orders bulk result streamed one line at a time (line
 * items come after their order, as for the catalogue). Keeps one entry per counted order
 * (in the 30-day window or only the 60-day one) and the per-variant rows; line items are
 * folded in as they arrive and never kept.
 */
export function createSalesAggregator(now: Date): { push: (line: Line) => void; finish: () => SalesSummary } {
  const DAY = 86_400_000;
  const t30 = now.getTime() - 30 * DAY;
  const t60 = now.getTime() - 60 * DAY;
  const byKey = new Map<string, SalesRows[number]>();
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
    const productId = isObj(l.product) ? str(l.product.id) : "";
    const sku = str(l.sku) || null;
    const title = str(l.title);
    const variantTitle = str(l.variantTitle) || null;
    let key = variantId;
    if (!key) {
      // A deleted variant: key by product plus SKU, else "<title> / <variantTitle>", else the
      // title, so the same SKU or title on two different products stays distinct.
      const label = sku ?? (title && variantTitle ? `${title} / ${variantTitle}` : title);
      if (!productId || !label) {
        skippedLineItems += 1;
        return;
      }
      key = `product:${productId}:${label}`;
    }
    const qty = typeof l.quantity === "number" ? Math.max(0, l.quantity) : 0;
    const money = isObj(l.discountedTotalSet) && isObj(l.discountedTotalSet.shopMoney)
      ? l.discountedTotalSet.shopMoney.amount
      : null;
    const cents = toCents(money as string | null) ?? 0;
    let row = byKey.get(key);
    if (!row) {
      row = {
        variant_key: key,
        variant_gid: variantId || null,
        product_gid: productId || null,
        product_title: title,
        variant_title: variantTitle,
        sku,
        vendor: str(l.vendor),
        product_type: isObj(l.product) ? str(l.product.productType) : "",
        units_30d: 0,
        revenue_30d_cents: 0,
        units_60d: 0,
        revenue_60d_cents: 0,
      };
      byKey.set(key, row);
    } else {
      // Fill gaps from later lines; the first non-empty value wins. Lines merged under one key
      // that disagree on the variant title store null (a null stays null).
      row.product_title ||= title;
      if (row.variant_title !== variantTitle) row.variant_title = null;
      row.sku ??= sku;
      row.vendor ||= str(l.vendor);
      if (!row.product_type && isObj(l.product)) row.product_type = str(l.product.productType);
      row.product_gid ??= productId || null;
    }
    row.units_60d += qty;
    row.revenue_60d_cents += cents;
    if (in30) {
      row.units_30d += qty;
      row.revenue_30d_cents += cents;
    }
  };

  return { push, finish: () => ({ rows: [...byKey.values()], orders: valid.size, skippedLineItems }) };
}

export function aggregateSales(lines: Line[], now: Date): SalesSummary {
  const aggregator = createSalesAggregator(now);
  for (const l of lines) aggregator.push(l);
  return aggregator.finish();
}
