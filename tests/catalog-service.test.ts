import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  demo: false,
  token: vi.fn(),
  accounts: vi.fn(),
  graphGet: vi.fn(),
}));

vi.mock("@/lib/config", () => ({ getConfig: () => ({ isDemoMode: mocks.demo }) }));
vi.mock("@/lib/meta/get-user-token", () => ({ getUserMetaToken: () => mocks.token() }));
vi.mock("@/lib/adspirer/resolve-meta-account", () => ({
  loadMappedMetaAccounts: (clientId: string) => mocks.accounts(clientId),
}));
vi.mock("@/lib/meta/graph-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/graph-client")>();
  class FakeGraph {
    get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      return mocks.graphGet(path, params) as Promise<T>;
    }
  }
  return { ...original, MetaGraphClient: FakeGraph };
});

import { MetaGraphError } from "@/lib/meta/graph-client";
import {
  discoverClientCatalogs,
  getCatalogReport,
  getClientCommerce,
  listClientCatalogProducts,
  resetCatalogReportCache,
} from "@/lib/meta/catalog/service";
import { DEMO_CATALOG_ID } from "@/lib/meta/catalog/demo";

type Params = Record<string, unknown>;

const CATALOG = "1316306267021132";
const SET = "1290781623112463";

function adSet(id: string, productSetId: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Ad set ${id}`,
    campaign_id: `camp_${id}`,
    effective_status: "ACTIVE",
    learning_stage_info: { status: "LEARNING" },
    ...(productSetId ? { promoted_object: { product_set_id: productSetId } } : { promoted_object: { pixel_id: "9" } }),
    ...over,
  };
}

/** Graph stub for discovery: two accounts, both pointing at one product set. */
function discoveryGraph() {
  const calls: Array<{ path: string; params: Params }> = [];
  const graph = {
    get: async <T,>(path: string, params: Params = {}): Promise<T> => {
      calls.push({ path, params });
      if (path === "act_1/adsets") return { data: [adSet("A1", SET), adSet("A2", null)] } as T;
      if (path === "act_2/adsets") return { data: [adSet("B1", SET, { learning_stage_info: { status: "FAIL" } })] } as T;
      if (path === SET) {
        return { id: SET, product_catalog: { id: CATALOG, name: "During Days", product_count: "287361" } } as T;
      }
      return { data: [] } as T;
    },
  };
  return { graph, calls };
}

const permissionError = () => new MetaGraphError("(#200) Requires catalog_management permission", 200, 403);

describe("discoverClientCatalogs", () => {
  it("two accounts sharing one product set yield one catalogue and two uses", async () => {
    const { graph, calls } = discoveryGraph();
    const out = await discoverClientCatalogs(graph, ["act_1", "act_2"]);
    expect(out.catalogs).toEqual([{ id: CATALOG, name: "During Days", productCount: 287361 }]);
    expect(out.uses.map((u) => u.adSetId).sort()).toEqual(["A1", "B1"]);
    expect(out.uses.find((u) => u.adSetId === "B1")).toMatchObject({
      accountId: "act_2",
      productSetId: SET,
      learningStatus: "FAIL",
      catalogId: CATALOG,
    });
    // One lookup per distinct set, not per ad set.
    expect(calls.filter((c) => c.path === SET)).toHaveLength(1);
    expect(String(calls.find((c) => c.path === SET)!.params.fields)).toBe("product_catalog{id,name,product_count}");
  });

  it("ignores ad sets without a product_set_id", async () => {
    const { graph } = discoveryGraph();
    const out = await discoverClientCatalogs(graph, ["act_1"]);
    expect(out.uses.map((u) => u.adSetId)).toEqual(["A1"]);
  });

  it("requests ad sets with the learning and promoted_object fields, paged", async () => {
    const { graph, calls } = discoveryGraph();
    await discoverClientCatalogs(graph, ["act_1"]);
    const call = calls.find((c) => c.path === "act_1/adsets")!;
    expect(String(call.params.fields)).toBe("id,name,campaign_id,effective_status,learning_stage_info,promoted_object");
    expect(call.params.limit).toBe(500);
  });

  it("normalises a bare account id to act_{id}", async () => {
    const { graph, calls } = discoveryGraph();
    await discoverClientCatalogs(graph, ["1"]);
    expect(calls.some((c) => c.path === "act_1/adsets")).toBe(true);
  });

  it("follows paging up to five pages", async () => {
    let page = 0;
    const graph = {
      get: async <T,>(path: string): Promise<T> => {
        if (path === "act_1/adsets") {
          page += 1;
          return { data: [adSet(`P${page}`, null)], paging: { next: "n", cursors: { after: `c${page}` } } } as T;
        }
        return { data: [] } as T;
      },
    };
    await discoverClientCatalogs(graph, ["act_1"]);
    expect(page).toBe(5);
  });

  it("maps a learning status Meta does not define to null", async () => {
    const graph = {
      get: async <T,>(path: string): Promise<T> => {
        if (path === "act_1/adsets") return { data: [adSet("A1", SET, { learning_stage_info: { status: "WHATEVER" } })] } as T;
        return { id: SET, product_catalog: { id: CATALOG, name: "C", product_count: 5 } } as T;
      },
    };
    const out = await discoverClientCatalogs(graph, ["act_1"]);
    expect(out.uses[0]!.learningStatus).toBeNull();
  });

  it("a permission failure reading the product set becomes a CatalogAccessError", async () => {
    const graph = {
      get: async <T,>(path: string): Promise<T> => {
        if (path === "act_1/adsets") return { data: [adSet("A1", SET)] } as T;
        throw permissionError();
      },
    };
    await expect(discoverClientCatalogs(graph, ["act_1"])).rejects.toMatchObject({
      name: "CatalogAccessError",
      reason: "missing_permission",
    });
  });

  it("skips a product set the token cannot read and keeps the other set's catalogue", async () => {
    const BAD_SET = "30227494536896319";
    const unreadable = new MetaGraphError(
      `Unsupported get request. Object with ID '${BAD_SET}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`,
      100,
      400,
      33,
    );
    const graph = {
      get: async <T,>(path: string): Promise<T> => {
        if (path === "act_1/adsets") return { data: [adSet("A1", SET), adSet("A2", BAD_SET)] } as T;
        if (path === BAD_SET) throw unreadable;
        return { id: SET, product_catalog: { id: CATALOG, name: "During Days", product_count: 10 } } as T;
      },
    };
    const out = await discoverClientCatalogs(graph, ["act_1"]);
    expect(out.catalogs).toEqual([{ id: CATALOG, name: "During Days", productCount: 10 }]);
    expect(out.uses.map((u) => u.adSetId)).toEqual(["A1"]);
    expect(out.skippedProductSets).toBe(1);
    expect(out.complete).toBe(true);
  });

  it("a real permission error on one set still fails with missing_permission", async () => {
    const graph = {
      get: async <T,>(path: string): Promise<T> => {
        if (path === "act_1/adsets") return { data: [adSet("A1", SET), adSet("A2", "999")] } as T;
        if (path === "999") throw new MetaGraphError("(#100) This application has not been approved to use this api", 100, 400);
        return { id: SET, product_catalog: { id: CATALOG, name: "C", product_count: 1 } } as T;
      },
    };
    await expect(discoverClientCatalogs(graph, ["act_1"])).rejects.toMatchObject({ reason: "missing_permission" });
  });

  it("skips a set that fails for another reason but marks the result incomplete", async () => {
    const graph = {
      get: async <T,>(path: string): Promise<T> => {
        if (path === "act_1/adsets") return { data: [adSet("A1", SET), adSet("A2", "999")] } as T;
        if (path === "999") throw new MetaGraphError("rate limit", 4, 400);
        return { id: SET, product_catalog: { id: CATALOG, name: "C", product_count: 1 } } as T;
      },
    };
    const out = await discoverClientCatalogs(graph, ["act_1"]);
    expect(out.catalogs).toHaveLength(1);
    expect(out.skippedProductSets).toBe(1);
    expect(out.complete).toBe(false);
  });
});

