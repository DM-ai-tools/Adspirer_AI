import { describe, expect, it } from "vitest";
import { catalogAccessReason, CatalogAccessError } from "@/lib/meta/catalog/errors";
import { fetchCatalogSnapshot, listCatalogProducts } from "@/lib/meta/catalog/snapshot";
import { MetaGraphError } from "@/lib/meta/graph-client";

type Params = Record<string, unknown>;
type Call = { path: string; params: Params };
type Handler = (params: Params) => unknown;

const CATALOG = "1316306267021132";
const SET_ID = "1290781623112463";

/** Graph stub keyed by path; records every request. An Error response is thrown. */
function fakeGraph(overrides: Record<string, Handler | Error | unknown> = {}) {
  const calls: Call[] = [];
  const responses: Record<string, Handler | Error | unknown> = {
    [CATALOG]: { id: CATALOG, name: "During Days", vertical: "commerce", product_count: 287361 },
    [`${CATALOG}/diagnostics`]: {
      data: [
        {
          type: "DA_VISIBILITY_ISSUES",
          severity: "MUST_FIX",
          title: "Products not being shown",
          error_code: 3379016,
          affected_channels: ["da"],
          number_of_affected_items: 56743,
          diagnostics: [
            {
              type: "PRODUCT_OUT_OF_STOCK",
              description: "55,311 items need to be fixed.",
              call_to_action: "Out of stock",
              error_code: 1803406,
              number_of_affected_items: 55311,
            },
          ],
        },
      ],
    },
    [`${CATALOG}/product_sets`]: {
      data: [
        {
          id: SET_ID,
          name: "All_Products_Instock",
          filter: '{"availability":{"eq":"in stock"}}',
          product_count: 232015,
        },
        { id: "3242348256072599", name: "All Products", product_count: 287361 },
      ],
    },
    [`${CATALOG}/product_feeds`]: {
      data: [
        {
          id: "2472983283219459",
          name: "During Days Catalogue-2026 - Feed",
          product_count: 0,
          schedule: { url: "https://example.com/feed.csv", interval: "DAILY" },
        },
      ],
    },
    "2472983283219459/uploads": {
      data: [{ end_time: "2026-11-03T10:00:00+0000", error_count: 2, warning_count: 5 }],
    },
    [`${CATALOG}/event_stats`]: {
      data: [
        {
          date_start: "2026-11-02",
          event: "ViewContent",
          event_source: { id: "2078790565933582", source_type: "PIXEL" },
          total_matched_content_ids: 4398,
          total_content_ids_matched_other_catalogs: 1,
          total_unmatched_content_ids: 10,
        },
        {
          date_start: "2026-11-01",
          event: "ViewContent",
          event_source: { id: "2078790565933582", source_type: "PIXEL" },
          total_matched_content_ids: 4000,
          total_content_ids_matched_other_catalogs: 2,
          total_unmatched_content_ids: 5,
        },
      ],
    },
    [`${CATALOG}/external_event_sources`]: { data: [{ id: "2078790565933582" }] },
    [`${SET_ID}/products`]: { data: [], summary: { total_count: 231000 } },
    ...overrides,
  };
  const graph = {
    async get<T>(path: string, params: Params = {}): Promise<T> {
      calls.push({ path, params });
      const r = responses[path];
      if (r === undefined) throw new Error(`unexpected path ${path}`);
      if (r instanceof Error) throw r;
      return (typeof r === "function" ? (r as Handler)(params) : r) as T;
    },
  };
  return { graph, calls };
}

