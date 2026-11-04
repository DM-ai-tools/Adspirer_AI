import type { MetaGraphClient } from "@/lib/meta/graph-client";

export type CatalogGraph = Pick<MetaGraphClient, "get">;

export type CatalogDiagnostic = {
  type: string;
  severity: string;
  title: string;
  errorCode: number | null;
  affectedItems: number;
  children: Array<{ type: string; description: string; affectedItems: number }>;
};

export type CatalogProductSet = {
  id: string;
  name: string;
  filter: string | null;
  productCount: number;
  /** Only counted for product sets in use; null otherwise. */
  inStockCount: number | null;
};

export type CatalogFeed = {
  id: string;
  name: string;
  productCount: number;
  scheduleUrl: string | null;
  scheduleInterval: string | null;
  lastUpload: { endTime: string | null; errorCount: number; warningCount: number } | null;
};

/** Pixel/catalogue match for one event, summed over the days Meta returned. */
export type CatalogEventMatch = {
  event: string;
  pixelId: string | null;
  matched: number;
  unmatched: number;
  matchedOtherCatalogs: number;
};

export type CatalogSnapshot = {
  id: string;
  name: string;
  vertical: string | null;
  productCount: number;
  diagnostics: CatalogDiagnostic[];
  productSets: CatalogProductSet[];
  feeds: CatalogFeed[];
  events: CatalogEventMatch[];
  pixelIds: string[];
  /** Sum of PRODUCT_OUT_OF_STOCK diagnostics; null when diagnostics could not be loaded. */
  outOfStockCount: number | null;
  /** Parts that failed to load (the snapshot is still usable). */
  warnings: string[];
  fetchedAt: string;
};

export type CatalogProduct = {
  id: string;
  retailerId: string;
  name: string | null;
  availability: string | null;
  reviewStatus: string | null;
  visibility: string | null;
  url: string | null;
  imageUrl: string | null;
  price: string | null;
  errors: Array<{ type: string; priority: string; title: string }>;
};

export type CatalogProductIssue = "out_of_stock" | "rejected" | "any_error";