function resetMocks() {
  mocks.demo = false;
  mocks.token.mockReset().mockResolvedValue({ accessToken: "t", expiresAt: null, metaUserId: "u1" });
  mocks.accounts.mockReset().mockResolvedValue([{ meta_account_id: "act_1", access_status: "granted" }]);
  mocks.graphGet.mockReset();
  resetCatalogReportCache();
}

describe("getClientCommerce", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("reports not_connected when there is no Facebook token", async () => {
    mocks.token.mockRejectedValue(new Error("No Meta access token found."));
    const out = await getClientCommerce("c1");
    expect(out).toEqual({ state: "not_connected", message: "Facebook is not connected. Connect it under Admin → Connections." });
  });

  it("reports no_ad_account when nothing granted is mapped", async () => {
    mocks.accounts.mockResolvedValue([{ meta_account_id: "act_9", access_status: "pending" }]);
    const out = await getClientCommerce("c1");
    expect(out).toEqual({
      state: "no_ad_account",
      message: "No Meta ad account is mapped to this client. Map one under Admin → Connections.",
    });
  });

  it("reports no_catalog when no ad set uses a product set", async () => {
    mocks.graphGet.mockResolvedValue({ data: [adSet("A2", null)] });
    const out = await getClientCommerce("c1");
    expect(out).toEqual({ state: "no_catalog", message: "No catalogue is linked to this client's ad accounts." });
  });

  it("maps CatalogAccessError(missing_permission) to a reconnect message", async () => {
    mocks.graphGet.mockImplementation(async (path: string) => {
      if (path === "act_1/adsets") return { data: [adSet("A1", SET)] };
      throw permissionError();
    });
    const out = await getClientCommerce("c1");
    expect(out.state).toBe("missing_permission");
    expect((out as { message: string }).message).toBe(
      "Facebook is connected without catalogue access. Reconnect Facebook and allow catalogue (Commerce Manager) access.",
    );
  });

  it("returns catalogues and uses when everything is linked", async () => {
    mocks.graphGet.mockImplementation(async (path: string) => {
      if (path === "act_1/adsets") return { data: [adSet("A1", SET)] };
      return { id: SET, product_catalog: { id: CATALOG, name: "During Days", product_count: 10 } };
    });
    const out = await getClientCommerce("c1");
    expect(out).toMatchObject({ state: "ok", catalogs: [{ id: CATALOG }], uses: [{ adSetId: "A1" }] });
  });

  it("demo mode returns the fixture without any graph or token call", async () => {
    mocks.demo = true;
    const out = await getClientCommerce("c1");
    expect(out.state).toBe("ok");
    if (out.state === "ok") {
      expect(out.catalogs.map((c) => c.id)).toContain(DEMO_CATALOG_ID);
      expect(out.uses.length).toBeGreaterThan(0);
    }
    expect(mocks.graphGet).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
  });
});

