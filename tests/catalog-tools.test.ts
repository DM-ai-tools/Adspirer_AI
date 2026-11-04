import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  commerce: vi.fn(),
  report: vi.fn(),
  products: vi.fn(),
  shopify: vi.fn(),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/meta/catalog/service", () => ({
  getClientCommerce: (...a: unknown[]) => mocks.commerce(...a),
  getCatalogReport: (...a: unknown[]) => mocks.report(...a),
  listClientCatalogProducts: (...a: unknown[]) => mocks.products(...a),
}));
vi.mock("@/lib/shopify/store", () => ({ getConnection: (...a: unknown[]) => mocks.shopify(...a) }));

import { buildWorkspaceReadToolSet, buildWorkspaceReadToolSetForClient, workspaceReadToolNames } from "@/lib/agent/diagnose-tools-ai";
import { buildStaticSystemPromptV2 } from "@/lib/agent/prompts-v2";
import { demoCatalogSnapshot } from "@/lib/meta/catalog/demo";
import { humanToolLabel, humanToolProgressLabel } from "@/lib/tools/display-labels";
import { classify } from "@/lib/tools/policy";
import { getTool, invokeTool, type ToolContext } from "@/lib/tools/registry";
import "@/lib/tools/diagnose";

const NAMES = ["meta_catalogs", "meta_catalog_health", "meta_catalog_products", "meta_catalog_feeds"];
const CT = "client_clicktrends";
const ctx = (clientId = CT): ToolContext => ({ clientId, userId: "user_admin", taskId: "task_x" });
type Result = Record<string, unknown>;
const call = async (name: string, args: unknown, clientId = CT) => (await invokeTool(name, args, ctx(clientId))) as Result;

const CATALOG = { id: "cat_1", name: "Main catalogue", productCount: 120 };
const USE = {
  adSetId: "as_1",
  adSetName: "Dynamic ads",
  campaignId: "c_1",
  accountId: "act_1",
  productSetId: "set_1",
  learningStatus: "FAIL" as const,
  effectiveStatus: "ACTIVE",
  catalogId: "cat_1",
};
const FINDING = {
  id: "feed_stale:feed_1",
  severity: "high" as const,
  title: "Feed not refreshed",
  evidence: ["Last upload 5 days ago"],
  productSetIds: ["set_1"],
  adSetIds: ["as_1"],
  howToFix: "Refresh the feed",
  fix: null,
};
const LINK = { adSetId: "as_1", productSetId: "set_1", verdict: "likely_contributor" as const, reasons: ["Only 4 items in stock"] };
const SNAPSHOT = demoCatalogSnapshot("2026-11-04T00:00:00.000Z");
const okReport = () => ({
  state: "ok" as const,
  snapshot: SNAPSHOT,
  findings: [FINDING],
  learningLinks: [LINK],
  uses: [USE],
});
const MISSING = { state: "missing_permission" as const, message: "Reconnect Facebook and allow catalogue access." };
const NO_CATALOG = { state: "no_catalog" as const, message: "No catalogue is linked to this client's ad accounts." };

beforeEach(() => {
  mocks.commerce.mockReset().mockResolvedValue({ state: "ok", catalogs: [CATALOG], uses: [USE] });
  mocks.report.mockReset().mockResolvedValue(okReport());
  mocks.products.mockReset().mockResolvedValue({ state: "ok", products: [], next: null });
  mocks.shopify.mockReset().mockResolvedValue(null);
});

describe("policy and labels", () => {
  it("classifies the four tools as diagnose, with labels", () => {
    for (const name of NAMES) {
      expect(classify(name), name).toBe("diagnose");
      expect(getTool(name), name).toBeDefined();
      expect(humanToolLabel(name), name).not.toMatch(/_/);
      expect(humanToolProgressLabel(name), name).toMatch(/…$/);
    }
  });
});

