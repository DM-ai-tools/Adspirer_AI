import { describe, expect, it } from "vitest";
import {
  CATALOG_THRESHOLDS,
  evaluateCatalog,
  type CatalogAdSetUse,
  type CatalogFinding,
} from "@/lib/meta/catalog/findings";
import type { CatalogSnapshot } from "@/lib/meta/catalog/types";

const FETCHED_AT = "2026-11-04T12:00:00.000Z";
const IN_STOCK = '{"availability":{"eq":"in stock"}}';

function hoursAgo(h: number): string {
  return new Date(new Date(FETCHED_AT).getTime() - h * 3600_000).toISOString();
}

/** A catalogue with nothing wrong: no diagnostics, healthy set, fresh feed, good match. */
function healthySnapshot(overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    id: "1316306267021132",
    name: "During Days",
    vertical: "commerce",
    productCount: 287361,
    diagnostics: [],
    productSets: [
      { id: "SET_OK", name: "Everything", filter: null, productCount: 287361, inStockCount: 287361 },
    ],
    feeds: [],
    events: [],
    pixelIds: ["111"],
    outOfStockCount: 0,
    warnings: [],
    fetchedAt: FETCHED_AT,
    ...overrides,
  };
}

function use(over: Partial<CatalogAdSetUse> = {}): CatalogAdSetUse {
  return {
    adSetId: "AS1",
    adSetName: "Prospecting",
    campaignId: "C1",
    accountId: "act_1",
    productSetId: "SET_OK",
    learningStatus: "SUCCESS",
    effectiveStatus: "ACTIVE",
    ...over,
  };
}

function find(findings: CatalogFinding[], idPrefix: string): CatalogFinding | undefined {
  return findings.find((f) => f.id === idPrefix || f.id.startsWith(`${idPrefix}:`));
}

describe("CATALOG_THRESHOLDS", () => {
  it("exports the documented values", () => {
    expect(CATALOG_THRESHOLDS).toEqual({
      minDeliverableItems: 20,
      outOfStockShareHigh: 0.2,
      feedStaleHours: 48,
      matchRateLow: 0.9,
      matchedOtherShareMedium: 0.1,
    });
  });
});

describe("evaluateCatalog: healthy catalogue", () => {
  it("returns nothing for a clean catalogue", () => {
    const { findings, learningLinks } = evaluateCatalog(healthySnapshot(), [use()]);
    expect(findings).toEqual([]);
    expect(learningLinks).toEqual([]);
  });
});

describe("diagnostics_must_fix", () => {
  const diagnostics = [
    {
      type: "DA_VISIBILITY_ISSUES",
      severity: "MUST_FIX",
      title: "Items hidden from dynamic ads",
      errorCode: 1,
      affectedItems: 56743,
      children: [
        { type: "PRODUCT_OUT_OF_STOCK", description: "Out of stock", affectedItems: 55311 },
        { type: "EMPTY_TITLE", description: "Empty title", affectedItems: 1427 },
        { type: "image_fetch_failed", description: "Image fetch failed", affectedItems: 3 },
        { type: "da_policy_violation", description: "Policy violation", affectedItems: 2 },
      ],
    },
    {
      type: "SHOPS_VISIBILITY_ISSUES",
      severity: "MUST_FIX",
      title: "Items hidden from Shops",
      errorCode: 2,
      affectedItems: 130,
      children: [{ type: "PRODUCT_NOT_APPROVED", description: "Not approved", affectedItems: 130 }],
    },
    {
      type: "IMAGE_QUALITY",
      severity: "OPPORTUNITY",
      title: "Image quality",
      errorCode: null,
      affectedItems: 10003,
      children: [{ type: "not_enough_images", description: "Not enough images", affectedItems: 10003 }],
    },
  ];

  it("flags MUST_FIX diagnostics as high with the formatted count", () => {
    const { findings } = evaluateCatalog(healthySnapshot({ diagnostics }), []);
    const f = findings.find((x) => x.id === "diagnostics_must_fix");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("high");
    expect(f!.evidence.join("\n")).toContain("56,743");
    expect(f!.evidence.join("\n")).toContain("130");
    expect(f!.fix).toBeNull();
  });

  it("treats OPPORTUNITY diagnostics as low and never as must-fix", () => {
    const { findings } = evaluateCatalog(healthySnapshot({ diagnostics }), []);
    const low = findings.find((x) => x.id === "diagnostics_opportunity");
    expect(low?.severity).toBe("low");
    expect(low?.evidence.join("\n")).toContain("10,003");
    const must = findings.find((x) => x.id === "diagnostics_must_fix")!;
    expect(must.evidence.join("\n")).not.toContain("10,003");
  });

  it("treats any other severity as medium", () => {
    const d = [{ ...diagnostics[0], severity: "WARNING" }];
    const { findings } = evaluateCatalog(healthySnapshot({ diagnostics: d }), []);
    expect(findings.find((x) => x.id === "diagnostics_other")?.severity).toBe("medium");
  });

  it("ignores diagnostics with no affected items", () => {
    const d = [{ ...diagnostics[0], affectedItems: 0, children: [] }];
    const { findings } = evaluateCatalog(healthySnapshot({ diagnostics: d }), []);
    expect(findings).toEqual([]);
  });
});

