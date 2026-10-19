export type GoogleAssetKind = "ga4_property" | "ads_customer" | "gsc_site";
export type GoogleAsset = {
  id: string; kind: GoogleAssetKind; external_id: string; name: string; parent_name: string | null;
  currency: string | null; timezone: string | null; login_customer_id: string | null;
  mapped_client_id: string | null; raw_metadata: Record<string, unknown> | null;
  last_synced_at: string | null; created_at: string; updated_at: string;
};
export type GoogleConnection = {
  id: string; google_email: string | null; scopes: string[]; refresh_token_encrypted: string;
  connected_by: string | null; connected_at: string; last_refreshed_at: string | null;
  created_at: string; updated_at: string;
};
export type DateRange = { since: string; until: string }; // YYYY-MM-DD
export type Ga4Channel = "paid_social" | "paid_search" | "other";
export type Ga4CategoryRevenue = {
  method: "item" | "landing_page" | "none";
  currency: string;
  /** item method: key = itemCategory; landing_page method: key = landing page path. */
  rows: Array<{ key: string; revenueCents: number; purchases: number }>;
  /** Revenue by landing page and channel, used for the per-channel split. */
  byChannel: Array<{ landingPage: string; channel: Ga4Channel; revenueCents: number }>;
  /** Plain notes on data GA4 dropped or grouped, e.g. into "(other)". */
  warnings?: string[];
};
export type AdsPerformance = {
  customerId: string; currency: string; merchantCenterLinked: boolean;
  campaigns: Array<{ id: string; name: string; type: string; status: string; costCents: number; conversions: number; conversionValueCents: number }>;
  landingPages: Array<{ url: string; costCents: number; conversionValueCents: number }>;
  assetGroups: Array<{ name: string; campaignId: string; costCents: number; conversionValueCents: number }>;
  shoppingCategories: Array<{ productType: string; costCents: number; conversionValueCents: number }>;
};
export type SearchDemand = { siteUrl: string; rows: Array<{ page: string; clicks: number; impressions: number; position: number; topQueries: string[] }> };
export type ChannelSnapshot = {
  mapped: { ga4: boolean; ads: boolean; gsc: boolean };
  ga4: Ga4CategoryRevenue | null; ads: AdsPerformance | null; gsc: SearchDemand | null;
  /** "Google needs reconnecting", "Google Ads: <error>", … one per failed part. */
  warnings: string[];
};
