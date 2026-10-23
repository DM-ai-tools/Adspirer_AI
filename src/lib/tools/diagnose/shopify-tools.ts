import { z } from "zod";
import { registerTool } from "@/lib/tools/registry";
import { queryProducts, queryVariants, summarizeCatalog } from "@/lib/shopify/query";
import { SHOPIFY_PRODUCT_STATUSES } from "@/lib/shopify/types";

/**
 * Read-only tools over the client's synced Shopify catalogue. The client is
 * always the task's client (never an argument) and nothing here calls Shopify:
 * it reads the synced tables, and every result states how old the sync is. A
 * failure comes back as { error: true, source, message }; it never throws.
 */

const text = z.string().trim().min(1).max(200);
const limit = z.number().int().min(1).max(100).default(25);
const STATUS = z.enum(SHOPIFY_PRODUCT_STATUSES);

function failed(error: unknown) {
  return { error: true as const, source: "Shopify", message: error instanceof Error ? error.message : String(error) };
}

export const shopifyProductsTool = registerTool({
  name: "shopify_products",
  description: [
    "Read the client's synced Shopify products (read-only; the store is already connected, never pass an id).",
    "One row per product: vendor, type, status, collections, variant count, stock, price range, and units and revenue sold in the last 30 and 60 days (line revenue after product and code discounts, before order-level discounts, shipping and tax; gross of refunds). stock_units null means stock isn't tracked, not zero.",
    "Filter by search (title or handle), collection, vendor, product_type or status (ACTIVE, DRAFT, ARCHIVED, UNLISTED; UNKNOWN is a status this tool did not recognise); sort by units_30d, revenue_30d, units_60d, revenue_60d, stock or title.",
    "Every result carries synced_ago: say how fresh the data is.",
  ].join(" "),
  inputSchema: z.object({
    search: text.optional(),
    collection: text.optional(),
    vendor: text.optional(),
    product_type: text.optional(),
    status: STATUS.optional(),
    sort_by: z.enum(["units_30d", "revenue_30d", "units_60d", "revenue_60d", "stock", "title"]).optional(),
    desc: z.boolean().optional(),
    limit,
  }),
  async execute(args, ctx) {
    try {
      return await queryProducts(ctx.clientId, args);
    } catch (error) {
      return failed(error);
    }
  },
});

export const shopifyVariantsTool = registerTool({
  name: "shopify_variants",
  description: [
    "Read the client's synced Shopify variants / SKUs (read-only; never pass an id).",
    "One row per variant: SKU, price, cost, margin_pct, stock and units and revenue in the last 30 and 60 days. cost null means no cost is recorded and stock null means untracked; neither is zero.",
    "Filter by sku (exact), search, collection or vendor; sort by units_30d, revenue_30d, stock or price.",
    "Every result carries synced_ago.",
  ].join(" "),
  inputSchema: z.object({
    sku: text.optional(),
    search: text.optional(),
    collection: text.optional(),
    vendor: text.optional(),
    sort_by: z.enum(["units_30d", "revenue_30d", "stock", "price"]).optional(),
    desc: z.boolean().optional(),
    limit,
  }),
  async execute(args, ctx) {
    try {
      return await queryVariants(ctx.clientId, args);
    } catch (error) {
      return failed(error);
    }
  },
});

export const shopifySummaryTool = registerTool({
  name: "shopify_summary",
  description: [
    "Summarise the client's synced Shopify catalogue by vendor, product_type or collection (read-only; never pass an id).",
    "Per group: products, variants, stock (null if untracked), untracked variants, units and revenue for 30 and 60 days, margin and how much of the sold revenue has a recorded cost.",
    "Every result carries synced_ago.",
  ].join(" "),
  inputSchema: z.object({ group_by: z.enum(["vendor", "product_type", "collection"]) }),
  async execute(args, ctx) {
    try {
      return await summarizeCatalog(ctx.clientId, args);
    } catch (error) {
      return failed(error);
    }
  },
});