describe("getCatalogReport", () => {
  /** Discovery responses plus the catalogue-level ones the snapshot needs. */
  function liveGraph() {
    mocks.graphGet.mockImplementation(async (path: string) => {
      if (path === "act_1/adsets") return { data: [adSet("A1", SET)] };
      if (path === SET) return { id: SET, product_catalog: { id: CATALOG, name: "During Days", product_count: 10 } };
      if (path === CATALOG) return { id: CATALOG, name: "During Days", vertical: "commerce", product_count: 10 };
      if (path === `${CATALOG}/product_sets`) return { data: [{ id: SET, name: "All", product_count: 10, filter: "{}" }] };
      return { data: [] };
    });
  }
  const catalogCalls = () => mocks.graphGet.mock.calls.filter(([p]) => p === CATALOG).length;

  beforeEach(() => {
    resetMocks();
  });

  it("refuses a catalogue that was not discovered for the client", async () => {
    liveGraph();
    const out = await getCatalogReport("c1", "999");
    expect(out).toEqual({ state: "no_catalog", message: "No catalogue is linked to this client's ad accounts." });
    expect(mocks.graphGet.mock.calls.some(([p]) => p === "999")).toBe(false);
  });

  it("builds the snapshot, findings and uses for a discovered catalogue", async () => {
    liveGraph();
    const out = await getCatalogReport("c1", CATALOG);
    expect(out.state).toBe("ok");
    if (out.state === "ok") {
      expect(out.snapshot.id).toBe(CATALOG);
      expect(out.uses.map((u) => u.adSetId)).toEqual(["A1"]);
      expect(Array.isArray(out.findings)).toBe(true);
      expect(Array.isArray(out.learningLinks)).toBe(true);
    }
  });

  it("caches the snapshot for five minutes per user and catalogue", async () => {
    liveGraph();
    await getCatalogReport("c1", CATALOG);
    const first = catalogCalls();
    expect(first).toBeGreaterThan(0);
    await getCatalogReport("c1", CATALOG);
    expect(catalogCalls()).toBe(first);

    mocks.token.mockResolvedValue({ accessToken: "t", expiresAt: null, metaUserId: "u2" });
    await getCatalogReport("c1", CATALOG);
    expect(catalogCalls()).toBe(first * 2);
  });

  it("maps a CatalogAccessError from the snapshot to its state", async () => {
    liveGraph();
    const base = mocks.graphGet.getMockImplementation()!;
    mocks.graphGet.mockImplementation(async (path: string, params?: Params) => {
      if (path === CATALOG) throw permissionError();
      return base(path, params);
    });
    const out = await getCatalogReport("c1", CATALOG);
    expect(out.state).toBe("missing_permission");
  });

  it("demo mode runs the findings on the demo fixture without a graph call", async () => {
    mocks.demo = true;
    const out = await getCatalogReport("c1", DEMO_CATALOG_ID);
    expect(out.state).toBe("ok");
    if (out.state === "ok") {
      expect(out.findings.length).toBeGreaterThan(0);
      expect(out.learningLinks.some((l) => l.verdict === "likely_contributor")).toBe(true);
    }
    expect(mocks.graphGet).not.toHaveBeenCalled();

    const missing = await getCatalogReport("c1", "nope");
    expect(missing.state).toBe("no_catalog");
  });
});

