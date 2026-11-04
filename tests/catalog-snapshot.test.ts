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

  it("reads a used set missing from the listing directly, with its in-stock count", async () => {
    const MISSING = "1582553996612911";
    const { graph, calls } = fakeGraph({
      [MISSING]: { id: MISSING, name: "Hidden set", filter: '{"brand":{"eq":"X"}}', product_count: "40" },
      [`${MISSING}/products`]: { data: [], summary: { total_count: 7 } },
    });
    const snap = await fetchCatalogSnapshot(graph, CATALOG, { productSetIds: [SET_ID, MISSING] });
    const direct = calls.find((c) => c.path === MISSING)!;
    expect(direct.params.fields).toBe("id,name,filter,product_count");
    expect(snap.productSets.find((s) => s.id === MISSING)).toEqual({
      id: MISSING,
      name: "Hidden set",
      filter: '{"brand":{"eq":"X"}}',
      productCount: 40,
      inStockCount: 7,
    });
    // Sets present in the listing are not fetched again.
    expect(calls.some((c) => c.path === SET_ID)).toBe(false);
    expect(snap.warnings).toEqual([]);
  });

  it("turns a failed direct fetch of a missing set into a warning", async () => {
    const MISSING = "1582553996612911";
    const { graph } = fakeGraph({ [MISSING]: new Error("gone") });
    const snap = await fetchCatalogSnapshot(graph, CATALOG, { productSetIds: [MISSING] });
    expect(snap.productSets.some((s) => s.id === MISSING)).toBe(false);
    expect(snap.warnings.some((w) => w.includes(`product set ${MISSING}`))).toBe(true);
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

  const SUBCODE_33 = new MetaGraphError(
    "Unsupported get request. Object with ID '30227494536896319' does not exist, cannot be loaded due to missing permissions, or does not support this operation",
    100,
    400,
    33,
  );

  it("classifies Meta's code 100 / subcode 33 unreadable-object error as not_found, not a permission problem", () => {
    expect(catalogAccessReason(SUBCODE_33)).toBe("not_found");
    // The wording alone is enough, even without the subcode.
    expect(catalogAccessReason(new MetaGraphError(SUBCODE_33.message, 100, 400))).toBe("not_found");
  });

  it("still classifies a real permission error as missing_permission", () => {
    expect(
      catalogAccessReason(new MetaGraphError("(#100) This application has not been approved to use this api", 100, 400)),
    ).toBe("missing_permission");
    expect(catalogAccessReason(new MetaGraphError("denied", 10, 403))).toBe("missing_permission");
  });

  it("classifies an expired token (190) as expired, not as missing permission", () => {
    expect(catalogAccessReason(new MetaGraphError("expired", 190, 401))).toBe("expired");
    expect(catalogAccessReason(new MetaGraphError("denied", 10, 403))).toBe("missing_permission");
  });
});

