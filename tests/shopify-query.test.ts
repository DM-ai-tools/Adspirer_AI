import { beforeEach, describe, expect, it } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { MOCK_SHOP, mockShopifyCatalog } from "@/lib/shopify/mock";
import { queryProducts, queryVariants, summarizeCatalog } from "@/lib/shopify/query";
import { replaceCatalog, saveConnection } from "@/lib/shopify/store";

const A = "client_clicktrends";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

async function seed(syncedHoursAgo: number | null = 3) {
  const s = getDemoStore();
  s.shopifyConnections.length = 0;
  s.shopifyCollections.length = 0;
  s.shopifyProducts.length = 0;
  s.shopifyVariants.length = 0;
  const conn = await saveConnection({
    clientId: A,
    shopDomain: MOCK_SHOP.domain,
    shopName: MOCK_SHOP.name,
    currency: MOCK_SHOP.currency,
    scopes: [],
    accessTokenEncrypted: "v1:x",
    connectedBy: null,
  });
  await replaceCatalog(A, mockShopifyCatalog(A));
  const row = s.shopifyConnections.find((c) => c.id === conn.id)!;
  row.last_sync_at = syncedHoursAgo === null ? null : hoursAgo(syncedHoursAgo);
  row.last_sync_status = syncedHoursAgo === null ? "never" : "ok";
}

beforeEach(() => seed());

describe("shared metadata", () => {
  it("not connected", async () => {
    getDemoStore().shopifyConnections.length = 0;
    const out = await queryProducts(A, {}, NOW);
    expect(out).toMatchObject({ connected: false });
    expect((out as { message: string }).message).toBeTruthy();
  });

  it("connected but never synced", async () => {
    await seed(null);
    const out = await queryVariants(A, {}, NOW);
    expect(out).toMatchObject({ connected: true, synced_at: null });
    expect((out as { message: string }).message).toContain("not synced yet");
  });

  it("reports synced_ago, currency and caveat note", async () => {
    const out = (await queryProducts(A, {}, NOW)) as Record<string, unknown>;
    expect(out.synced_ago).toBe("3 hours ago");
    expect(out.stale).toBe(false);
    expect(out.currency).toBe("USD");
    expect(out.note).toContain("Sales are gross of refunds and exclude cancelled and test orders; windows are the last 30 and 60 days.");
  });

  it("flags data older than 72 hours as stale", async () => {
    await seed(80);
    const out = (await summarizeCatalog(A, { group_by: "vendor" }, NOW)) as Record<string, unknown>;
    expect(out.stale).toBe(true);
    expect(out.note).toContain("stale");
  });
});

describe("queryProducts", () => {
  it("sorts and limits", async () => {
    const out = (await queryProducts(A, { sort_by: "units_30d", limit: 2 }, NOW)) as any;
    expect(out.rows.map((r: any) => r.title)).toEqual(["Oak Counter Stool", "Industrial Iron Stool"]);
    expect(out.total_matches).toBe(6);
  });

  it("clamps limit 500 to 100 and 0/negative to at least 1", async () => {
    const out = (await queryProducts(A, { limit: 500 }, NOW)) as any;
    expect(out.rows.length).toBe(6);
    const one = (await queryProducts(A, { limit: -3 }, NOW)) as any;
    expect(one.rows.length).toBe(1);
  });

  it("defaults to 25 rows", async () => {
    const s = getDemoStore();
    const base = s.shopifyProducts[0];
    for (let i = 0; i < 40; i++) s.shopifyProducts.push({ ...base, gid: `gid://p/${i}`, title: `Extra ${i}` });
    const out = (await queryProducts(A, {}, NOW)) as any;
    expect(out.rows.length).toBe(25);
    expect(out.total_matches).toBe(46);
  });

  it("counts untracked variants without adding to stock_units", async () => {
    const out = (await queryProducts(A, { search: "corner" }, NOW)) as any;
    expect(out.rows[0]).toMatchObject({ stock_units: null, untracked_variants: 1, variants: 1 });
    const oak = (await queryProducts(A, { search: "oak" }, NOW)) as any;
    expect(oak.rows[0]).toMatchObject({ stock_units: 33, untracked_variants: 0, price_min: 149, price_max: 159, revenue_30d: 18 * 149 + 11 * 159 });
    expect(oak.rows[0].collections).toEqual(["Bar stools"]);
  });

  it("filters by collection title or handle, case-insensitively", async () => {
    const a = (await queryProducts(A, { collection: "BAR STOOLS" }, NOW)) as any;
    const b = (await queryProducts(A, { collection: "Sofas" }, NOW)) as any;
    expect(a.total_matches).toBe(3);
    expect(b.total_matches).toBe(3);
  });

  it("unknown collection returns zero rows and lists available titles", async () => {
    const out = (await queryProducts(A, { collection: "Lamps" }, NOW)) as any;
    expect(out.rows).toEqual([]);
    expect(out.total_matches).toBe(0);
    expect(out.note).toContain("Bar stools");
    expect(out.note).toContain("Sofas");
  });
});