describe("out_of_stock_in_used_set", () => {
  const set = (inStockCount: number | null, filter: string | null = null) => ({
    id: "SET_A",
    name: "Dresses",
    filter,
    productCount: 287361,
    inStockCount,
  });

  it("does not flag 19.3% out of stock at the 0.2 threshold", () => {
    const snap = healthySnapshot({ productSets: [set(232015)] });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_A" })]);
    expect(find(findings, "out_of_stock_in_used_set")).toBeUndefined();
  });

  it("flags 30% out of stock and offers an in-stock filter fix", () => {
    const snap = healthySnapshot({ productSets: [set(200000)] });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_A" })]);
    const f = find(findings, "out_of_stock_in_used_set")!;
    expect(f.severity).toBe("medium");
    expect(f.productSetIds).toEqual(["SET_A"]);
    expect(f.adSetIds).toEqual(["AS1"]);
    expect(f.evidence.join("\n")).toContain("87,361");
    expect(f.evidence.join("\n")).toContain("30.4%");
    expect(f.fix).toEqual({
      toolName: "update_product_set_filter",
      args: { product_set_id: "SET_A", filter: IN_STOCK },
    });
  });

  it("and-s the in-stock condition with an existing filter", () => {
    const existing = '{"category":{"i_contains":"dress"}}';
    const snap = healthySnapshot({ productSets: [set(200000, existing)] });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_A" })]);
    const f = find(findings, "out_of_stock_in_used_set")!;
    expect(f.fix).toEqual({
      toolName: "update_product_set_filter",
      args: { product_set_id: "SET_A", filter: `{"and":[${existing},${IN_STOCK}]}` },
    });
  });

  it("offers no fix when the set already filters to in stock", () => {
    const existing = '{ "availability": { "eq": "in stock" } }';
    const snap = healthySnapshot({ productSets: [set(200000, existing)] });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_A" })]);
    const f = find(findings, "out_of_stock_in_used_set")!;
    expect(f.fix).toBeNull();
  });

  it("skips sets whose in-stock count is unknown", () => {
    const snap = healthySnapshot({ productSets: [set(null)] });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_A" })]);
    expect(findings).toEqual([]);
  });

  it("honours a threshold override", () => {
    const snap = healthySnapshot({ productSets: [set(232015)] });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_A" })], {
      outOfStockShareHigh: 0.1,
    });
    expect(find(findings, "out_of_stock_in_used_set")).toBeDefined();
  });
});

describe("small_product_set", () => {
  it("flags a used set with only 4 deliverable items as high, with no automatic fix", () => {
    const snap = healthySnapshot({
      productSets: [{ id: "SET_S", name: "Tiny", filter: '{"brand":{"eq":"X"}}', productCount: 90, inStockCount: 4 }],
    });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_S" })]);
    const f = find(findings, "small_product_set")!;
    expect(f.severity).toBe("high");
    expect(f.fix).toBeNull();
    expect(f.evidence.join("\n")).toContain("4");
    expect(f.howToFix.toLowerCase()).toContain("widen");
    expect(f.howToFix.toLowerCase()).toContain("filter");
    expect(f.adSetIds).toEqual(["AS1"]);
  });

  it("is critical when nothing in the set is in stock", () => {
    const snap = healthySnapshot({
      productSets: [{ id: "SET_S", name: "Empty", filter: null, productCount: 90, inStockCount: 0 }],
    });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_S" })]);
    expect(find(findings, "small_product_set")?.severity).toBe("critical");
  });
});

