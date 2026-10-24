import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = {
  table: string;
  op: string;
  payload?: unknown;
  options?: unknown;
  filters: Array<[string, string, unknown]>;
};
const db = vi.hoisted(() => ({
  calls: [] as Call[],
  rows: {} as Record<string, unknown>,
  failUpsertOn: null as string | null,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ isDemoMode: false, hasSupabase: true }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const call: Call = { table, op: "select", filters: [] };
      db.calls.push(call);
      const result = () => ({
        data: db.rows[table] ?? null,
        error: call.op === "upsert" && db.failUpsertOn === table ? { message: "boom" } : null,
      });
      const q: Record<string, unknown> = {
        select: () => q,
        update: (p: unknown) => ((call.op = "update"), (call.payload = p), q),
        delete: () => ((call.op = "delete"), q),
        upsert: (p: unknown, o: unknown) => ((call.op = "upsert"), (call.payload = p), (call.options = o), q),
        eq: (c: string, v: unknown) => (call.filters.push(["eq", c, v]), q),
        neq: (c: string, v: unknown) => (call.filters.push(["neq", c, v]), q),
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: ReturnType<typeof result>) => unknown) => resolve(result()),
      };
      return q;
    },
  }),
}));

import { MOCK_SHOP } from "@/lib/shopify/mock";
import { deleteConnection, replaceSales, saveConnection, setSyncStatus } from "@/lib/shopify/store";

const CLIENT = "6f1c2b9e-0d4a-4c5e-9b8a-2f3e4d5c6b7a";

beforeEach(() => {
  db.calls = [];
  db.rows = {};
  db.failUpsertOn = null;
});