describe("queryVariants", () => {
  it("sku lookup is exact and case-insensitive", async () => {
    const out = (await queryVariants(A, { sku: "bs-oak-65" }, NOW)) as any;
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ sku: "BS-OAK-65", price: 149, cost: 62, stock: 24 });
    expect(out.rows[0].margin_pct).toBeCloseTo(58.39, 2);
    const partial = (await queryVariants(A, { sku: "BS-OAK" }, NOW)) as any;
    expect(partial.rows).toHaveLength(0);
  });

  it("null cost gives null cost and margin, null stock stays null", async () => {
    const walnut = (await queryVariants(A, { sku: "BS-WAL-01" }, NOW)) as any;
    expect(walnut.rows[0].cost).toBeNull();
    expect(walnut.rows[0].margin_pct).toBeNull();
    const corner = (await queryVariants(A, { sku: "SF-CORNER-1" }, NOW)) as any;
    expect(corner.rows[0].stock).toBeNull();
  });

  it("sorts by price descending by default and limits", async () => {
    const out = (await queryVariants(A, { sort_by: "price", limit: 1 }, NOW)) as any;
    expect(out.rows[0].sku).toBe("SF-CORNER-1");
    expect(out.total_matches).toBe(8);
  });

  it("collection filter works on variants", async () => {
    const out = (await queryVariants(A, { collection: "sofas" }, NOW)) as any;
    expect(out.total_matches).toBe(4);
  });
});

describe("summarizeCatalog", () => {
  it("computes margin over variants with cost and sales plus cost coverage", async () => {
    const out = (await summarizeCatalog(A, { group_by: "vendor" }, NOW)) as any;
    const nordic = out.rows.find((r: any) => r.group === "Nordic Woodworks");
    expect(nordic).toMatchObject({ products: 2, variants: 3, stock_units: 47, units_30d: 34, units_60d: 65 });
    expect(nordic.margin_pct).toBeCloseTo(58.43, 2);
    expect(nordic.cost_coverage).toBe("cost known for 2 of 3 variants sold");
  });

  it("null margin when no costed variants sold", async () => {
    const s = getDemoStore();
    for (const v of s.shopifyVariants) v.cost_cents = null;
    const out = (await summarizeCatalog(A, { group_by: "product_type" }, NOW)) as any;
    expect(out.rows.every((r: any) => r.margin_pct === null)).toBe(true);
  });

  it("collection grouping notes that products count in each collection", async () => {
    const out = (await summarizeCatalog(A, { group_by: "collection" }, NOW)) as any;
    expect(out.rows.map((r: any) => r.group).sort()).toEqual(["Bar stools", "Sofas"]);
    expect(out.note).toContain("each collection");
  });
});

describe("review fixes", () => {
  it("summarizeCatalog: all-untracked group has null stock_units and counts untracked variants", async () => {
    for (const v of getDemoStore().shopifyVariants) v.inventory_quantity = null;
    const out = (await summarizeCatalog(A, { group_by: "vendor" }, NOW)) as any;
    const nordic = out.rows.find((r: any) => r.group === "Nordic Woodworks");
    expect(nordic.stock_units).toBeNull();
    expect(nordic.untracked_variants).toBe(3);
  });

  it("summarizeCatalog: mixed group sums tracked only", async () => {
    const out = (await summarizeCatalog(A, { group_by: "vendor" }, NOW)) as any;
    const loft = out.rows.find((r: any) => r.group === "Loft Living");
    expect(loft.stock_units).toBe(6);
    expect(loft.untracked_variants).toBe(1);
  });

  it("vendor miss lists available vendors", async () => {
    const out = (await queryProducts(A, { vendor: "Acme" }, NOW)) as any;
    expect(out.total_matches).toBe(0);
    expect(out.note).toContain("No rows matched");
    expect(out.note).toContain("vendor");
    expect(out.note).toContain("Nordic Woodworks");
    expect(out.note).toContain("Loft Living");
  });

  it("product_type miss lists available product types", async () => {
    const out = (await queryVariants(A, { search: "zzz" }, NOW)) as any;
    expect(out.note).toContain("No rows matched");
    const p = (await queryProducts(A, { product_type: "Lamp" }, NOW)) as any;
    expect(p.note).toContain("Bar Stool");
  });

  it("sku miss says no variant has that exact SKU and suggests search", async () => {
    const out = (await queryVariants(A, { sku: "BS-OAK" }, NOW)) as any;
    expect(out.note).toContain("No variant has the exact SKU");
    expect(out.note).toContain("search");
  });

  it("invalid sort_by is reported", async () => {
    const out = (await queryProducts(A, { sort_by: "bogus" as any }, NOW)) as any;
    expect(out.note).toContain("Unknown sort_by 'bogus', used units_30d");
    const v = (await queryVariants(A, { sort_by: "nope" as any }, NOW)) as any;
    expect(v.note).toContain("Unknown sort_by 'nope', used units_30d");
  });

  it("stock sort notes untracked listed last", async () => {
    const p = (await queryProducts(A, { sort_by: "stock" }, NOW)) as any;
    expect(p.note).toContain("untracked stock is listed last");
    const v = (await queryVariants(A, { sort_by: "stock" }, NOW)) as any;
    expect(v.note).toContain("untracked stock is listed last");
    expect(v.rows[v.rows.length - 1].stock).toBeNull();
  });
});