describe("listClientCatalogProducts", () => {
  beforeEach(() => {
    resetMocks();
    mocks.graphGet.mockImplementation(async (path: string) => {
      if (path === "act_1/adsets") return { data: [adSet("A1", SET)] };
      if (path === SET) return { id: SET, product_catalog: { id: CATALOG, name: "During Days", product_count: 10 } };
      if (path === `${CATALOG}/products`) return { data: [{ id: "p1", retailer_id: "R1", name: "Shoe" }] };
      return { data: [] };
    });
  });

  it("lists one page for a catalogue the client sells from", async () => {
    const out = await listClientCatalogProducts("c1", CATALOG, { limit: 25 });
    expect(out).toMatchObject({ state: "ok", next: null, products: [{ id: "p1", retailerId: "R1" }] });
  });

  it("refuses a catalogue that is not this client's without reading its products", async () => {
    const out = await listClientCatalogProducts("c1", "999");
    expect(out.state).toBe("no_catalog");
    expect(mocks.graphGet.mock.calls.some(([path]) => path === "999/products")).toBe(false);
  });

  it("maps a permission error from the products read to missing_permission", async () => {
    mocks.graphGet.mockImplementation(async (path: string) => {
      if (path === "act_1/adsets") return { data: [adSet("A1", SET)] };
      if (path === SET) return { id: SET, product_catalog: { id: CATALOG, name: "x", product_count: 1 } };
      throw permissionError();
    });
    expect((await listClientCatalogProducts("c1", CATALOG)).state).toBe("missing_permission");
  });

  it("lets other Graph errors (rate limits) propagate", async () => {
    mocks.graphGet.mockImplementation(async (path: string) => {
      if (path === "act_1/adsets") return { data: [adSet("A1", SET)] };
      if (path === SET) return { id: SET, product_catalog: { id: CATALOG, name: "x", product_count: 1 } };
      throw new MetaGraphError("(#4) Application request limit reached", 4, 429);
    });
    await expect(listClientCatalogProducts("c1", CATALOG)).rejects.toThrow(/request limit/);
  });

  it("serves demo products in demo mode, narrowed by issue", async () => {
    mocks.demo = true;
    try {
      const out = await listClientCatalogProducts("c1", DEMO_CATALOG_ID, { issue: "out_of_stock" });
      expect(out).toMatchObject({ state: "ok", products: [{ availability: "out of stock" }] });
      expect((await listClientCatalogProducts("c1", "other")).state).toBe("no_catalog");
    } finally {
      mocks.demo = false;
    }
  });
});

