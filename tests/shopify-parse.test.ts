import { describe, it, expect } from "vitest";
import { ORDERS_BULK_QUERY, createSalesAggregator } from "@/lib/shopify/parse";

type Line = Record<string, unknown>;
/** Pushes every line through the streaming aggregator and returns its summary. */
function aggregateSales(lines: Line[], now: Date) {
  const a = createSalesAggregator(now);
  for (const l of lines) a.push(l);
  return a.finish();
}
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
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      variant_key: V1, units_30d: 2, revenue_30d_cents: 2000, units_60d: 3, revenue_60d_cents: 2950,
    });
    expect(r.orders).toBe(2);
    expect(r).not.toHaveProperty("byVariant");
  });

  it("excludes cancelled, test and older-than-60d orders", () => {
    const lines = [
      order("1", 5, { cancelledAt: daysAgo(4) }), item("1", "1", 1, "5.00"),
      order("2", 5, { test: true }), item("2", "1", 1, "5.00"),
      order("3", 70), item("3", "1", 1, "5.00"),
    ];
    const r = aggregateSales(lines, now);
    expect(r.rows).toHaveLength(0);
    expect(r.orders).toBe(0);
  });

  it("skips and counts line items without a variant", () => {
    const lines = [order("1", 5), item("1", null, 1, "5.00"), item("1", "1", 1, "7.00")];
    const r = aggregateSales(lines, now);
    expect(r.skippedLineItems).toBe(1);
    expect(r.rows.find((x) => x.variant_key === V1)?.units_30d).toBe(1);
  });

  it("rows: metadata comes through, same variant adds up per window", () => {
    const P = "gid://shopify/Product/9";
    const meta = { title: "Tee", variantTitle: "Red / M", sku: "TEE-R", vendor: "Acme", product: { id: P, productType: "Shirt" } };
    const lines = [
      order("1", 5), { ...item("1", "1", 1, "7.00"), ...meta },
      order("2", 30), { ...item("2", "1", 2, "14.00"), ...meta },
      order("3", 31), { ...item("3", "1", 1, "5.00"), ...meta },
    ];
    const r = aggregateSales(lines, now);
    expect(r.rows).toEqual([{
      variant_key: V1, variant_gid: V1, product_gid: P, product_title: "Tee", variant_title: "Red / M",
      sku: "TEE-R", vendor: "Acme", product_type: "Shirt",
      units_30d: 3, revenue_30d_cents: 2100, units_60d: 4, revenue_60d_cents: 2600,
    }]);
  });

  describe("synthetic keys (no variant, product id present)", () => {
    const P9 = "gid://shopify/Product/9";
    const P10 = "gid://shopify/Product/10";
    const gone = (o: string, qty: number, over: Line = {}): Line => ({
      ...item(o, null, qty, "10.00"),
      title: "Gone", product: { id: P9, productType: "" }, sku: null, variantTitle: null, vendor: null, ...over,
    });

    it("uses the SKU when there is one", () => {
      const r = aggregateSales([order("1", 5), gone("1", 2, { sku: "S1" })], now);
      expect(r.skippedLineItems).toBe(0);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({
        variant_key: `product:${P9}:S1`, variant_gid: null, product_gid: P9, vendor: "", product_type: "",
        variant_title: null, units_30d: 2,
      });
    });

    it("without a SKU uses '<product title> / <variantTitle>', else the product title", () => {
      const r = aggregateSales(
        [order("1", 5), gone("1", 1, { variantTitle: "Red / M" }), gone("1", 1)],
        now,
      );
      expect(r.rows.map((x) => x.variant_key).sort()).toEqual([`product:${P9}:Gone / Red / M`, `product:${P9}:Gone`].sort());
    });

    it("the same SKU or title on two different products stays distinct", () => {
      const r = aggregateSales(
        [
          order("1", 5),
          gone("1", 1, { sku: "DUP" }),
          gone("1", 1, { sku: "DUP", product: { id: P10 } }),
          gone("1", 1),
          gone("1", 1, { product: { id: P10 } }),
        ],
        now,
      );
      expect(r.rows).toHaveLength(4);
      expect(new Set(r.rows.map((x) => x.variant_key)).size).toBe(4);
    });

    it("merged lines that disagree on variant_title store null; agreeing ones keep it", () => {
      const disagree = aggregateSales(
        [order("1", 5), gone("1", 1, { sku: "S" , variantTitle: "A" }), gone("1", 1, { sku: "S", variantTitle: "B" })],
        now,
      );
      expect(disagree.rows).toHaveLength(1);
      expect(disagree.rows[0].variant_title).toBeNull();
      const agree = aggregateSales(
        [order("1", 5), gone("1", 1, { sku: "S", variantTitle: "A" }), gone("1", 1, { sku: "S", variantTitle: "A" })],
        now,
      );
      expect(agree.rows[0].variant_title).toBe("A");
      const mixed = aggregateSales(
        [order("1", 5), gone("1", 1, { sku: "S" }), gone("1", 1, { sku: "S", variantTitle: "A" })],
        now,
      );
      expect(mixed.rows[0].variant_title).toBeNull();
    });

    it("a line with a product id but no sku and no title is skipped and counted", () => {
      const r = aggregateSales([order("1", 5), gone("1", 1, { title: "" })], now);
      expect(r.rows).toEqual([]);
      expect(r.skippedLineItems).toBe(1);
    });
  });

  it("rows: a line with no variant and no product id is skipped even with a SKU and title", () => {
    const r = aggregateSales([order("1", 5), { ...item("1", null, 1, "5.00"), title: "T", sku: "S" }], now);
    expect(r.rows).toEqual([]);
    expect(r.skippedLineItems).toBe(1);
  });

  it("rows: a line with neither variant nor product is skipped and counted", () => {
    const r = aggregateSales([order("1", 5), item("1", null, 1, "5.00")], now);
    expect(r.rows).toEqual([]);
    expect(r.skippedLineItems).toBe(1);
  });

  it("rows: cancelled and test orders add nothing, 30-day boundary is inclusive", () => {
    const lines = [
      order("1", 5, { cancelledAt: daysAgo(4) }), item("1", "1", 1, "5.00"),
      order("2", 5, { test: true }), item("2", "1", 1, "5.00"),
      order("3", 30), item("3", "1", 1, "4.00"),
    ];
    const r = aggregateSales(lines, now);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ units_30d: 1, revenue_30d_cents: 400, units_60d: 1 });
  });

  it("rows: the 60-day boundary is inclusive and older orders are excluded", () => {
    const lines = [
      order("1", 60), item("1", "1", 1, "3.00"),
      order("2", 60.01), item("2", "1", 5, "50.00"),
      order("3", 61), item("3", "2", 1, "9.00"),
    ];
    const r = aggregateSales(lines, now);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ variant_key: V1, units_30d: 0, revenue_30d_cents: 0, units_60d: 1, revenue_60d_cents: 300 });
    expect(r.orders).toBe(1);
  });

  it("counts a line item that arrives before its order as an orphan, not as skipped", () => {
    const lines = [item("1", "1", 1, "5.00"), order("1", 5), item("1", "1", 2, "14.00")];
    const r = aggregateSales(lines, now);
    expect(r.orphanLineItems).toBe(1);
    expect(r.skippedLineItems).toBe(0);
    expect(r.orders).toBe(1);
    // Only the line after its order counts.
    expect(r.rows[0]).toMatchObject({ variant_key: V1, units_30d: 2, revenue_30d_cents: 1400 });
  });

  it("lines of seen-but-excluded orders are not orphans", () => {
    const lines = [
      order("1", 5, { cancelledAt: daysAgo(4) }), item("1", "1", 1, "5.00"),
      order("2", 5, { test: true }), item("2", "1", 1, "5.00"),
      order("3", 70), item("3", "1", 1, "5.00"),
      order("4", 5, { createdAt: "not a date" }), item("4", "1", 1, "5.00"),
      item("9", "1", 1, "5.00"),
      { ...item("8", "1", 1, "5.00"), __parentId: null },
    ];
    const r = aggregateSales(lines, now);
    expect(r).toEqual({ rows: [], orders: 0, skippedLineItems: 0, orphanLineItems: 2 });
  });

  it("counts() reports running counts without building the rows", () => {
    const a = createSalesAggregator(now);
    a.push(item("1", "1", 1, "5.00"));
    a.push(order("1", 5));
    a.push(item("1", null, 1, "5.00"));
    expect(a.counts()).toEqual({ orders: 1, skippedLineItems: 1, orphanLineItems: 1 });
  });

  it("adds up two line items for the same variant", () => {
    const lines = [order("1", 5), item("1", "1", 1, "7.00"), item("1", "1", 2, "14.00")];
    expect(aggregateSales(lines, now).rows.find((x) => x.variant_key === V1)).toMatchObject({
      units_30d: 3, revenue_30d_cents: 2100,
    });
  });
});

