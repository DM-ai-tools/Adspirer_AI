import { z } from "zod";
import { logger } from "@/lib/observability/logger";
import { LIVE_DEFAULT_LIMIT, LIVE_MAX_LIMIT, LiveShopifyError, liveFindProducts, liveLookupVariants } from "@/lib/shopify/live";
import { SALES_GROUPS, SALES_SORTS, querySales } from "@/lib/shopify/query";
import { registerTool } from "@/lib/tools/registry";

/**
 * Read-only Shopify tools. `shopify_products` and `shopify_variants` read the store live;
 * `shopify_sales` reads the synced sales (as of the last sync). The client is always the task's client
 * (ctx.clientId): no tool takes a client id or shop domain, and zod drops unknown keys.
 * A failure comes back as { error: true, source: "Shopify", message } with fixed text;
 * it never throws and never carries Shopify's or the database's own wording.
 */

const text = z.string().trim().min(1).max(200);
const liveLimit = z.number().int().min(1).max(LIVE_MAX_LIMIT).default(LIVE_DEFAULT_LIMIT);

const LIVE_FAILED = new LiveShopifyError("FAILED").message;
const SALES_FAILED = "Couldn't read the synced Shopify sales. Try again.";

function failure(message: string) {
  return { error: true as const, source: "Shopify", message };
}

/** LiveShopifyError text is fixed and safe to show; anything else becomes the generic text. */
function liveFailure(error: unknown) {
  return failure(error instanceof LiveShopifyError ? error.message : LIVE_FAILED);
}

export const shopifyProductsTool = registerTool({
  name: "shopify_products",
  description: [
    "Read the client's Shopify products LIVE from the store right now (read-only; the store is already connected, never pass an id or domain).",
    "One row per product: title, vendor, product type, status, variant count (variants; variants_read is how many were read for stock, fewer for a product with many variants), current stock (stock_units null means untracked/unlimited, not zero) and price range.",
    "Filter by search (words in the title), vendor, product_type, collection (title) or status; sort by title, inventory or updated.",
    "This tool has no sales data and cannot sort by best selling: for best sellers, top products by units or revenue, or anything sold, use shopify_sales.",
    "Results carry source and fetched_at: say the figures are live from Shopify.",
  ].join(" "),
  inputSchema: z.object({
    search: text.optional(),
    vendor: text.optional(),
    product_type: text.optional(),
    collection: text.optional(),
    status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"]).optional(),
    sort_by: z.enum(["title", "inventory", "updated"]).optional(),
    desc: z.boolean().optional(),
    limit: liveLimit,
  }),
  async execute(args, ctx) {
    try {
      return await liveFindProducts(ctx.clientId, args);
    } catch (error) {
      return liveFailure(error);
    }
  },
});

export const shopifyVariantsTool = registerTool({
  name: "shopify_variants",
  description: [
    "Look up the client's Shopify variants / SKUs LIVE from the store right now (read-only; never pass an id or domain).",
    "One row per variant: product, variant, SKU, vendor, current price, cost, margin_pct and current stock. cost null means no cost is recorded and stock null means untracked/unlimited; neither is zero.",
    "Look up by sku (exact, ignoring case, among Shopify's first 25 matches: when the note says the SKU may still exist, try search with the product name), search (words in product, variant or SKU) or vendor.",
    "No sales data here: units and revenue sold come from shopify_sales.",
    "Results carry source and fetched_at: say the figures are live from Shopify.",
  ].join(" "),
  inputSchema: z.object({
    sku: text.optional(),
    search: text.optional(),
    vendor: text.optional(),
    limit: liveLimit,
  }),
  async execute(args, ctx) {
    try {
      return await liveLookupVariants(ctx.clientId, args);
    } catch (error) {
      return liveFailure(error);
    }
  },
});

export const shopifySalesTool = registerTool({
  name: "shopify_sales",
  description: [
    "Read the client's Shopify sales: units and revenue per variant over the last 30 and 60 days, synced from orders when a sync runs (Sync now or a scheduled run), not live (read-only; never pass an id or domain).",
    "Use it for best sellers, top products by units or revenue, and anything sold; group_by variant (default), product, vendor or product_type; window 30 (default) or 60; sort_by units (default) or revenue.",
    "Filter by search (words in product, variant, SKU, vendor or type), vendor, product_type or sku (exact). There is no collection filter for sales: list a collection's products with shopify_products first.",
    "Revenue is line revenue after product and code discounts, before order-level discounts, shipping and tax, gross of refunds. Only variants sold in the last 60 days have rows; deleted_variant true marks order lines whose variant no longer exists in Shopify.",
    "Every result carries synced_ago, the age of the sales: quote it, and flag it when the result says stale, not synced yet or that the latest sync failed.",
  ].join(" "),
  inputSchema: z.object({
    search: text.optional(),
    vendor: text.optional(),
    product_type: text.optional(),
    sku: text.optional(),
    collection: text.optional(),
    group_by: z.enum(SALES_GROUPS).optional(),
    window: z.union([z.literal(30), z.literal(60)]).optional(),
    sort_by: z.enum(SALES_SORTS).optional(),
    desc: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  async execute(args, ctx) {
    try {
      return await querySales(ctx.clientId, args);
    } catch {
      // The database's own error text never reaches the model.
      logger.warn("Shopify sales read failed", { clientId: ctx.clientId });
      return failure(SALES_FAILED);
    }
  },
});
