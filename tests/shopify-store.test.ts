import { beforeEach, describe, expect, it } from "vitest";
import type { ShopifySalesRow } from "@/lib/shopify/types";
import { getDemoStore } from "@/lib/demo/store";
import { MOCK_SHOP, mockShopifyCatalog, mockShopifySales } from "@/lib/shopify/mock";
import {
  deleteConnection,
  getConnection,
  loadCatalog,
  loadSales,
  replaceCatalog,
  replaceSales,
  saveConnection,
  setSyncStatus,
} from "@/lib/shopify/store";

const A = "client_clicktrends";
const B = "client_other";

const input = (clientId: string) => ({
  clientId,
  shopDomain: MOCK_SHOP.domain,
  shopName: MOCK_SHOP.name,
  currency: MOCK_SHOP.currency,
  scopes: ["read_products"],
  accessTokenEncrypted: "v1:cipher",
  connectedBy: null,
});

beforeEach(() => {
  const s = getDemoStore();
  s.shopifyConnections.length = 0;
  s.shopifyCollections.length = 0;
  s.shopifyProducts.length = 0;
  s.shopifyVariants.length = 0;
  s.shopifySales.length = 0;
});

describe("shopify demo store", () => {
  it("saves and gets a connection, upserting on client", async () => {
    const first = await saveConnection(input(A));
    expect(first.last_sync_status).toBe("never");
    const again = await saveConnection({ ...input(A), shopName: "Renamed" });
    expect(again.id).toBe(first.id);
    expect((await getConnection(A))?.shop_name).toBe("Renamed");
    expect(await getConnection(B)).toBeNull();
    expect(getDemoStore().shopifyConnections).toHaveLength(1);
  });

  it("reconnecting the same store keeps its sync status and catalogue", async () => {
    await saveConnection(input(A));
    await replaceCatalog(A, mockShopifyCatalog(A));
    const counts = { orders: 3, sales_variants: 2, skipped_line_items: 0 };
    await setSyncStatus(A, { status: "ok", counts });
    await saveConnection({ ...input(A), accessTokenEncrypted: "v1:new" });
    const c = (await getConnection(A))!;
    expect(c.last_sync_status).toBe("ok");
    expect(c.last_sync_at).toBeTruthy();
    expect(c.last_sync_counts).toEqual(counts);
    expect((await loadCatalog(A)).products).toHaveLength(6);
  });

  it("connecting a different store drops the old catalogue and resets the sync status", async () => {
    await saveConnection(input(A));
    await saveConnection(input(B));
    await replaceCatalog(A, mockShopifyCatalog(A));
    await replaceCatalog(B, mockShopifyCatalog(B));
    await setSyncStatus(A, {
      status: "ok",
      counts: { orders: 3, sales_variants: 8, skipped_line_items: 0 },
    });
    await setSyncStatus(A, { status: "error", error: "Shopify is busy, try again in a few minutes" });
    const saved = await saveConnection({ ...input(A), shopDomain: "other-store.myshopify.com", shopName: "Other" });
    expect(saved).toMatchObject({
      shop_domain: "other-store.myshopify.com",
      shop_name: "Other",
      last_sync_at: null,
      last_sync_status: "never",
      last_sync_error: null,
      last_sync_counts: null,
    });
    const loaded = await loadCatalog(A);
    expect(loaded.collections).toHaveLength(0);
    expect(loaded.products).toHaveLength(0);
    expect(loaded.variants).toHaveLength(0);
    expect((await loadCatalog(B)).products).toHaveLength(6);
  });

  it("returns copies, not stored state", async () => {
    await saveConnection(input(A));
    const c = (await getConnection(A))!;
    c.shop_name = "mutated";
    expect((await getConnection(A))?.shop_name).toBe(MOCK_SHOP.name);
  });

  it("sets sync status; ok stamps last_sync_at", async () => {
    await saveConnection(input(A));
    await setSyncStatus(A, { status: "running" });
    expect((await getConnection(A))?.last_sync_at).toBeNull();
    const counts = { orders: 3, sales_variants: 2, skipped_line_items: 1 };
    await setSyncStatus(A, { status: "ok", counts });
    const c = (await getConnection(A))!;
    expect(c.last_sync_status).toBe("ok");
    expect(c.last_sync_at).toBeTruthy();
    expect(c.last_sync_counts).toEqual(counts);
    await setSyncStatus(A, { status: "error", error: "Token revoked" });
    const e = (await getConnection(A))!;
    expect(e.last_sync_error).toBe("Token revoked");
    expect(e.last_sync_counts).toEqual(counts);
  });

  it("replaceCatalog removes rows missing from the new set, leaving other clients alone", async () => {
    const a = mockShopifyCatalog(A);
    await replaceCatalog(A, a);
    await replaceCatalog(B, mockShopifyCatalog(B));
    const dropped = a.products[0].gid;
    await replaceCatalog(A, {
      collections: a.collections,
      products: a.products.slice(1),
      variants: a.variants.filter((v) => v.product_gid !== dropped),
    });
    const loaded = await loadCatalog(A);
    expect(loaded.products.map((p) => p.gid)).not.toContain(dropped);
    expect(loaded.products).toHaveLength(a.products.length - 1);
    expect(loaded.variants.some((v) => v.product_gid === dropped)).toBe(false);
    expect((await loadCatalog(B)).products).toHaveLength(a.products.length);
  });

  it("loadCatalog returns copies", async () => {
    await replaceCatalog(A, mockShopifyCatalog(A));
    (await loadCatalog(A)).products[0].title = "mutated";
    expect((await loadCatalog(A)).products[0].title).not.toBe("mutated");
  });

  it("deleteConnection removes the connection and synced rows for that client only", async () => {
    await saveConnection(input(A));
    await saveConnection(input(B));
    await replaceCatalog(A, mockShopifyCatalog(A));
    await replaceCatalog(B, mockShopifyCatalog(B));
    await deleteConnection(A);
    expect(await getConnection(A)).toBeNull();
    expect((await loadCatalog(A)).products).toHaveLength(0);
    expect((await loadCatalog(A)).collections).toHaveLength(0);
    expect(await getConnection(B)).not.toBeNull();
    expect((await loadCatalog(B)).products.length).toBeGreaterThan(0);
  });

  it("bumps the demo store version so shopify arrays exist after hot reload", () => {
    const s = getDemoStore();
    expect(Array.isArray(s.shopifyVariants)).toBe(true);
    expect((globalThis as { __adspirerDemoStoreVersion?: number }).__adspirerDemoStoreVersion).toBe(12);
  });
});