/** Top-level field names of a `{ ... }` document (depth 1, arguments skipped). */
function topLevelFields(doc: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let paren = 0;
  for (const m of doc.matchAll(/[A-Za-z_][A-Za-z0-9_]*|[{}()]/g)) {
    const t = m[0];
    if (t === "(") paren += 1;
    else if (t === ")") paren -= 1;
    else if (paren > 0) continue;
    else if (t === "{") depth += 1;
    else if (t === "}") depth -= 1;
    else if (depth === 1) out.push(t);
  }
  return out;
}

/** Depth of each connection (`edges`) in the selection: 0 = top level. */
function connectionDepths(doc: string): number[] {
  const depths: number[] = [];
  let edgesOpen = 0;
  const stack: boolean[] = [];
  let lastWasEdges = false;
  for (const m of doc.matchAll(/[A-Za-z_][A-Za-z0-9_]*|[{}()]/g)) {
    const t = m[0];
    if (t === "edges") {
      depths.push(edgesOpen);
      lastWasEdges = true;
      continue;
    }
    if (t === "{") {
      stack.push(lastWasEdges);
      if (lastWasEdges) edgesOpen += 1;
    } else if (t === "}") {
      if (stack.pop()) edgesOpen -= 1;
    }
    lastWasEdges = false;
  }
  return depths;
}