describe("meta_catalogs", () => {
  it("returns the catalogues and the ad sets using each, for ctx.clientId only", async () => {
    const out = await call("meta_catalogs", { client_id: "client_other" });
    expect(mocks.commerce).toHaveBeenCalledWith(CT);
    expect(out.source).toBe("Meta");
    expect(out.catalogs).toEqual([
      {
        id: "cat_1",
        name: "Main catalogue",
        product_count: 120,
        ad_sets: [expect.objectContaining({ id: "as_1", name: "Dynamic ads", product_set_id: "set_1", learning_status: "FAIL" })],
      },
    ]);
  });

  it("a missing permission comes back flagged", async () => {
    mocks.commerce.mockResolvedValue(MISSING);
    expect(await call("meta_catalogs", {})).toEqual({ error: true, source: "Meta", missing_permission: true, message: MISSING.message });
  });

  it("other failure states come back as an error with the message", async () => {
    mocks.commerce.mockResolvedValue(NO_CATALOG);
    expect(await call("meta_catalogs", {})).toEqual({ error: true, source: "Meta", message: NO_CATALOG.message });
  });

  it("a thrown service error (rate limit) becomes an error object", async () => {
    mocks.commerce.mockRejectedValue(new Error("(#4) Application request limit reached"));
    expect(await call("meta_catalogs", {})).toEqual({ error: true, source: "Meta", message: "(#4) Application request limit reached" });
  });
});

describe("meta_catalog_health", () => {
  it("returns the snapshot summary, findings and learning links", async () => {
    const out = await call("meta_catalog_health", { catalog_id: "cat_1" });
    expect(mocks.report).toHaveBeenCalledWith(CT, "cat_1");
    const snap = SNAPSHOT;
    expect(out).toMatchObject({
      source: "Meta",
      catalog_id: snap.id,
      name: snap.name,
      product_count: snap.productCount,
      out_of_stock_count: snap.outOfStockCount,
      findings: [FINDING],
      learning_links: [LINK],
    });
    expect(out.product_sets).toHaveLength(snap.productSets.length);
    expect(out.diagnostics).toHaveLength(snap.diagnostics.length);
    expect(out.fetched_at).toBe(snap.fetchedAt);
  });

  it("another client's catalogue id returns the no_catalog message", async () => {
    mocks.report.mockResolvedValue(NO_CATALOG);
    expect(await call("meta_catalog_health", { catalog_id: "cat_of_someone_else" })).toEqual({
      error: true,
      source: "Meta",
      message: NO_CATALOG.message,
    });
  });

  it("missing permission is flagged; thrown errors are caught", async () => {
    mocks.report.mockResolvedValue(MISSING);
    expect(await call("meta_catalog_health", { catalog_id: "cat_1" })).toEqual({
      error: true,
      source: "Meta",
      missing_permission: true,
      message: MISSING.message,
    });
    mocks.report.mockRejectedValue(new Error("Meta returned 503"));
    expect(await call("meta_catalog_health", { catalog_id: "cat_1" })).toEqual({ error: true, source: "Meta", message: "Meta returned 503" });
  });

  it("requires a catalog_id", async () => {
    await expect(call("meta_catalog_health", {})).rejects.toThrow();
  });
});

describe("meta_catalog_feeds", () => {
  it("returns the feeds with the last upload", async () => {
    const out = await call("meta_catalog_feeds", { catalog_id: "cat_1" });
    const feeds = SNAPSHOT.feeds;
    expect(out.source).toBe("Meta");
    expect(out.feeds).toHaveLength(feeds.length);
    expect(out.feeds).toEqual(
      feeds.map((f) => expect.objectContaining({ id: f.id, name: f.name, product_count: f.productCount, last_upload: f.lastUpload })),
    );
  });

  it("errors map the same way", async () => {
    mocks.report.mockResolvedValue(MISSING);
    expect(await call("meta_catalog_feeds", { catalog_id: "cat_1" })).toMatchObject({ error: true, missing_permission: true });
    mocks.report.mockRejectedValue(new Error("boom"));
    expect(await call("meta_catalog_feeds", { catalog_id: "cat_1" })).toEqual({ error: true, source: "Meta", message: "boom" });
  });
});

