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

export type ShopifyProduct = {
  client_id: string;
  gid: string;
  title: string;
  handle: string;
  vendor: string;
  product_type: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
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

/** Synced data older than this is flagged as stale. */
export const SHOPIFY_STALE_HOURS = 72;