describe("small set with high out-of-stock share", () => {
  it("reports both findings but attaches no in-stock filter fix", () => {
    const snap = healthySnapshot({
      productSets: [{ id: "SET_S", name: "Tiny", filter: null, productCount: 90, inStockCount: 4 }],
    });
    const { findings } = evaluateCatalog(snap, [use({ productSetId: "SET_S" })]);
    expect(find(findings, "small_product_set")).toBeDefined();
    const oos = find(findings, "out_of_stock_in_used_set")!;
    expect(oos).toBeDefined();
    expect(oos.fix).toBeNull();
  });
});

describe("feed findings", () => {
  const feed = (over: Record<string, unknown> = {}) => ({
    id: "FEED1",
    name: "Daily feed",
    productCount: 287361,
    scheduleUrl: "https://example.com/feed.csv",
    scheduleInterval: "DAILY",
    lastUpload: { endTime: hoursAgo(72), errorCount: 0, warningCount: 0 },
    ...over,
  });

  it("flags a scheduled feed last uploaded 72h ago and offers a refresh", () => {
    const { findings } = evaluateCatalog(healthySnapshot({ feeds: [feed()] }), []);
    const f = find(findings, "feed_stale")!;
    expect(f.severity).toBe("medium");
    expect(f.evidence.join("\n")).toContain("72");
    expect(f.fix).toEqual({ toolName: "request_feed_refresh", args: { feed_id: "FEED1" } });
  });

  it("does not flag a feed uploaded 10h ago", () => {
    const f = feed({ lastUpload: { endTime: hoursAgo(10), errorCount: 0, warningCount: 0 } });
    const { findings } = evaluateCatalog(healthySnapshot({ feeds: [f] }), []);
    expect(find(findings, "feed_stale")).toBeUndefined();
  });

  it("does not flag a feed without a schedule URL as stale", () => {
    const { findings } = evaluateCatalog(healthySnapshot({ feeds: [feed({ scheduleUrl: null })] }), []);
    expect(find(findings, "feed_stale")).toBeUndefined();
  });

  it("flags upload errors", () => {
    const f = feed({ lastUpload: { endTime: hoursAgo(5), errorCount: 12, warningCount: 0 } });
    const { findings } = evaluateCatalog(healthySnapshot({ feeds: [f] }), []);
    const e = find(findings, "feed_upload_errors")!;
    expect(e.evidence.join("\n")).toContain("12");
    expect(find(findings, "feed_stale")).toBeUndefined();
  });

  it("produces neither feed finding when the catalogue has no feeds", () => {
    const { findings } = evaluateCatalog(healthySnapshot({ feeds: [] }), [use()]);
    expect(find(findings, "feed_stale")).toBeUndefined();
    expect(find(findings, "feed_upload_errors")).toBeUndefined();
  });
});

