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

import { MOCK_SHOP, mockShopifyCatalog } from "@/lib/shopify/mock";
import { deleteConnection, replaceCatalog, saveConnection, setSyncStatus } from "@/lib/shopify/store";

const CLIENT = "6f1c2b9e-0d4a-4c5e-9b8a-2f3e4d5c6b7a";

beforeEach(() => {
  db.calls = [];
  db.rows = {};
  db.failUpsertOn = null;
});

describe("shopify store on Supabase", () => {
  it("upserts the connection on client_id", async () => {
    db.rows.shopify_connection = { id: "x", client_id: CLIENT };
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
  });

  it("ok status sets last_sync_at", async () => {
    await setSyncStatus(CLIENT, { status: "ok" });
    const up = db.calls.find((c) => c.op === "update")!;
    expect(up.payload).toMatchObject({ last_sync_status: "ok", last_sync_error: null });
    expect((up.payload as Record<string, unknown>).last_sync_at).toBeTruthy();
    expect(up.filters).toEqual([["eq", "client_id", CLIENT]]);
  });

  it("upserts tagged with one fresh synced_run, then deletes other runs", async () => {
    const cat = mockShopifyCatalog(CLIENT);
    await replaceCatalog(CLIENT, cat);
    const upserts = db.calls.filter((c) => c.op === "upsert");
    expect(upserts.map((u) => u.table).sort()).toEqual(["shopify_collections", "shopify_products", "shopify_variants"]);
    const runs = new Set(upserts.flatMap((u) => (u.payload as Array<{ synced_run: string }>).map((r) => r.synced_run)));
    expect(runs.size).toBe(1);
    const [run] = [...runs];
    expect(upserts.every((u) => (u.options as { onConflict: string }).onConflict === "client_id,gid")).toBe(true);
    const deletes = db.calls.filter((c) => c.op === "delete");
    expect(deletes).toHaveLength(3);
    for (const d of deletes) expect(d.filters).toEqual([["eq", "client_id", CLIENT], ["neq", "synced_run", run]]);
    const ops = db.calls.map((c) => c.op);
    expect(ops.lastIndexOf("upsert")).toBeLessThan(ops.indexOf("delete"));
  });

  it("chunks upserts at 500 rows", async () => {
    const cat = mockShopifyCatalog(CLIENT);
    const base = cat.variants[0];
    const variants = Array.from({ length: 1201 }, (_, i) => ({ ...base, gid: `gid://shopify/ProductVariant/${i}` }));
    await replaceCatalog(CLIENT, { ...cat, variants });
    const sizes = db.calls
      .filter((c) => c.op === "upsert" && c.table === "shopify_variants")
      .map((c) => (c.payload as unknown[]).length);
    expect(sizes).toEqual([500, 500, 201]);
  });

  it("deletes nothing when an upsert fails, and propagates the error", async () => {
    db.failUpsertOn = "shopify_variants";
    await expect(replaceCatalog(CLIENT, mockShopifyCatalog(CLIENT))).rejects.toThrow("boom");
    expect(db.calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });

  it("deleteConnection removes synced rows and the connection for the client", async () => {
    await deleteConnection(CLIENT);
    const deletes = db.calls.filter((c) => c.op === "delete");
    expect(deletes.map((d) => d.table).sort()).toEqual([
      "shopify_collections",
      "shopify_connection",
      "shopify_products",
      "shopify_variants",
    ]);
    for (const d of deletes) expect(d.filters).toEqual([["eq", "client_id", CLIENT]]);
  });
});