describe("discovery cache", () => {
  const FIVE_MIN = 5 * 60_000;
  const catalogGraph = () =>
    mocks.graphGet.mockImplementation(async (path: string) => {
      if (path === "act_1/adsets") return { data: [adSet("A1", SET)] };
      if (path === SET) return { id: SET, product_catalog: { id: CATALOG, name: "During Days", product_count: 10 } };
      return { data: [] };
    });
  const discoveryCalls = () => mocks.graphGet.mock.calls.filter(([path]) => path === "act_1/adsets").length;

  beforeEach(() => {
    resetMocks();
    vi.useFakeTimers();
    catalogGraph();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a second call within the TTL makes no graph calls", async () => {
    await getClientCommerce("c1");
    const before = mocks.graphGet.mock.calls.length;
    const again = await getClientCommerce("c1");
    expect(again.state).toBe("ok");
    expect(mocks.graphGet.mock.calls.length).toBe(before);
  });

  it("the ownership checks reuse the cached discovery", async () => {
    await getClientCommerce("c1");
    expect(discoveryCalls()).toBe(1);
    await listClientCatalogProducts("c1", CATALOG);
    await getCatalogReport("c1", CATALOG);
    expect(discoveryCalls()).toBe(1);
    expect((await listClientCatalogProducts("c1", "999")).state).toBe("no_catalog");
  });

  it("expires after five minutes and refetches", async () => {
    await getClientCommerce("c1");
    vi.advanceTimersByTime(FIVE_MIN - 1);
    await getClientCommerce("c1");
    expect(discoveryCalls()).toBe(1);
    vi.advanceTimersByTime(2);
    await getClientCommerce("c1");
    expect(discoveryCalls()).toBe(2);
  });

  it("caches no_catalog too", async () => {
    mocks.graphGet.mockReset().mockResolvedValue({ data: [adSet("A2", null)] });
    expect((await getClientCommerce("c1")).state).toBe("no_catalog");
    expect((await getClientCommerce("c1")).state).toBe("no_catalog");
    expect(discoveryCalls()).toBe(1);
  });

  it("does not cache missing_permission, so a reconnect shows up at once", async () => {
    mocks.graphGet.mockReset().mockImplementation(async (path: string) => {
      if (path === "act_1/adsets") return { data: [adSet("A1", SET)] };
      throw permissionError();
    });
    expect((await getClientCommerce("c1")).state).toBe("missing_permission");
    catalogGraph();
    expect((await getClientCommerce("c1")).state).toBe("ok");
  });

  it("does not cache thrown errors or not_connected", async () => {
    mocks.graphGet.mockReset().mockRejectedValueOnce(new MetaGraphError("(#4) Application request limit reached", 4, 429));
    await expect(getClientCommerce("c1")).rejects.toThrow(/request limit/);
    catalogGraph();
    expect((await getClientCommerce("c1")).state).toBe("ok");

    resetCatalogReportCache();
    mocks.token.mockRejectedValueOnce(new Error("No Meta access token found."));
    expect((await getClientCommerce("c1")).state).toBe("not_connected");
    expect((await getClientCommerce("c1")).state).toBe("ok");
  });

  it("a different client does not hit another client's entry", async () => {
    await getClientCommerce("c1");
    const before = discoveryCalls();
    await getClientCommerce("c2");
    expect(discoveryCalls()).toBe(before + 1);
  });

  it("skips the cache when the token has no Meta user id", async () => {
    mocks.token.mockResolvedValue({ accessToken: "t", expiresAt: null, metaUserId: null });
    await getClientCommerce("c1");
    await getClientCommerce("c1");
    expect(discoveryCalls()).toBe(2);
  });

  it("resetCatalogReportCache clears it", async () => {
    await getClientCommerce("c1");
    resetCatalogReportCache();
    await getClientCommerce("c1");
    expect(discoveryCalls()).toBe(2);
  });
});