describe("diagnostic text from Meta", () => {
  it("strips HTML and decodes entities in titles and descriptions", async () => {
    const { graph } = fakeGraph({
      [`${CATALOG}/diagnostics`]: {
        data: [
          {
            type: "DA_VISIBILITY_ISSUES",
            severity: "MUST_FIX",
            title: "Items &amp; sets",
            number_of_affected_items: 3,
            diagnostics: [
              {
                type: "PRODUCT_OUT_OF_STOCK",
                description: "This item is marked as <strong>out of stock</strong>. Items that aren&#039;t in stock won&#039;t show.",
                number_of_affected_items: 2,
              },
              {
                type: "OTHER",
                description:
                  'Fix it in the <a href="https://facebook.com/x?a=1&amp;b=2">feed</a>.<br />Then &quot;refresh&quot; &lt;now&gt;&nbsp;&#8211; ok',
                number_of_affected_items: 1,
              },
            ],
          },
        ],
      },
    });
    const snap = await fetchCatalogSnapshot(graph, CATALOG);
    expect(snap.diagnostics[0].title).toBe("Items & sets");
    expect(snap.diagnostics[0].children[0].description).toBe(
      "This item is marked as out of stock. Items that aren't in stock won't show.",
    );
    expect(snap.diagnostics[0].children[1].description).toBe('Fix it in the feed. Then "refresh" <now> – ok');
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

  it("rejected is matched client-side and sends no review_status filter", async () => {
    const { graph, calls } = fakeGraph({
      [productsPath]: {
        data: [
          { id: "a", retailer_id: "ra", review_status: "", errors: [] },
          { id: "b", retailer_id: "rb", review_status: "REJECTED", errors: [] },
          { id: "c", retailer_id: "rc", review_status: "", errors: [{ error_type: "PRODUCT_NOT_APPROVED", error_priority: "high", title: "t" }] },
          { id: "d", retailer_id: "rd", review_status: "", errors: [{ error_type: "PRODUCT_OUT_OF_STOCK", error_priority: "high", title: "t" }] },
        ],
      },
    });
    const res = await listCatalogProducts(graph, CATALOG, { issue: "rejected" });
    expect(calls[0].params.filter).toBeUndefined();
    expect(res.products.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("any_error keeps only products that carry errors", async () => {
    const { graph } = fakeGraph({
      [productsPath]: { data: [row, { id: "2", retailer_id: "r2", errors: [] }] },
    });
    const res = await listCatalogProducts(graph, CATALOG, { issue: "any_error" });
    expect(res.products.map((p) => p.id)).toEqual(["8253074574816159"]);
  });

  it("client-side issues scan further pages until matches are found", async () => {
    const clean = { id: "x", retailer_id: "rx", errors: [] };
    const bad = (id: string) => ({ id, retailer_id: `r${id}`, errors: [{ error_type: "E", error_priority: "low", title: "t" }] });
    const { graph, calls } = fakeGraph({
      [productsPath]: (params: Params) =>
        params.after === "C1"
          ? { data: [bad("m1"), bad("m2")], paging: { cursors: { after: "C2" }, next: "n2" } }
          : { data: [clean], paging: { cursors: { after: "C1" }, next: "n1" } },
    });
    const res = await listCatalogProducts(graph, CATALOG, { issue: "any_error", limit: 2 });
    expect(res.products.map((p) => p.id)).toEqual(["m1", "m2"]);
    expect(res.next).toBe("C2");
    expect(calls).toHaveLength(2);
  });

  it("stops scanning after 5 pages and returns the cursor to resume from", async () => {
    let n = 0;
    const { graph, calls } = fakeGraph({
      [productsPath]: () => {
        n += 1;
        return { data: [{ id: `p${n}`, retailer_id: "r", errors: [] }], paging: { cursors: { after: `C${n}` }, next: "more" } };
      },
    });
    const res = await listCatalogProducts(graph, CATALOG, { issue: "any_error", limit: 5 });
    expect(calls).toHaveLength(5);
    expect(res.products).toEqual([]);
    expect(res.next).toBe("C5");
  });

  it("returns next null when scanning reaches the end", async () => {
    const { graph } = fakeGraph({ [productsPath]: { data: [{ id: "x", retailer_id: "r", errors: [] }] } });
    const res = await listCatalogProducts(graph, CATALOG, { issue: "any_error" });
    expect(res.next).toBeNull();
  });
});

describe("snapshot robustness", () => {
  it("skips rows without an id", async () => {
    const { graph } = fakeGraph({
      [`${CATALOG}/product_sets`]: { data: [{ name: "no id", product_count: 1 }, { id: "9", name: "ok", product_count: 2 }] },
      [`${CATALOG}/external_event_sources`]: { data: [{}, { id: "px" }] },
    });
    const snap = await fetchCatalogSnapshot(graph, CATALOG);
    expect(snap.productSets.map((s) => s.id)).toEqual(["9"]);
    expect(snap.pixelIds).toEqual(["px"]);
  });

  it("warns when a list was cut off by paging", async () => {
    const { graph } = fakeGraph({
      [`${CATALOG}/product_sets`]: { data: [], paging: { cursors: { after: "x" }, next: "n" } },
      [`${CATALOG}/diagnostics`]: { data: [], paging: { cursors: { after: "x" }, next: "n" } },
      [`${CATALOG}/event_stats`]: { data: [], paging: { cursors: { after: "x" }, next: "n" } },
    });
    const snap = await fetchCatalogSnapshot(graph, CATALOG);
    expect(snap.warnings.some((w) => /product sets/i.test(w) && /cut off/i.test(w))).toBe(true);
    expect(snap.warnings.some((w) => /diagnostics/i.test(w) && /cut off/i.test(w))).toBe(true);
    expect(snap.warnings.some((w) => /event stats/i.test(w) && /cut off/i.test(w))).toBe(true);
  });
});