const strip = (c: string): Omit<ShopifySalesRow, "client_id">[] => mockShopifySales(c);

describe("demo sales", () => {
  it("replaceSales replaces the client's rows and leaves other clients alone", async () => {
    await replaceSales(A, strip(A));
    await replaceSales(B, strip(B));
    await replaceSales(A, strip(A).slice(0, 2));
    expect((await loadSales(A)).map((r) => r.variant_key)).toEqual(strip(A).slice(0, 2).map((r) => r.variant_key));
    expect((await loadSales(A)).every((r) => r.client_id === A)).toBe(true);
    expect(await loadSales(B)).toHaveLength(8);
  });

  it("replaceSales with no rows clears the client's sales (an empty sync is valid)", async () => {
    await replaceSales(A, strip(A));
    await replaceSales(A, []);
    expect(await loadSales(A)).toEqual([]);
  });

  it("loadSales returns copies", async () => {
    await replaceSales(A, strip(A));
    (await loadSales(A))[0].product_title = "mutated";
    expect((await loadSales(A))[0].product_title).not.toBe("mutated");
  });

  it("connecting a different store clears that client's sales, not another client's", async () => {
    await saveConnection(input(A));
    await saveConnection(input(B));
    await replaceSales(A, strip(A));
    await replaceSales(B, strip(B));
    await saveConnection({ ...input(A), shopDomain: "other-store.myshopify.com" });
    expect(await loadSales(A)).toHaveLength(0);
    expect(await loadSales(B)).toHaveLength(8);
  });

  it("reconnecting the same store keeps its sales", async () => {
    await saveConnection(input(A));
    await replaceSales(A, strip(A));
    await saveConnection(input(A));
    expect(await loadSales(A)).toHaveLength(8);
  });

  it("deleteConnection clears that client's sales only", async () => {
    await saveConnection(input(A));
    await saveConnection(input(B));
    await replaceSales(A, strip(A));
    await replaceSales(B, strip(B));
    await deleteConnection(A);
    expect(await loadSales(A)).toHaveLength(0);
    expect(await loadSales(B)).toHaveLength(8);
  });

  it("calls onChunk after each 500-row chunk, and a throwing onChunk keeps the old rows", async () => {
    await replaceSales(A, strip(A));
    const base = strip(A)[0];
    const many = Array.from({ length: 1201 }, (_, i) => ({ ...base, variant_key: `k${i}` }));
    let n = 0;
    await replaceSales(B, many, async () => {
      n += 1;
    });
    expect(n).toBe(3);
    await expect(
      replaceSales(A, many, async () => {
        throw new Error("heartbeat failed");
      }),
    ).rejects.toThrow("heartbeat failed");
    expect(await loadSales(A)).toHaveLength(8);
  });
});

describe("mockShopifySales", () => {
  it("has 8 ClickTrends variants with mixed windows and one synthetic key", () => {
    const rows = mockShopifySales(A);
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.variant_key.startsWith("product:"))).toHaveLength(1);
    expect(rows.some((r) => r.units_30d === 0)).toBe(true);
    expect(rows.some((r) => r.units_30d > 0)).toBe(true);
    expect(new Set(rows.map((r) => r.variant_key)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.client_id).toBe(A);
      expect(r.product_title && r.vendor && r.product_type && r.sku).toBeTruthy();
      expect(r.units_60d).toBeGreaterThanOrEqual(r.units_30d);
      expect(r.revenue_60d_cents).toBeGreaterThanOrEqual(r.revenue_30d_cents);
    }
  });
});

describe("mockShopifyCatalog", () => {
  it("has the ClickTrends shape", () => {
    const c = mockShopifyCatalog(A);
    expect(c.collections.map((x) => x.title).sort()).toEqual(["Bar stools", "Sofas"]);
    expect(c.products).toHaveLength(6);
    expect(c.variants.some((v) => v.inventory_quantity === null)).toBe(true);
    expect(c.variants.some((v) => v.inventory_quantity === 0)).toBe(true);
    expect(c.variants.some((v) => v.cost_cents === null)).toBe(true);
    for (const v of c.variants) {
      expect(v.client_id).toBe(A);
      expect(v.units_60d).toBeGreaterThanOrEqual(v.units_30d);
      expect(v.revenue_60d_cents).toBeGreaterThanOrEqual(v.revenue_30d_cents);
      expect(c.products.some((p) => p.gid === v.product_gid)).toBe(true);
    }
  });
});