describe("match findings", () => {
  const ev = (over: Record<string, unknown> = {}) => ({
    event: "ViewContent",
    pixelId: "111",
    matched: 4398,
    unmatched: 10,
    matchedOtherCatalogs: 0,
    ...over,
  });

  it("does not flag a 99.8% match rate", () => {
    const { findings } = evaluateCatalog(healthySnapshot({ events: [ev()] }), []);
    expect(find(findings, "low_match_rate")).toBeUndefined();
  });

  it("flags 500 matched / 300 unmatched", () => {
    const { findings } = evaluateCatalog(
      healthySnapshot({ events: [ev({ matched: 500, unmatched: 300 })] }),
      [],
    );
    const f = find(findings, "low_match_rate")!;
    expect(f.evidence.join("\n")).toContain("62.5%");
    expect(f.evidence.join("\n")).toContain("ViewContent");
    expect(f.evidence.join("\n")).toContain("300");
  });

  it("ignores events with no volume", () => {
    const { findings } = evaluateCatalog(healthySnapshot({ events: [ev({ matched: 0, unmatched: 0 })] }), []);
    expect(findings).toEqual([]);
  });

  it("flags events matching another catalogue", () => {
    const { findings } = evaluateCatalog(
      healthySnapshot({ events: [ev({ event: "Purchase", matched: 2295, unmatched: 0, matchedOtherCatalogs: 2103 })] }),
      [],
    );
    const f = find(findings, "matched_other_catalog")!;
    expect(f.severity).toBe("medium");
    expect(f.evidence.join("\n")).toContain("Purchase");
    expect(f.evidence.join("\n")).toContain("2,103");
  });

  it("rates a 9% cross-catalogue share as low", () => {
    const { findings } = evaluateCatalog(
      healthySnapshot({ events: [ev({ matched: 910, unmatched: 0, matchedOtherCatalogs: 90 })] }),
      [],
    );
    const f = find(findings, "matched_other_catalog")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("low");
  });

  it("rates a 10% cross-catalogue share as medium", () => {
    const { findings } = evaluateCatalog(
      healthySnapshot({ events: [ev({ matched: 900, unmatched: 0, matchedOtherCatalogs: 100 })] }),
      [],
    );
    expect(find(findings, "matched_other_catalog")?.severity).toBe("medium");
  });

  it("flags even a tiny cross-catalogue count", () => {
    const { findings } = evaluateCatalog(
      healthySnapshot({ events: [ev({ matched: 5000, unmatched: 0, matchedOtherCatalogs: 1 })] }),
      [],
    );
    expect(find(findings, "matched_other_catalog")?.severity).toBe("low");
  });

  it("does not flag an event with no cross-catalogue matches", () => {
    const { findings } = evaluateCatalog(healthySnapshot({ events: [ev()] }), []);
    expect(find(findings, "matched_other_catalog")).toBeUndefined();
  });
});