describe("bulk queries", () => {
  it("orders query has a single top-level field and stays inside the bulk limits", () => {
    const q = ORDERS_BULK_QUERY("2026-08-24T00:00:00Z");
    expect(topLevelFields(q)).toEqual(["orders"]);
    const depths = connectionDepths(q);
    expect(depths).toHaveLength(2);
    expect(Math.max(...depths)).toBeLessThanOrEqual(1);
  });

  const forbidden = ["customer", "email", "phone", "shippingAddress", "billingAddress"];
  it("orders query selects line metadata as plain objects, no extra connections", () => {
    const q = ORDERS_BULK_QUERY("2026-08-24T00:00:00Z");
    for (const f of ["title", "variantTitle", "sku", "vendor", "variant { id }", "product { id productType }"]) {
      expect(q).toContain(f);
    }
  });
  it("never select personal data", () => {
    for (const q of [ORDERS_BULK_QUERY("2026-08-24T00:00:00Z")]) {
      for (const word of forbidden) expect(q.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
  it("orders query filters by sinceIso and selects the needed fields", () => {
    const q = ORDERS_BULK_QUERY("2026-08-24T00:00:00Z");
    expect(q).toContain(`created_at:>='2026-08-24T00:00:00Z'`);
    expect(q).toContain("discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount } }");
    for (const f of ["createdAt", "cancelledAt", "test", "quantity", "discountedTotalSet", "shopMoney"]) {
      expect(q).toContain(f);
    }
  });
  it("sends the date without milliseconds (Shopify's documented YYYY-MM-DDTHH:MM:SSZ)", () => {
    const q = ORDERS_BULK_QUERY("2026-08-24T12:00:00.123Z");
    expect(q).toContain(`created_at:>='2026-08-24T12:00:00Z'`);
    expect(q).not.toContain(".123");
    expect(ORDERS_BULK_QUERY(new Date("2026-08-24T12:00:00Z").toISOString())).toContain(`created_at:>='2026-08-24T12:00:00Z'`);
  });
  it("rejects a malformed sinceIso", () => {
    expect(() => ORDERS_BULK_QUERY('x" } ) { id')).toThrow();
    expect(() => ORDERS_BULK_QUERY("2026-08-24")).toThrow();
    expect(() => ORDERS_BULK_QUERY("2026-08-24T12:00:00+01:00")).toThrow();
  });
});