describe("shopify store on Supabase", () => {
  it("upserts the connection on client_id", async () => {
    db.rows.shopify_connection = { id: "x", client_id: CLIENT, shop_domain: MOCK_SHOP.domain };
    await saveConnection({
      clientId: CLIENT,
      shopDomain: MOCK_SHOP.domain,
      shopName: "S",
      currency: "USD",
      scopes: ["read_products"],
      accessTokenEncrypted: "v1:cipher",
      connectedBy: null,
    });
    const up = db.calls.find((c) => c.op === "upsert")!;
    expect(up.options).toEqual({ onConflict: "client_id" });
    expect(up.payload).toMatchObject({ client_id: CLIENT, shop_domain: MOCK_SHOP.domain, access_token_encrypted: "v1:cipher" });
    expect(up.payload).not.toHaveProperty("last_sync_status");
    expect(up.payload).not.toHaveProperty("last_sync_at");
    expect(db.calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });

  it("a first connection sends no sync status and deletes nothing", async () => {
    await saveConnection({
      clientId: CLIENT,
      shopDomain: MOCK_SHOP.domain,
      shopName: "S",
      currency: "USD",
      scopes: [],
      accessTokenEncrypted: "v1:cipher",
      connectedBy: null,
    });
    const up = db.calls.find((c) => c.op === "upsert")!;
    expect(up.payload).not.toHaveProperty("last_sync_status");
    expect(db.calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });

  it("connecting a different store resets the sync status, then deletes its sales and leftover catalogue rows", async () => {
    db.rows.shopify_connection = { id: "x", client_id: CLIENT, shop_domain: "old-store.myshopify.com" };
    await saveConnection({
      clientId: CLIENT,
      shopDomain: MOCK_SHOP.domain,
      shopName: "S",
      currency: "USD",
      scopes: [],
      accessTokenEncrypted: "v1:cipher",
      connectedBy: null,
    });
    const up = db.calls.find((c) => c.op === "upsert")!;
    expect(up.payload).toMatchObject({
      shop_domain: MOCK_SHOP.domain,
      last_sync_at: null,
      last_sync_status: "never",
      last_sync_error: null,
      last_sync_counts: null,
    });
    const deletes = db.calls.filter((c) => c.op === "delete");
    expect(deletes.map((d) => d.table).sort()).toEqual([
      "shopify_collections",
      "shopify_products",
      "shopify_sales",
      "shopify_variants",
    ]);
    for (const d of deletes) expect(d.filters).toEqual([["eq", "client_id", CLIENT]]);
    const ops = db.calls.map((c) => c.op);
    expect(ops.indexOf("upsert")).toBeLessThan(ops.indexOf("delete"));
  });

  it("ok status sets last_sync_at", async () => {
    await setSyncStatus(CLIENT, { status: "ok" });
    const up = db.calls.find((c) => c.op === "update")!;
    expect(up.payload).toMatchObject({ last_sync_status: "ok", last_sync_error: null });
    expect((up.payload as Record<string, unknown>).last_sync_at).toBeTruthy();
    expect(up.filters).toEqual([["eq", "client_id", CLIENT]]);
  });

  it("deleteConnection removes synced rows and the connection for the client", async () => {
    await deleteConnection(CLIENT);
    const deletes = db.calls.filter((c) => c.op === "delete");
    expect(deletes.map((d) => d.table).sort()).toEqual([
      "shopify_collections",
      "shopify_connection",
      "shopify_products",
      "shopify_sales",
      "shopify_variants",
    ]);
    for (const d of deletes) expect(d.filters).toEqual([["eq", "client_id", CLIENT]]);
  });
});

const sale = (i: number) => ({
  variant_key: `gid://shopify/ProductVariant/${i}`,
  variant_gid: `gid://shopify/ProductVariant/${i}`,
  product_gid: "gid://shopify/Product/1",
  product_title: "P",
  variant_title: null,
  sku: null,
  vendor: "",
  product_type: "",
  units_30d: 1,
  revenue_30d_cents: 100,
  units_60d: 2,
  revenue_60d_cents: 200,
});

describe("replaceSales on Supabase", () => {
  it("upserts in chunks of 500 tagged with one fresh synced_run, then deletes other runs", async () => {
    await replaceSales(CLIENT, Array.from({ length: 1201 }, (_, i) => sale(i)));
    const upserts = db.calls.filter((c) => c.op === "upsert");
    expect(upserts.every((u) => u.table === "shopify_sales")).toBe(true);
    expect(upserts.map((u) => (u.payload as unknown[]).length)).toEqual([500, 500, 201]);
    expect(upserts.every((u) => (u.options as { onConflict: string }).onConflict === "client_id,variant_key")).toBe(true);
    const payload = upserts.flatMap((u) => u.payload as Array<{ synced_run: string; client_id: string }>);
    expect(payload.every((r) => r.client_id === CLIENT)).toBe(true);
    const runs = new Set(payload.map((r) => r.synced_run));
    expect(runs.size).toBe(1);
    const deletes = db.calls.filter((c) => c.op === "delete");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].table).toBe("shopify_sales");
    expect(deletes[0].filters).toEqual([["eq", "client_id", CLIENT], ["neq", "synced_run", [...runs][0]]]);
    const ops = db.calls.map((c) => c.op);
    expect(ops.lastIndexOf("upsert")).toBeLessThan(ops.indexOf("delete"));
  });

  it("does not mutate the caller's rows", async () => {
    const rows = [sale(1)];
    await replaceSales(CLIENT, rows);
    expect(rows[0]).not.toHaveProperty("synced_run");
    expect(rows[0]).not.toHaveProperty("client_id");
  });

  it("an empty set upserts nothing and deletes every older row", async () => {
    await replaceSales(CLIENT, []);
    expect(db.calls.filter((c) => c.op === "upsert")).toHaveLength(0);
    expect(db.calls.filter((c) => c.op === "delete")).toHaveLength(1);
  });

  it("deletes nothing when an upsert fails, and propagates the error", async () => {
    db.failUpsertOn = "shopify_sales";
    await expect(replaceSales(CLIENT, [sale(1), sale(2)])).rejects.toThrow("boom");
    expect(db.calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });

  it("deletes nothing when onChunk throws after a written chunk", async () => {
    await expect(
      replaceSales(CLIENT, Array.from({ length: 700 }, (_, i) => sale(i)), async () => {
        throw new Error("heartbeat failed");
      }),
    ).rejects.toThrow("heartbeat failed");
    expect(db.calls.filter((c) => c.op === "upsert")).toHaveLength(1);
    expect(db.calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });

  it("calls onChunk once per chunk, after each upsert", async () => {
    const seen: number[] = [];
    await replaceSales(CLIENT, Array.from({ length: 1001 }, (_, i) => sale(i)), async () => {
      seen.push(db.calls.filter((c) => c.op === "upsert").length);
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});
