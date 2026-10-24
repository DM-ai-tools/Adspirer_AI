import { describe, expect, it } from "vitest";
import { createSalesAggregator } from "@/lib/shopify/parse";

type Line = Record<string, unknown>;
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

describe("createSalesAggregator", () => {
  const run = (lines: Line[]) => {
    const a = createSalesAggregator(now);
    for (const l of lines) a.push(l);
    return a.finish();
  };
  const V1 = "gid://shopify/ProductVariant/1";

  it("windows: 30d and 60d per variant", () => {
    const r = run(salesFixtures.windows);
    expect(r).toMatchObject({ orders: 2, skippedLineItems: 0, orphanLineItems: 0 });
    expect(r.rows).toEqual([expect.objectContaining({ variant_key: V1, units_30d: 2, revenue_30d_cents: 2000, units_60d: 3, revenue_60d_cents: 2950 })]);
  });

  it("excluded: cancelled, test, old and undated orders add nothing and their lines are not orphans", () => {
    expect(run(salesFixtures.excluded)).toEqual({ rows: [], orders: 0, skippedLineItems: 0, orphanLineItems: 0 });
  });

  it("skipped: a line with no variant or product is skipped; negative quantity counts 0 units and bad money 0 cents", () => {
    const r = run(salesFixtures.skipped);
    expect(r).toMatchObject({ orders: 1, skippedLineItems: 1, orphanLineItems: 0 });
    expect(r.rows.map((x) => [x.variant_key, x.units_30d, x.revenue_30d_cents])).toEqual([
      [V1, 1, 700],
      ["gid://shopify/ProductVariant/2", 0, 0],
    ]);
  });

  it("orphan: a line before any order is counted as an orphan and left out", () => {
    const r = run(salesFixtures.orphan);
    expect(r).toMatchObject({ orders: 1, skippedLineItems: 0, orphanLineItems: 1 });
    expect(r.rows).toEqual([expect.objectContaining({ variant_key: V1, units_30d: 3, revenue_30d_cents: 2100 })]);
  });

  it("keeps the current semantics", () => {
    const x = createSalesAggregator(now);
    for (const l of salesFixtures.excluded) x.push(l);
    expect(x.finish()).toEqual({ rows: [], orders: 0, skippedLineItems: 0, orphanLineItems: 0 });
    const a = createSalesAggregator(now);
    for (const l of salesFixtures.windows) a.push(l);
    const r = a.finish();
    expect(r.orders).toBe(2);
    expect(r.rows.find((x) => x.variant_key === "gid://shopify/ProductVariant/1")).toMatchObject({
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
    expect(r.rows).toHaveLength(100);
    let units = 0;
    for (const s of r.rows) units += s.units_60d;
    expect(units).toBe(ORDERS * 3);
  });
});