describe("fetchCatalogSnapshot", () => {
  it("builds the snapshot from diagnostics, sets, feeds and event stats", async () => {
    const { graph } = fakeGraph();
    const snap = await fetchCatalogSnapshot(graph, CATALOG);
    expect(snap).toMatchObject({ id: CATALOG, name: "During Days", vertical: "commerce", productCount: 287361 });
    expect(snap.outOfStockCount).toBe(55311);
    expect(snap.diagnostics).toHaveLength(1);
    expect(snap.diagnostics[0]).toMatchObject({
      type: "DA_VISIBILITY_ISSUES",
      severity: "MUST_FIX",
      title: "Products not being shown",
      errorCode: 3379016,
      affectedItems: 56743,
    });
    expect(snap.diagnostics[0].children).toEqual([
      { type: "PRODUCT_OUT_OF_STOCK", description: "55,311 items need to be fixed.", affectedItems: 55311 },
    ]);
    expect(snap.productSets[0]).toMatchObject({
      id: SET_ID,
      filter: '{"availability":{"eq":"in stock"}}',
      productCount: 232015,
      inStockCount: null,
    });
    expect(snap.productSets[1].filter).toBeNull();
    expect(snap.feeds[0]).toMatchObject({
      productCount: 0,
      scheduleUrl: "https://example.com/feed.csv",
      scheduleInterval: "DAILY",
      lastUpload: { endTime: "2026-11-03T10:00:00+0000", errorCount: 2, warningCount: 5 },
    });
    expect(snap.events).toEqual([
      { event: "ViewContent", pixelId: "2078790565933582", matched: 8398, unmatched: 15, matchedOtherCatalogs: 3 },
    ]);
    expect(snap.pixelIds).toEqual(["2078790565933582"]);
    expect(snap.warnings).toEqual([]);
    expect(Number.isNaN(Date.parse(snap.fetchedAt))).toBe(false);
  });

  it("leaves lastUpload null when a feed has no uploads", async () => {
    const { graph } = fakeGraph({ "2472983283219459/uploads": { data: [] } });
    const snap = await fetchCatalogSnapshot(graph, CATALOG);
    expect(snap.feeds[0].lastUpload).toBeNull();
  });

  it("counts in-stock products for each used product set", async () => {
    const { graph, calls } = fakeGraph();
    const snap = await fetchCatalogSnapshot(graph, CATALOG, { productSetIds: [SET_ID] });
    const setCalls = calls.filter((c) => c.path === `${SET_ID}/products`);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].params.filter).toBe('{"availability":{"eq":"in stock"}}');
    expect(setCalls[0].params.summary).toBe("true");
    expect(snap.productSets.find((s) => s.id === SET_ID)?.inStockCount).toBe(231000);
    expect(snap.productSets.find((s) => s.id === "3242348256072599")?.inStockCount).toBeNull();
  });

  it("never pages /products for counts", async () => {
    const { graph, calls } = fakeGraph();
    await fetchCatalogSnapshot(graph, CATALOG, { productSetIds: [SET_ID] });
    expect(calls.some((c) => c.path === `${CATALOG}/products` || c.path.endsWith(`/${CATALOG}/products`))).toBe(false);
  });

  it("turns a failing part into a warning", async () => {
    const { graph } = fakeGraph({ [`${CATALOG}/product_feeds`]: new Error("boom") });
    const snap = await fetchCatalogSnapshot(graph, CATALOG);
    expect(snap.feeds).toEqual([]);
    expect(snap.warnings.some((w) => /feeds/i.test(w))).toBe(true);
    expect(snap.diagnostics).toHaveLength(1);
    expect(snap.productSets).toHaveLength(2);
  });

  it("reports outOfStockCount as null when diagnostics could not be loaded", async () => {
    const { graph } = fakeGraph({ [`${CATALOG}/diagnostics`]: new Error("nope") });
    const snap = await fetchCatalogSnapshot(graph, CATALOG);
    expect(snap.outOfStockCount).toBeNull();
    expect(snap.diagnostics).toEqual([]);
  });

  it("types a missing permission on the first catalogue call", async () => {
    const { graph } = fakeGraph({
      [CATALOG]: new MetaGraphError("(#100) This application has not been approved to use this api", 100, 400),
    });
    const err = await fetchCatalogSnapshot(graph, CATALOG).catch((e) => e);
    expect(err).toBeInstanceOf(CatalogAccessError);
    expect((err as CatalogAccessError).reason).toBe("missing_permission");
  });

  it("rethrows unrelated basics errors untouched", async () => {
    const original = new MetaGraphError("Meta took too long", undefined, 0);
    const { graph } = fakeGraph({ [CATALOG]: original });
    await expect(fetchCatalogSnapshot(graph, CATALOG)).rejects.toBe(original);
  });
});

