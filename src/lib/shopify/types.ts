/** Read-only Shopify connection and synced sales. No customer personal data. */

export type ShopifySyncStatus = "never" | "running" | "ok" | "error";

export type ShopifySyncCounts = {
  /** Orders counted in the last 60 days. */
  orders: number;
  /** Distinct sold variants (rows in shopify_sales). */
  sales_variants: number;
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