describe("meta_catalog_products", () => {
  const product = (n: number) => ({
    id: `p${n}`,
    retailerId: `R${n}`,
    name: `Product ${n}`,
    availability: "out of stock",
    reviewStatus: null,
    visibility: "published",
    url: null,
    imageUrl: null,
    price: "10 USD",
    errors: [],
  });

  it("passes the client from ctx, the issue and the cursor, and returns one page", async () => {
    mocks.products.mockResolvedValue({ state: "ok", products: [product(1), product(2)], next: "cursor2" });
    const out = await call("meta_catalog_products", { catalog_id: "cat_1", issue: "out_of_stock", after: "cursor1", client_id: "x" });
    const [clientId, catalogId, opts] = mocks.products.mock.calls[0];
    expect(clientId).toBe(CT);
    expect(catalogId).toBe("cat_1");
    expect(opts).toMatchObject({ issue: "out_of_stock", after: "cursor1" });
    expect(out.products).toHaveLength(2);
    expect(out.next).toBe("cursor2");
    expect((out.products as Array<Result>)[0]).toMatchObject({ id: "p1", retailer_id: "R1", availability: "out of stock" });
  });

  it("never returns more than 50 products, and says so", async () => {
    mocks.products.mockResolvedValue({ state: "ok", products: Array.from({ length: 60 }, (_, i) => product(i)), next: null });
    const out = await call("meta_catalog_products", { catalog_id: "cat_1", issue: "any_error" });
    expect(out.products).toHaveLength(50);
    expect(out.truncated).toBe(true);
  });

  it("rejects an unknown issue", async () => {
    await expect(call("meta_catalog_products", { catalog_id: "cat_1", issue: "price; drop" })).rejects.toThrow();
  });

  it("another client's catalogue id returns the no_catalog message", async () => {
    mocks.products.mockResolvedValue(NO_CATALOG);
    expect(await call("meta_catalog_products", { catalog_id: "nope" })).toEqual({ error: true, source: "Meta", message: NO_CATALOG.message });
  });

  it("missing permission is flagged; thrown errors are caught", async () => {
    mocks.products.mockResolvedValue(MISSING);
    expect(await call("meta_catalog_products", { catalog_id: "cat_1" })).toMatchObject({ error: true, missing_permission: true });
    mocks.products.mockRejectedValue(new Error("(#17) User request limit reached"));
    expect(await call("meta_catalog_products", { catalog_id: "cat_1" })).toEqual({
      error: true,
      source: "Meta",
      message: "(#17) User request limit reached",
    });
  });
});

describe("tool set", () => {
  it("leaves the four out when the client has no catalogue", async () => {
    mocks.commerce.mockResolvedValue(NO_CATALOG);
    const names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx()));
    for (const n of NAMES) expect(names).not.toContain(n);
  });

  it("leaves them out on missing permission or a thrown error", async () => {
    mocks.commerce.mockResolvedValue(MISSING);
    for (const n of NAMES) expect(Object.keys(await buildWorkspaceReadToolSetForClient(ctx()))).not.toContain(n);
    mocks.commerce.mockRejectedValue(new Error("rate limited"));
    for (const n of NAMES) expect(Object.keys(await buildWorkspaceReadToolSetForClient(ctx()))).not.toContain(n);
  });

  it("offers all four, diagnose class, when the client has a catalogue", async () => {
    const names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx()));
    for (const n of NAMES) expect(names).toContain(n);
    for (const n of names) expect(classify(n), n).toBe("diagnose");
  });

  it("works alongside a connected Shopify store, and survives a failing Shopify check", async () => {
    mocks.shopify.mockResolvedValue({ id: "conn" });
    let names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx()));
    for (const n of [...NAMES, "shopify_products"]) expect(names).toContain(n);
    mocks.shopify.mockRejectedValue(new Error("db down"));
    names = Object.keys(await buildWorkspaceReadToolSetForClient(ctx()));
    for (const n of NAMES) expect(names).toContain(n);
    expect(names).not.toContain("shopify_products");
  });

  it("keeps the base allowlist unchanged", () => {
    for (const n of NAMES) {
      expect(workspaceReadToolNames()).not.toContain(n);
      expect(Object.keys(buildWorkspaceReadToolSet(ctx()))).not.toContain(n);
    }
  });

  it("runs through the tool set without the Meta account refusal", async () => {
    const tools = await buildWorkspaceReadToolSetForClient(ctx());
    const execute = tools.meta_catalogs!.execute! as (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
    const out = await execute({}, { toolCallId: "t1", messages: [] });
    expect(out.error).toBeUndefined();
  });
});

describe("prompt", () => {
  it("names the tools, when to use them, and the learning-limited wording rules", () => {
    const p = buildStaticSystemPromptV2();
    for (const n of NAMES) expect(p).toContain(n);
    expect(p).toMatch(/learning limited/i);
    expect(p).toContain("likely_contributor");
    expect(p).toContain("catalogue looks healthy");
    expect(p).toMatch(/out of stock/i);
    expect(p).toMatch(/pixel/i);
  });
});