describe("learningLinks", () => {
  it("marks a FAIL ad set on a 4-item set as a likely contributor", () => {
    const snap = healthySnapshot({
      productSets: [{ id: "SET_S", name: "Tiny", filter: null, productCount: 90, inStockCount: 4 }],
    });
    const { learningLinks } = evaluateCatalog(snap, [use({ productSetId: "SET_S", learningStatus: "FAIL" })]);
    expect(learningLinks).toHaveLength(1);
    expect(learningLinks[0].verdict).toBe("likely_contributor");
    expect(learningLinks[0].adSetId).toBe("AS1");
    expect(learningLinks[0].productSetId).toBe("SET_S");
    expect(learningLinks[0].reasons.join("\n")).toContain("4");
  });

  it("marks a FAIL ad set on a healthy set as healthy", () => {
    const snap = healthySnapshot({
      feeds: [
        {
          id: "F",
          name: "f",
          productCount: 1,
          scheduleUrl: "https://x/y.csv",
          scheduleInterval: "DAILY",
          lastUpload: { endTime: hoursAgo(2), errorCount: 0, warningCount: 0 },
        },
      ],
      events: [{ event: "Purchase", pixelId: "1", matched: 1000, unmatched: 5, matchedOtherCatalogs: 0 }],
      productSets: [{ id: "SET_OK", name: "All", filter: null, productCount: 287361, inStockCount: 232015 }],
    });
    const { learningLinks } = evaluateCatalog(snap, [use({ learningStatus: "FAIL" })]);
    expect(learningLinks).toHaveLength(1);
    expect(learningLinks[0].verdict).toBe("healthy");
  });

  it("counts catalogue-wide problems (stale feed) as contributors", () => {
    const snap = healthySnapshot({
      feeds: [
        {
          id: "F",
          name: "f",
          productCount: 1,
          scheduleUrl: "https://x/y.csv",
          scheduleInterval: "DAILY",
          lastUpload: { endTime: hoursAgo(100), errorCount: 0, warningCount: 0 },
        },
      ],
    });
    const { learningLinks } = evaluateCatalog(snap, [use({ learningStatus: "FAIL" })]);
    expect(learningLinks[0].verdict).toBe("likely_contributor");
  });

  it("does not use another set's problem as a reason", () => {
    const snap = healthySnapshot({
      productSets: [
        { id: "SET_OK", name: "All", filter: null, productCount: 1000, inStockCount: 1000 },
        { id: "SET_S", name: "Tiny", filter: null, productCount: 90, inStockCount: 4 },
      ],
    });
    const { learningLinks } = evaluateCatalog(snap, [
      use({ adSetId: "A", productSetId: "SET_OK", learningStatus: "FAIL" }),
      use({ adSetId: "B", productSetId: "SET_S", learningStatus: "FAIL" }),
    ]);
    expect(learningLinks.find((l) => l.adSetId === "A")?.verdict).toBe("healthy");
    expect(learningLinks.find((l) => l.adSetId === "B")?.verdict).toBe("likely_contributor");
  });

  it("does not claim health when the stock count is unavailable", () => {
    const snap = healthySnapshot({
      productSets: [{ id: "SET_X", name: "X", filter: null, productCount: 1000, inStockCount: null }],
    });
    const { learningLinks } = evaluateCatalog(snap, [use({ productSetId: "SET_X", learningStatus: "FAIL" })]);
    expect(learningLinks[0].verdict).toBe("healthy");
    const text = learningLinks[0].reasons.join("\n");
    expect(text).toContain("SET_X could not be checked");
    expect(text).toContain("stock count unavailable");
    expect(text).not.toContain("No catalogue problem found");
  });

  it("does not claim health when the product set is missing from the snapshot", () => {
    const { learningLinks } = evaluateCatalog(
      healthySnapshot(),
      [use({ productSetId: "SET_GONE", learningStatus: "FAIL" })],
    );
    expect(learningLinks[0].verdict).toBe("healthy");
    expect(learningLinks[0].reasons.join("\n")).toContain("SET_GONE could not be checked");
    expect(learningLinks[0].reasons.join("\n")).not.toContain("No catalogue problem found");
  });

  it("does not let a low-share cross-catalogue match explain a learning failure", () => {
    const snap = healthySnapshot({
      events: [{ event: "Purchase", pixelId: "1", matched: 5000, unmatched: 0, matchedOtherCatalogs: 1 }],
    });
    const { learningLinks } = evaluateCatalog(snap, [use({ learningStatus: "FAIL" })]);
    expect(learningLinks[0].verdict).toBe("healthy");
  });

  it("produces no link for non-FAIL ad sets", () => {
    const snap = healthySnapshot({
      productSets: [{ id: "SET_S", name: "Tiny", filter: null, productCount: 90, inStockCount: 4 }],
    });
    const { learningLinks } = evaluateCatalog(snap, [
      use({ productSetId: "SET_S", learningStatus: "LEARNING" }),
      use({ adSetId: "AS2", productSetId: "SET_S", learningStatus: "SUCCESS" }),
      use({ adSetId: "AS3", productSetId: "SET_S", learningStatus: null }),
    ]);
    expect(learningLinks).toEqual([]);
  });
});

describe("ordering", () => {
  it("sorts critical to low, then by affected items", () => {
    const snap = healthySnapshot({
      diagnostics: [
        { type: "A", severity: "OPPORTUNITY", title: "Opp", errorCode: null, affectedItems: 9, children: [] },
        { type: "B", severity: "MUST_FIX", title: "Must", errorCode: null, affectedItems: 5, children: [] },
      ],
      productSets: [
        { id: "SET_E", name: "Empty", filter: null, productCount: 90, inStockCount: 0 },
        { id: "SET_M", name: "Mid", filter: null, productCount: 1000, inStockCount: 500 },
        { id: "SET_N", name: "Mid2", filter: null, productCount: 1000, inStockCount: 100 },
      ],
    });
    const { findings } = evaluateCatalog(snap, [
      use({ adSetId: "1", productSetId: "SET_E" }),
      use({ adSetId: "2", productSetId: "SET_M" }),
      use({ adSetId: "3", productSetId: "SET_N" }),
    ]);
    const order = ["critical", "high", "medium", "low"];
    const ranks = findings.map((f) => order.indexOf(f.severity));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(findings[0].severity).toBe("critical");
    expect(findings[findings.length - 1].id).toBe("diagnostics_opportunity");
    const oos = findings.filter((f) => f.id.startsWith("out_of_stock_in_used_set"));
    expect(oos.map((f) => f.productSetIds[0])).toEqual(["SET_N", "SET_M", "SET_E"]);
  });
});
