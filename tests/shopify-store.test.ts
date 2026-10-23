import { beforeEach, describe, expect, it } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { MOCK_SHOP, mockShopifyCatalog } from "@/lib/shopify/mock";
import {
  deleteConnection,
  getConnection,
  loadCatalog,
  replaceCatalog,
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
    const counts = { collections: 2, products: 6, variants: 8, orders: 3, skipped_line_items: 1 };
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
    expect((globalThis as { __adspirerDemoStoreVersion?: number }).__adspirerDemoStoreVersion).toBe(11);
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
