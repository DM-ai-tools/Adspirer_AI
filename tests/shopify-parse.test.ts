import { describe, it, expect } from "vitest";
import {
  CATALOG_BULK_QUERY,
  ORDERS_BULK_QUERY,
  parseCatalog,
  aggregateSales,
} from "@/lib/shopify/parse";

type Line = Record<string, unknown>;
const P = "gid://shopify/Product/1";

function variant(id: string, over: Line = {}): Line {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    __parentId: P,
    title: `V${id}`,
    sku: `SKU${id}`,
    price: "1299.00",
    inventoryPolicy: "DENY",
    inventoryQuantity: 5,
    inventoryItem: { unitCost: { amount: "400.00" }, tracked: true },
    ...over,
  };
}

const baseCatalog = (): Line[] => [
  { id: "gid://shopify/Collection/10", handle: "a", title: "A", productsCount: { count: 3 } },
  {
    id: P,
    title: "Prod",
    handle: "prod",
    vendor: "V",
    productType: "T",
    status: "ACTIVE",
  },
  { id: "gid://shopify/Collection/10", __parentId: P },
  { id: "gid://shopify/Collection/11", __parentId: P },
  variant("1"),
  variant("2"),
];

describe("parseCatalog", () => {
  it("assembles products, collections and variants", () => {
    const r = parseCatalog("c1", baseCatalog());
    expect(r.collections).toEqual([
      { client_id: "c1", gid: "gid://shopify/Collection/10", handle: "a", title: "A", products_count: 3 },
    ]);
    expect(r.products).toHaveLength(1);
    expect(r.products[0].collection_gids).toEqual([
      "gid://shopify/Collection/10",
      "gid://shopify/Collection/11",
    ]);
    expect(r.variants).toHaveLength(2);
    expect(r.variants[0].product_gid).toBe(P);
    expect(r.variants[0].price_cents).toBe(129900);
    expect(r.variants[0].cost_cents).toBe(40000);
    expect(r.variants[0].inventory_quantity).toBe(5);
  });

  it("null unit cost gives null cost_cents, not 0", () => {
    const lines = [...baseCatalog().slice(0, 4), variant("1", { inventoryItem: { unitCost: null, tracked: true } })];
    expect(parseCatalog("c1", lines).variants[0].cost_cents).toBeNull();
  });

  it("untracked inventory gives null quantity", () => {
    const lines = [...baseCatalog().slice(0, 4), variant("1", { inventoryItem: { unitCost: null, tracked: false } })];
    expect(parseCatalog("c1", lines).variants[0].inventory_quantity).toBeNull();
  });

  it("policy CONTINUE gives null quantity", () => {
    const lines = [...baseCatalog().slice(0, 4), variant("1", { inventoryPolicy: "CONTINUE" })];
    expect(parseCatalog("c1", lines).variants[0].inventory_quantity).toBeNull();
  });

  it("negative quantity becomes 0", () => {
    const lines = [...baseCatalog().slice(0, 4), variant("1", { inventoryQuantity: -3 })];
    expect(parseCatalog("c1", lines).variants[0].inventory_quantity).toBe(0);
  });

  it("ignores variants whose parent is unknown without throwing", () => {
    const lines = [...baseCatalog(), variant("9", { __parentId: "gid://shopify/Product/404" })];
    expect(() => parseCatalog("c1", lines)).not.toThrow();
  });
});

describe("aggregateSales", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();
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
  const V1 = "gid://shopify/ProductVariant/1";

  it("splits 30d and 60d windows", () => {
    const lines = [
      order("1", 10), item("1", "1", 2, "20.00"),
      order("2", 45), item("2", "1", 1, "9.50"),
    ];
    const r = aggregateSales(lines, now);
    expect(r.byVariant.get(V1)).toEqual({
      units_30d: 2, revenue_30d_cents: 2000, units_60d: 3, revenue_60d_cents: 2950,
    });
    expect(r.orders).toBe(2);
  });

  it("excludes cancelled, test and older-than-60d orders", () => {
    const lines = [
      order("1", 5, { cancelledAt: daysAgo(4) }), item("1", "1", 1, "5.00"),
      order("2", 5, { test: true }), item("2", "1", 1, "5.00"),
      order("3", 70), item("3", "1", 1, "5.00"),
    ];
    const r = aggregateSales(lines, now);
    expect(r.byVariant.size).toBe(0);
    expect(r.orders).toBe(0);
  });

  it("skips and counts line items without a variant", () => {
    const lines = [order("1", 5), item("1", null, 1, "5.00"), item("1", "1", 1, "7.00")];
    const r = aggregateSales(lines, now);
    expect(r.skippedLineItems).toBe(1);
    expect(r.byVariant.get(V1)?.units_30d).toBe(1);
  });

  it("adds up two line items for the same variant", () => {
    const lines = [order("1", 5), item("1", "1", 1, "7.00"), item("1", "1", 2, "14.00")];
    expect(aggregateSales(lines, now).byVariant.get(V1)).toMatchObject({
      units_30d: 3, revenue_30d_cents: 2100,
    });
  });
});

describe("bulk queries", () => {
  const forbidden = ["customer", "email", "phone", "shippingAddress", "billingAddress"];
  it("never select personal data", () => {
    for (const q of [CATALOG_BULK_QUERY, ORDERS_BULK_QUERY("2026-08-24T00:00:00Z")]) {
      for (const word of forbidden) expect(q.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
  it("orders query filters by sinceIso and selects the needed fields", () => {
    const q = ORDERS_BULK_QUERY("2026-08-24T00:00:00Z");
    expect(q).toContain("created_at:>=2026-08-24T00:00:00Z");
    for (const f of ["createdAt", "cancelledAt", "test", "quantity", "discountedTotalSet", "shopMoney"]) {
      expect(q).toContain(f);
    }
  });
  it("rejects a malformed sinceIso", () => {
    expect(() => ORDERS_BULK_QUERY('x" } ) { id')).toThrow();
  });
});
