import type { CatalogAdSetUse } from "@/lib/meta/catalog/findings";
import type { CatalogSnapshot } from "@/lib/meta/catalog/types";

export const DEMO_CATALOG_ID = "demo_catalog_1";

const SET_ALL = "demo_set_all";
const SET_SPRING = "demo_set_spring";
const SET_CLEARANCE = "demo_set_clearance";

/** A realistic catalogue snapshot for demo mode: one small set starving an ad set, and a few diagnostics. */
export function demoCatalogSnapshot(fetchedAt: string = new Date().toISOString()): CatalogSnapshot {
  const hoursAgo = (h: number) => new Date(Date.parse(fetchedAt) - h * 3600_000).toISOString();
  return {
    id: DEMO_CATALOG_ID,
    name: "Demo Store catalogue",
    vertical: "commerce",
    productCount: 12400,
    diagnostics: [
      {
        type: "DA_VISIBILITY_ISSUES",
        severity: "MUST_FIX",
        title: "Products not being shown",
        errorCode: 3379016,
        affectedItems: 2310,
        children: [
          { type: "PRODUCT_OUT_OF_STOCK", description: "2,150 items are out of stock.", affectedItems: 2150 },
          { type: "PRODUCT_MISSING_IMAGE", description: "160 items have no image.", affectedItems: 160 },
        ],
      },
      {
        type: "PRODUCT_ITEM_GTIN_MISSING",
        severity: "OPPORTUNITY",
        title: "Add GTINs to improve matching",
        errorCode: null,
        affectedItems: 880,
        children: [],
      },
    ],
    productSets: [
      { id: SET_ALL, name: "All products", filter: null, productCount: 12400, inStockCount: 10250 },
      { id: SET_SPRING, name: "Spring edit", filter: '{"tag":{"eq":"spring"}}', productCount: 640, inStockCount: 590 },
      { id: SET_CLEARANCE, name: "Clearance picks", filter: '{"tag":{"eq":"clearance"}}', productCount: 41, inStockCount: 9 },
    ],
    feeds: [
      {
        id: "demo_feed_1",
        name: "Shopify feed",
        productCount: 12400,
        scheduleUrl: "https://demo-store.example/feed.xml",
        scheduleInterval: "DAILY",
        lastUpload: { endTime: hoursAgo(6), errorCount: 0, warningCount: 12 },
      },
    ],
    events: [
      { event: "ViewContent", pixelId: "demo_pixel_1", matched: 9800, unmatched: 150, matchedOtherCatalogs: 0 },
      { event: "Purchase", pixelId: "demo_pixel_1", matched: 410, unmatched: 12, matchedOtherCatalogs: 0 },
    ],
    pixelIds: ["demo_pixel_1"],
    outOfStockCount: 2150,
    warnings: [],
    fetchedAt,
  };
}

export type DemoCatalogUse = CatalogAdSetUse & { catalogId: string };

export function demoCatalogUses(): DemoCatalogUse[] {
  const base = { accountId: "act_100200300", catalogId: DEMO_CATALOG_ID, effectiveStatus: "ACTIVE" };
  return [
    { ...base, adSetId: "demo_as_1", adSetName: "DPA - Broad", campaignId: "demo_campaign_1", productSetId: SET_ALL, learningStatus: "SUCCESS", spendCents: 182000 },
    { ...base, adSetId: "demo_as_2", adSetName: "DPA - Spring", campaignId: "demo_campaign_1", productSetId: SET_SPRING, learningStatus: "LEARNING", spendCents: 64000 },
    { ...base, adSetId: "demo_as_3", adSetName: "DPA - Clearance", campaignId: "demo_campaign_2", productSetId: SET_CLEARANCE, learningStatus: "FAIL", spendCents: 31000 },
  ];
}

export const DEMO_CATALOGS = [{ id: DEMO_CATALOG_ID, name: "Demo Store catalogue", productCount: 12400 }];
