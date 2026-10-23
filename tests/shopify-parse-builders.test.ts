import { describe, expect, it } from "vitest";
import {
  aggregateSales,
  createCatalogBuilder,
  createSalesAggregator,
  parseCatalog,
} from "@/lib/shopify/parse";

type Line = Record<string, unknown>;
const P = "gid://shopify/Product/1";
const P2 = "gid://shopify/Product/2";
const now = new Date("2026-10-23T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

const variant = (id: string, over: Line = {}): Line => ({
  id: `gid://shopify/ProductVariant/${id}`,
  __parentId: P,
  title: `V${id}`,
  sku: `SKU${id}`,
  price: "1299.00",
  inventoryPolicy: "DENY",
  inventoryQuantity: 5,
  inventoryItem: { unitCost: { amount: "400.00" }, tracked: true },
  ...over,
});

const catalogFixtures: Record<string, Line[]> = {
  base: [
    { id: P, title: "Prod", handle: "prod", vendor: "V", productType: "T", status: "ACTIVE" },
    { id: "gid://shopify/Collection/10", handle: "a", title: "A", __parentId: P },
    { id: "gid://shopify/Collection/11", handle: "b", title: "B", __parentId: P },
    variant("1"),
    variant("2", { inventoryItem: { unitCost: null, tracked: false } }),
    variant("3", { inventoryPolicy: "CONTINUE" }),
    variant("4", { inventoryQuantity: -3, sku: "" }),
    { id: P2, title: "Prod 2", handle: "prod-2", vendor: "V", productType: "T", status: "SOMETHING_NEW" },
    { id: "gid://shopify/Collection/10", handle: "a", title: "A", __parentId: P2 },
    { id: "gid://shopify/Collection/10", handle: "a", title: "A", __parentId: P2 },
    variant("5", { __parentId: P2 }),
    // Children of an unknown product are ignored.
    { id: "gid://shopify/Collection/99", handle: "z", title: "Z", __parentId: "gid://shopify/Product/404" },
    variant("9", { __parentId: "gid://shopify/Product/404" }),
  ],
  empty: [],
};

const order = (id: string, d: number, over: Line = {}): Line => ({
  id: `gid://shopify/Order/${id}`,
  createdAt: daysAgo(d),
  cancelledAt: null,
  test: false,
  ...over,
});
const item = (orderId: string, variantId: string | null, qty: number, amount: string): Line => ({
  id: `gid://shopify/LineItem/${orderId}-${variantId}-${qty}`,
  __parentId: `gid://shopify/Order/${orderId}`,
  quantity: qty,
  variant: variantId ? { id: `gid://shopify/ProductVariant/${variantId}` } : null,
  discountedTotalSet: { shopMoney: { amount } },
});

const salesFixtures: Record<string, Line[]> = {
  windows: [order("1", 10), item("1", "1", 2, "20.00"), order("2", 45), item("2", "1", 1, "9.50")],
  excluded: [
    order("1", 5, { cancelledAt: daysAgo(4) }), item("1", "1", 1, "5.00"),
    order("2", 5, { test: true }), item("2", "1", 1, "5.00"),
    order("3", 70), item("3", "1", 1, "5.00"),
    order("4", 5, { createdAt: "not a date" }), item("4", "1", 1, "5.00"),
  ],
  skipped: [order("1", 5), item("1", null, 1, "5.00"), item("1", "1", 1, "7.00"), item("1", "2", -2, "bad")],
  orphan: [item("9", "1", 1, "5.00"), order("1", 5), item("1", "1", 2, "14.00"), item("1", "1", 1, "7.00")],
};

describe("createCatalogBuilder", () => {
  it.each(Object.keys(catalogFixtures))("pushing %s line by line equals parseCatalog", (name) => {
    const lines = catalogFixtures[name];
    const b = createCatalogBuilder("c1");
    for (const l of lines) b.push(l);
    expect(b.finish()).toEqual(parseCatalog("c1", lines));
  });

  it("keeps the current semantics", () => {
    const b = createCatalogBuilder("c1");
    for (const l of catalogFixtures.base) b.push(l);
    const r = b.finish();
    expect(r.products.map((p) => [p.gid, p.status, p.collection_gids])).toEqual([
      [P, "ACTIVE", ["gid://shopify/Collection/10", "gid://shopify/Collection/11"]],
      [P2, "UNKNOWN", ["gid://shopify/Collection/10"]],
    ]);
    expect(r.collections.map((c) => [c.gid, c.products_count])).toEqual([
      ["gid://shopify/Collection/10", 2],
      ["gid://shopify/Collection/11", 1],
    ]);
    expect(r.variants.map((v) => [v.gid.split("/").pop(), v.cost_cents, v.inventory_quantity, v.sku])).toEqual([
      ["1", 40000, 5, "SKU1"],
      ["2", null, null, "SKU2"],
      ["3", 40000, null, "SKU3"],
      ["4", 40000, 0, null],
      ["5", 40000, 5, "SKU5"],
    ]);
  });

  it("processes a large lazily generated stream without an array of lines", () => {
    const PRODUCTS = 75_000;
    const VARIANTS_PER = 3;
    function* lines(): Generator<Line> {
      for (let p = 0; p < PRODUCTS; p += 1) {
        const pid = `gid://shopify/Product/${p}`;
        yield { id: pid, title: `P${p}`, handle: `p-${p}`, vendor: "V", productType: "T", status: "ACTIVE" };
        for (let v = 0; v < VARIANTS_PER; v += 1) {
          yield {
            id: `gid://shopify/ProductVariant/${p}-${v}`,
            __parentId: pid,
            title: `V${v}`,
            sku: null,
            price: "12.34",
            inventoryPolicy: "DENY",
            inventoryQuantity: v,
            inventoryItem: { tracked: true, unitCost: { amount: "1.00" } },
          };
        }
      }
    }
    const started = Date.now();
    const b = createCatalogBuilder("c1");
    let pushed = 0;
    for (const l of lines()) {
      b.push(l);
      pushed += 1;
    }
    const r = b.finish();
    expect(pushed).toBe(PRODUCTS * (1 + VARIANTS_PER));
    expect(r.products).toHaveLength(PRODUCTS);
    expect(r.variants).toHaveLength(PRODUCTS * VARIANTS_PER);
    expect(r.variants[r.variants.length - 1]).toMatchObject({ price_cents: 1234, cost_cents: 100, inventory_quantity: 2 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("createSalesAggregator", () => {
  it.each(Object.keys(salesFixtures))("pushing %s line by line equals aggregateSales", (name) => {
    const lines = salesFixtures[name];
    const a = createSalesAggregator(now);
    for (const l of lines) a.push(l);
    expect(a.finish()).toEqual(aggregateSales(lines, now));
  });

  it("keeps the current semantics", () => {
    const x = createSalesAggregator(now);
    for (const l of salesFixtures.excluded) x.push(l);
    expect(x.finish()).toEqual({ byVariant: new Map(), rows: [], orders: 0, skippedLineItems: 0 });
    const a = createSalesAggregator(now);
    for (const l of salesFixtures.windows) a.push(l);
    const r = a.finish();
    expect(r.orders).toBe(2);
    expect(r.byVariant.get("gid://shopify/ProductVariant/1")).toEqual({
      units_30d: 2, revenue_30d_cents: 2000, units_60d: 3, revenue_60d_cents: 2950,
    });
    const s = createSalesAggregator(now);
    for (const l of salesFixtures.skipped) s.push(l);
    expect(s.finish()).toMatchObject({ orders: 1, skippedLineItems: 1 });
  });

  it("aggregates a large lazily generated stream", () => {
    const ORDERS = 60_000;
    const a = createSalesAggregator(now);
    for (let o = 0; o < ORDERS; o += 1) {
      a.push(order(String(o), o % 59));
      a.push(item(String(o), String(o % 100), 1, "1.00"));
      a.push(item(String(o), String(o % 100), 2, "2.50"));
      a.push(item(String(o), null, 1, "1.00"));
    }
    const r = a.finish();
    expect(r.orders).toBe(ORDERS);
    expect(r.skippedLineItems).toBe(ORDERS);
    expect(r.byVariant.size).toBe(100);
    let units = 0;
    for (const s of r.byVariant.values()) units += s.units_60d;
    expect(units).toBe(ORDERS * 3);
  });
});
