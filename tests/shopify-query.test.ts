import { beforeEach, describe, expect, it } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { MOCK_SHOP, mockShopifySales } from "@/lib/shopify/mock";
import {
  SALES_NOTE,
  SALES_SOURCE,
  describeAgo,
  describeFailedSync,
  querySales,
  type SalesResult,
  type ShopifyUnavailable,
} from "@/lib/shopify/query";
import { replaceSales, saveConnection } from "@/lib/shopify/store";

/** Narrows a read result to the synced-data shape (fails the test otherwise). */
function ok(out: SalesResult | ShopifyUnavailable): SalesResult {
  if ("message" in out) throw new Error(`expected synced data, got: ${out.message}`);
  return out;
}

const A = "client_clicktrends";
const NOW = new Date("2026-10-23T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

async function seed(syncedHoursAgo: number | null = 3) {
  const s = getDemoStore();
  s.shopifyConnections.length = 0;
  s.shopifySales.length = 0;
  const conn = await saveConnection({
    clientId: A,
    shopDomain: MOCK_SHOP.domain,
    shopName: MOCK_SHOP.name,
    currency: MOCK_SHOP.currency,
    scopes: [],
    accessTokenEncrypted: "v1:x",
    connectedBy: null,
  });
  await replaceSales(A, mockShopifySales(A));
  const row = s.shopifyConnections.find((c) => c.id === conn.id)!;
  row.last_sync_at = syncedHoursAgo === null ? null : hoursAgo(syncedHoursAgo);
  row.last_sync_status = syncedHoursAgo === null ? "never" : "ok";
}

beforeEach(() => seed());

describe("helpers kept from the catalogue layer", () => {
  it("describeAgo and describeFailedSync", () => {
    expect(describeAgo(hoursAgo(3), NOW)).toBe("3 hours ago");
    expect(describeAgo(hoursAgo(0.5), NOW)).toBe("30 minutes ago");
    expect(describeAgo(hoursAgo(80), NOW)).toBe("3 days ago");
    expect(describeFailedSync("boom", "2 hours ago")).toBe(
      "The latest sync failed (boom); data is from the last successful sync 2 hours ago.",
    );
  });
});

describe("querySales metadata", () => {
  it("not connected", async () => {
    getDemoStore().shopifyConnections.length = 0;
    const out = await querySales(A, {}, NOW);
    expect(out).toMatchObject({ connected: false });
    expect((out as { message: string }).message).toBeTruthy();
  });

  it("connected but never synced says so plainly and returns no numbers", async () => {
    await seed(null);
    const out = await querySales(A, {}, NOW);
    expect(out).toMatchObject({ connected: true, synced_at: null, source: SALES_SOURCE });
    expect((out as { message: string }).message).toContain("not synced yet");
    expect(out).not.toHaveProperty("rows");
  });

  it("never synced and the first sync failed: says so", async () => {
    await seed(null);
    const row = getDemoStore().shopifyConnections[0];
    row.last_sync_status = "error";
    row.last_sync_error = "Shopify rejected the token: reconnect the store";
    const out = await querySales(A, {}, NOW);
    expect(out).toMatchObject({ connected: true, synced_at: null });
    expect((out as { message: string }).message).toContain("not synced yet");
    expect((out as { message: string }).message).toContain(
      "latest sync failed (Shopify rejected the token: reconnect the store)",
    );
  });

  it("reports source, synced_ago, currency, window and the exact sales note", async () => {
    const out = ok(await querySales(A, {}, NOW));
    expect(out.source).toBe("Shopify (synced sales)");
    expect(out.synced_ago).toBe("3 hours ago");
    expect(out.synced_at).toBe(hoursAgo(3));
    expect(out.stale).toBe(false);
    expect(out.currency).toBe("USD");
    expect(out.window).toBe(30);
    expect(out.other_window).toBe(60);
    expect(out.note.startsWith(SALES_NOTE)).toBe(true);
    expect(SALES_NOTE).toBe(
      "Sales are line revenue after product and code discounts, before order-level discounts, shipping and tax; " +
        "gross of refunds (refunded and removed units still count); cancelled and test orders are excluded; " +
        "custom (non-product) line items and lines whose product no longer exists are excluded; " +
        "windows are the rolling 30 and 60 days up to the sync time.",
    );
    expect(out.note).not.toContain("stale");
    expect(out.note).not.toContain("latest sync failed");
  });

  it("flags data older than 72 hours as stale", async () => {
    await seed(80);
    const out = ok(await querySales(A, {}, NOW));
    expect(out.stale).toBe(true);
    expect(out.note).toContain("Data is stale: last synced 3 days ago (older than 72 hours)");
    const fresh = await seed(71).then(() => querySales(A, {}, NOW));
    expect(ok(fresh).stale).toBe(false);
  });

  it("latest sync failed: says so and that rows may mix the last good save with partial newer data", async () => {
    await seed(30);
    const row = getDemoStore().shopifyConnections[0];
    row.last_sync_status = "error";
    row.last_sync_error = "Shopify is busy, try again in a few minutes";
    const out = ok(await querySales(A, {}, NOW));
    expect(out.note).toContain(
      "The latest sync failed (Shopify is busy, try again in a few minutes); data is from the last successful sync 30 hours ago.",
    );
    expect(out.note).toContain("partial");
    expect(out.rows.length).toBeGreaterThan(0);
  });

  it("a running sync notes that rows may be mid-update; a good one adds nothing", async () => {
    getDemoStore().shopifyConnections[0].last_sync_status = "running";
    const running = ok(await querySales(A, {}, NOW));
    expect(running.note).toContain("A sync is running now");
    expect(running.note).not.toContain("latest sync failed");
  });
});

describe("querySales rows", () => {
  it("defaults: one row per variant, window 30, sorted by units descending, all 8 rows", async () => {
    const out = ok(await querySales(A, {}, NOW));
    expect(out.group_by).toBe("variant");
    expect(out.sort_by).toBe("units");
    expect(out.total_groups).toBe(8);
    expect(out.rows.map((r) => r.sku)).toEqual([
      "BS-OAK-65",
      "BS-OAK-75",
      "BS-IRON-BLK",
      "BS-WAL-01",
      "SF-VEL-3G",
      "SF-CORNER-1",
      "SF-VEL-3N",
      "BS-DISC-01",
    ]);
    expect(out.rows[0]).toEqual({
      group: "Oak Counter Stool / Oak / 65cm",
      product: "Oak Counter Stool",
      variant: "Oak / 65cm",
      deleted_variant: false,
      sku: "BS-OAK-65",
      vendor: "Nordic Woodworks",
      product_type: "Bar Stool",
      variants: 1,
      units: 18,
      revenue: 2682,
      units_other_window: 31,
      revenue_other_window: 4619,
    });
  });

  it("group_by vendor sums units and revenue over each vendor's variants", async () => {
    const out = ok(await querySales(A, { group_by: "vendor" }, NOW));
    expect(out.rows.map((r) => r.group)).toEqual(["Nordic Woodworks", "Forge & Co", "Loft Living"]);
    const nordic = out.rows[0];
    expect(nordic).toMatchObject({
      vendor: "Nordic Woodworks",
      product_type: "Bar Stool",
      product: null,
      sku: null,
      variants: 4,
      units: 34,
      revenue: 5376,
      units_other_window: 69,
      revenue_other_window: 10781,
    });
    expect(out.totals).toEqual({ units: 47, revenue: 15203, units_other_window: 101, revenue_other_window: 31729 });
  });

  it("window 60 swaps the windows; revenue sort orders by revenue", async () => {
    const out = ok(await querySales(A, { group_by: "vendor", window: 60, sort_by: "revenue" }, NOW));
    expect(out.window).toBe(60);
    expect(out.other_window).toBe(30);
    expect(out.rows.map((r) => [r.group, r.revenue])).toEqual([
      ["Loft Living", 18687],
      ["Nordic Woodworks", 10781],
      ["Forge & Co", 2261],
    ]);
    expect(out.rows[0].revenue_other_window).toBe(8994);
    const asc = ok(await querySales(A, { group_by: "vendor", sort_by: "revenue", desc: false }, NOW));
    expect(asc.rows.map((r) => r.group)).toEqual(["Forge & Co", "Nordic Woodworks", "Loft Living"]);
  });

  it("group_by product and product_type", async () => {
    const products = ok(await querySales(A, { group_by: "product", sort_by: "revenue" }, NOW));
    expect(products.rows[0]).toMatchObject({ group: "Velvet Three Seater Sofa", product: "Velvet Three Seater Sofa", variants: 2, units: 4, sku: null });
    const oak = products.rows.find((r) => r.group === "Oak Counter Stool")!;
    expect(oak).toMatchObject({ units: 29, revenue: 4431, variants: 2 });
    const types = ok(await querySales(A, { group_by: "product_type" }, NOW));
    expect(types.rows.map((r) => [r.group, r.units])).toEqual([
      ["Bar Stool", 41],
      ["Sofa", 6],
    ]);
  });

  it("sku match is exact (trimmed, ignoring case); a partial SKU matches nothing", async () => {
    const out = ok(await querySales(A, { sku: " bs-oak-65 " }, NOW));
    expect(out.rows.map((r) => r.sku)).toEqual(["BS-OAK-65"]);
    const partial = ok(await querySales(A, { sku: "BS-OAK" }, NOW));
    expect(partial.rows).toEqual([]);
    expect(partial.note).toContain('No sold variant has the exact SKU "BS-OAK"');
  });

  it("search ANDs words over product, variant, SKU, vendor and type; vendor and product_type are exact", async () => {
    const out = ok(await querySales(A, { search: "stool oak" }, NOW));
    expect(out.rows.map((r) => r.sku)).toEqual(["BS-OAK-65", "BS-OAK-75"]);
    const vendor = ok(await querySales(A, { vendor: "loft living" }, NOW));
    expect(vendor.total_groups).toBe(3);
    const type = ok(await querySales(A, { product_type: "Sofa" }, NOW));
    expect(type.total_groups).toBe(3);
    const partialVendor = ok(await querySales(A, { vendor: "Loft" }, NOW));
    expect(partialVendor.rows).toEqual([]);
    expect(partialVendor.note).toContain("Vendors with sales: Forge & Co, Loft Living, Nordic Woodworks.");
    const miss = ok(await querySales(A, { product_type: "Lamp" }, NOW));
    expect(miss.note).toContain("Product types with sales: Bar Stool, Sofa.");
    expect(miss.note).toContain("no row");
  });

  it("limit defaults to 25 and clamps to 1..100", async () => {
    const base = mockShopifySales(A)[0];
    const many = Array.from({ length: 140 }, (_, i) => ({ ...base, variant_key: `k${i}`, sku: `SKU-${i}` }));
    await replaceSales(A, many);
    expect(ok(await querySales(A, {}, NOW)).rows).toHaveLength(25);
    const big = ok(await querySales(A, { limit: 500 }, NOW));
    expect(big.rows).toHaveLength(100);
    expect(big.total_groups).toBe(140);
    expect(big.note).toContain("Showing the first 100 of 140");
    expect(ok(await querySales(A, { limit: -3 }, NOW)).rows).toHaveLength(1);
  });

  it("money is rounded from integer cents without float drift", async () => {
    const base = mockShopifySales(A)[0];
    await replaceSales(A, [
      { ...base, variant_key: "a", sku: "A", vendor: "V", units_30d: 1, revenue_30d_cents: 1999, units_60d: 1, revenue_60d_cents: 1999 },
      { ...base, variant_key: "b", sku: "B", vendor: "W", units_30d: 1, revenue_30d_cents: 10, units_60d: 1, revenue_60d_cents: 10 },
      { ...base, variant_key: "c", sku: "C", vendor: "W", units_30d: 1, revenue_30d_cents: 20, units_60d: 1, revenue_60d_cents: 20 },
    ]);
    const one = ok(await querySales(A, { sku: "A" }, NOW));
    expect(one.rows[0].revenue).toBe(19.99);
    // 0.1 + 0.2 in floats is 0.30000000000000004: cents are summed first.
    const w = ok(await querySales(A, { vendor: "W", group_by: "vendor" }, NOW));
    expect(w.rows[0].revenue).toBe(0.3);
    const all = ok(await querySales(A, { group_by: "vendor" }, NOW));
    expect(all.totals.revenue).toBe(20.29);
  });

  it("collection is not a sales filter: no rows and a note pointing at shopify_products", async () => {
    const out = ok(await querySales(A, { collection: "Bar stools" }, NOW));
    expect(out.rows).toEqual([]);
    expect(out.note).toContain(
      "The collection filter is not available for sales; use shopify_products with collection to list that collection's products",
    );
  });

  it("flags deleted variants by variant id, not by a missing variant title", async () => {
    const out = ok(await querySales(A, { sku: "BS-DISC-01" }, NOW));
    expect(out.rows[0]).toMatchObject({
      product: "Discontinued Pine Stool",
      variant: "Pine / 65cm",
      deleted_variant: true,
      units: 0,
      units_other_window: 4,
    });
    expect(out.note).toContain(
      "Rows with deleted_variant true are order lines whose variant no longer exists in Shopify",
    );
  });

  it("a live default variant (no variant title) is not flagged; a deleted one with a title is", async () => {
    const base = mockShopifySales(A)[0];
    await replaceSales(A, [
      // Shopify sends variantTitle null for a product's single default variant.
      { ...base, variant_key: "gid://shopify/ProductVariant/50", variant_gid: "gid://shopify/ProductVariant/50", sku: "LIVE-DEFAULT", variant_title: null },
      // A deleted variant keeps its snapshot title but has no variant id.
      { ...base, variant_key: "product:gid://shopify/Product/1:GONE-1", variant_gid: null, sku: "GONE-1", variant_title: "Oak / 90cm" },
    ]);
    const live = ok(await querySales(A, { sku: "LIVE-DEFAULT" }, NOW));
    expect(live.rows[0]).toMatchObject({ variant: null, deleted_variant: false });
    expect(live.note).not.toContain("deleted_variant true");
    const gone = ok(await querySales(A, { sku: "GONE-1" }, NOW));
    expect(gone.rows[0]).toMatchObject({ variant: "Oak / 90cm", deleted_variant: true });
    expect(gone.note).toContain("deleted_variant true");
  });

  it("deleted_variant on grouped rows is true only when every variant in the group is deleted", async () => {
    const out = ok(await querySales(A, { group_by: "product" }, NOW));
    expect(out.rows.find((r) => r.group === "Discontinued Pine Stool")!.deleted_variant).toBe(true);
    expect(out.rows.find((r) => r.group === "Oak Counter Stool")!.deleted_variant).toBe(false);
  });

  it("output is built from explicit fields: extra stored columns never leak", async () => {
    const s = getDemoStore();
    for (const r of s.shopifySales) Object.assign(r, { synced_run: "run-1", updated_at: "x" });
    const out = ok(await querySales(A, {}, NOW));
    expect(JSON.stringify(out)).not.toMatch(/synced_run|updated_at|client_id|variant_key|gid:\/\//);
  });

  it("unknown group_by, window or sort_by fall back with a note (callers outside zod)", async () => {
    const out = ok(
      await querySales(A, { group_by: "sku" as never, window: 90 as never, sort_by: "price" as never }, NOW),
    );
    expect(out.group_by).toBe("variant");
    expect(out.window).toBe(30);
    expect(out.sort_by).toBe("units");
    expect(out.note).toContain("Unknown group_by 'sku'");
    expect(out.note).toContain("Unknown window '90'");
    expect(out.note).toContain("Unknown sort_by 'price'");
  });
});
