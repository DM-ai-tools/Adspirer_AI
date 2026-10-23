import { beforeEach, describe, expect, it, vi } from "vitest";

// loadSales against a fake that caps every response at 1000 rows, like PostgREST.
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  ranges: [] as Array<[string, number, number]>,
  orders: [] as Array<[string, string]>,
  failAt: null as { table: string; request: number } | null,
  counts: {} as Record<string, number>,
  selects: [] as Array<[string, string]>,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ isDemoMode: false, hasSupabase: true }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let orderBy: string | null = null;
      let from = 0;
      let to = 999;
      db.counts[table] = (db.counts[table] ?? 0) + 1;
      const request = db.counts[table];
      const result = () => {
        if (db.failAt && db.failAt.table === table && db.failAt.request === request) {
          return { data: null, error: { message: "page failed" } };
        }
        let rows = [...(db.tables[table] ?? [])];
        if (orderBy) rows.sort((a, b) => String(a[orderBy!]).localeCompare(String(b[orderBy!])));
        rows = rows.slice(from, Math.min(to, from + 999) + 1);
        return { data: rows, error: null };
      };
      const q: Record<string, unknown> = {
        select: (cols: string) => (db.selects.push([table, cols]), q),
        eq: () => q,
        order: (col: string) => ((orderBy = col), db.orders.push([table, col]), q),
        range: (a: number, b: number) => ((from = a), (to = b), db.ranges.push([table, a, b]), q),
        then: (resolve: (v: ReturnType<typeof result>) => unknown) => resolve(result()),
      };
      return q;
    },
  }),
}));

import { loadSales } from "@/lib/shopify/store";

const CLIENT = "6f1c2b9e-0d4a-4c5e-9b8a-2f3e4d5c6b7a";
const pad = (i: number) => String(i).padStart(5, "0");

beforeEach(() => {
  db.tables = {};
  db.ranges = [];
  db.orders = [];
  db.failAt = null;
  db.counts = {};
  db.selects = [];
});

describe("loadSales paging", () => {
  it("returns all 2,350 rows ordered by variant_key via 3 requests", async () => {
    db.tables.shopify_sales = Array.from({ length: 2350 }, (_, i) => ({
      variant_key: `v${pad(2349 - i)}`,
      client_id: CLIENT,
    }));
    const rows = await loadSales(CLIENT);
    expect(rows.map((r) => r.variant_key)).toEqual(Array.from({ length: 2350 }, (_, i) => `v${pad(i)}`));
    expect(db.ranges.filter(([t]) => t === "shopify_sales")).toEqual([
      ["shopify_sales", 0, 999],
      ["shopify_sales", 1000, 1999],
      ["shopify_sales", 2000, 2999],
    ]);
    expect(db.orders.filter(([t]) => t === "shopify_sales").every(([, c]) => c === "variant_key")).toBe(true);
  });

  it("makes one request when under a page", async () => {
    db.tables.shopify_sales = [{ variant_key: "a" }];
    expect(await loadSales(CLIENT)).toHaveLength(1);
    expect(db.counts.shopify_sales).toBe(1);
  });

  it("propagates a page error instead of returning partial data", async () => {
    db.tables.shopify_sales = Array.from({ length: 2350 }, (_, i) => ({ variant_key: `v${pad(i)}` }));
    db.failAt = { table: "shopify_sales", request: 2 };
    await expect(loadSales(CLIENT)).rejects.toThrow("page failed");
  });
});

describe("loadSales columns", () => {
  const STORED = {
    client_id: CLIENT,
    variant_key: "gid://shopify/ProductVariant/1",
    variant_gid: "gid://shopify/ProductVariant/1",
    product_gid: "gid://shopify/Product/1",
    product_title: "Oak Counter Stool",
    variant_title: "Oak / 65cm",
    sku: "BS-OAK-65",
    vendor: "Nordic Woodworks",
    product_type: "Bar Stool",
    units_30d: 18,
    revenue_30d_cents: 268200,
    units_60d: 31,
    revenue_60d_cents: 461900,
  };

  it("selects explicit columns, never *", async () => {
    db.tables.shopify_sales = [STORED];
    await loadSales(CLIENT);
    const [[table, cols]] = db.selects;
    expect(table).toBe("shopify_sales");
    expect(cols).not.toContain("*");
    expect(cols.split(",").map((c) => c.trim()).sort()).toEqual(Object.keys(STORED).sort());
  });

  it("returns only the sales fields even when the row carries synced_run and updated_at", async () => {
    db.tables.shopify_sales = [{ ...STORED, synced_run: "run-1", updated_at: "2026-10-23T00:00:00Z" }];
    expect(await loadSales(CLIENT)).toEqual([STORED]);
  });
});