describe("catalogAccessReason", () => {
  it("maps codes and messages", () => {
    expect(catalogAccessReason(new MetaGraphError("(#200) Requires catalog_management permission", 200, 403))).toBe(
      "missing_permission",
    );
    expect(catalogAccessReason(new MetaGraphError("Unsupported get request", 803, 400))).toBe("not_found");
    expect(catalogAccessReason(new MetaGraphError("Object does not exist", 100, 400))).toBe("not_found");
    expect(catalogAccessReason(new MetaGraphError("rate limit", 4, 400))).toBeNull();
    expect(catalogAccessReason(new Error("x"))).toBeNull();
  });
});

describe("listCatalogProducts", () => {
  const productsPath = `${CATALOG}/products`;
  const row = {
    id: "8253074574816159",
    retailer_id: "42199558717603",
    name: "Tee",
    availability: "out of stock",
    review_status: "",
    visibility: "published",
    url: "https://example.com/tee",
    image_url: "https://example.com/tee.jpg",
    price: "GBP 10.00",
    errors: [{ error_type: "PRODUCT_OUT_OF_STOCK", error_priority: "high", title: "Out of stock", description: "..." }],
  };

  it("filters out-of-stock and returns next only when paging.next exists", async () => {
    const { graph, calls } = fakeGraph({
      [productsPath]: { data: [row], paging: { cursors: { after: "CUR" }, next: "https://graph/next" } },
    });
    const res = await listCatalogProducts(graph, CATALOG, { issue: "out_of_stock", limit: 10 });
    expect(calls[0].params.filter).toBe('{"availability":{"eq":"out of stock"}}');
    expect(calls[0].params.limit).toBe(10);
    expect(res.next).toBe("CUR");
    expect(res.products[0]).toEqual({
      id: "8253074574816159",
      retailerId: "42199558717603",
      name: "Tee",
      availability: "out of stock",
      reviewStatus: null,
      visibility: "published",
      url: "https://example.com/tee",
      imageUrl: "https://example.com/tee.jpg",
      price: "GBP 10.00",
      errors: [{ type: "PRODUCT_OUT_OF_STOCK", priority: "high", title: "Out of stock" }],
    });
  });

  it("returns next null on the last page and forwards the cursor", async () => {
    const { graph, calls } = fakeGraph({
      [productsPath]: { data: [row], paging: { cursors: { after: "CUR" } } },
    });
    const res = await listCatalogProducts(graph, CATALOG, { after: "PREV" });
    expect(res.next).toBeNull();
    expect(calls[0].params.after).toBe("PREV");
    expect(calls[0].params.filter).toBeUndefined();
  });

  it("filters rejected products by review status", async () => {
    const { graph, calls } = fakeGraph({ [productsPath]: { data: [] } });
    await listCatalogProducts(graph, CATALOG, { issue: "rejected" });
    expect(calls[0].params.filter).toBe('{"review_status":{"eq":"rejected"}}');
  });

  it("any_error keeps only products that carry errors", async () => {
    const { graph } = fakeGraph({
      [productsPath]: { data: [row, { id: "2", retailer_id: "r2", errors: [] }] },
    });
    const res = await listCatalogProducts(graph, CATALOG, { issue: "any_error" });
    expect(res.products.map((p) => p.id)).toEqual(["8253074574816159"]);
  });
});
