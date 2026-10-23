/** Read-only Shopify connection and synced catalogue. No customer personal data. */

export type ShopifySyncStatus = "never" | "running" | "ok" | "error";

export type ShopifySyncCounts = {
  collections: number;
  products: number;
  variants: number;
  orders: number;
  skipped_line_items: number;
};

export type ShopifyConnection = {
  id: string;
  client_id: string;
  shop_domain: string;
  shop_name: string | null;
  currency: string | null;
  access_token_encrypted: string;
  scopes: string[];
  connected_by: string | null;
  connected_at: string;
  last_sync_at: string | null;
  last_sync_status: ShopifySyncStatus;
  last_sync_error: string | null;
  last_sync_counts: ShopifySyncCounts | null;
  created_at: string;
  updated_at: string;
};

export type ShopifyCollection = {
  client_id: string;
  gid: string;
  handle: string;
  title: string;
  products_count: number;
};

/**
 * Shopify's ProductStatus values in API 2026-10, plus UNKNOWN for any value this code
 * does not know (stored as UNKNOWN rather than guessed as ACTIVE).
 */
export const SHOPIFY_PRODUCT_STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED", "UNKNOWN"] as const;
export type ShopifyProductStatus = (typeof SHOPIFY_PRODUCT_STATUSES)[number];

export type ShopifyProduct = {
  client_id: string;
  gid: string;
  title: string;
  handle: string;
  vendor: string;
  product_type: string;
  status: ShopifyProductStatus;
  collection_gids: string[];
};

export type ShopifyVariant = {
  client_id: string;
  gid: string;
  product_gid: string;
  title: string;
  sku: string | null;
  price_cents: number;
  /** null = no cost recorded (not zero). */
  cost_cents: number | null;
  /** null = untracked / sells at zero stock (unlimited), never 0. */
  inventory_quantity: number | null;
  units_30d: number;
  revenue_30d_cents: number;
  units_60d: number;
  revenue_60d_cents: number;
};

/** Per-variant sales from order lines (no catalogue needed). No customer data. */
export type ShopifySalesRow = {
  client_id: string;
  /** Variant gid, else `product:<product gid>:<sku or title>` for a deleted variant. */
  variant_key: string;
  variant_gid: string | null;
  product_gid: string | null;
  product_title: string;
  variant_title: string | null;
  sku: string | null;
  vendor: string;
  product_type: string;
  units_30d: number;
  revenue_30d_cents: number;
  units_60d: number;
  revenue_60d_cents: number;
};

/** Synced data older than this is flagged as stale. */
export const SHOPIFY_STALE_HOURS = 72;
