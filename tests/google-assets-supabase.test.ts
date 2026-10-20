import { beforeEach, describe, expect, it, vi } from "vitest";

// The Supabase paths of the Google asset store, against a fake client that
// records each call. The one-per-client unique index means the old mapping
// must be cleared before the new one is written.
const db = vi.hoisted(() => ({
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, string, unknown]>; options?: unknown }>,
  rows: {} as Record<string, Record<string, unknown> | null>,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ isDemoMode: false, hasSupabase: true }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const call = { table, op: "select", filters: [] as Array<[string, string, unknown]> } as (typeof db.calls)[number];
      db.calls.push(call);
      const result = () => ({ data: db.rows[table] ?? null, error: null });
      const q: Record<string, unknown> = {
        select: () => q,
        update: (payload: unknown) => ((call.op = "update"), (call.payload = payload), q),
        upsert: (payload: unknown, options: unknown) => ((call.op = "upsert"), (call.payload = payload), (call.options = options), q),
        eq: (col: string, v: unknown) => (call.filters.push(["eq", col, v]), q),
        neq: (col: string, v: unknown) => (call.filters.push(["neq", col, v]), q),
        maybeSingle: async () => result(),
        single: async () => result(),
        then: (resolve: (v: ReturnType<typeof result>) => unknown) => resolve(result()),
      };
      return q;
    },
  }),
}));

vi.mock("@/lib/google/ga4", () => ({
  listGa4Properties: async () => [{ propertyId: "123", name: "Shop", accountName: "Acct", currency: "AUD", timezone: "Australia/Sydney" }],
}));
vi.mock("@/lib/google/ads", () => ({ discoverAdsAccounts: async () => [] }));
vi.mock("@/lib/google/gsc", () => ({ listGscSites: async () => [] }));

import { mapGoogleAsset, syncGoogleAssets } from "@/lib/google/assets";
import { NotFoundError } from "@/lib/errors";

const ASSET = "0b7c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f";
const CLIENT = "6f1c2b9e-0d4a-4c5e-9b8a-2f3e4d5c6b7a";

beforeEach(() => {
  db.calls = [];
  db.rows = {
    connected_google_assets: { id: ASSET, kind: "ga4_property", external_id: "properties/123", mapped_client_id: null },
    clients: { id: CLIENT },
  };
});

describe("Google assets on Supabase", () => {
  it("clears the client's current asset of that kind before mapping the new one", async () => {
    await mapGoogleAsset(ASSET, CLIENT);
    const updates = db.calls.filter((c) => c.op === "update");
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({
      payload: { mapped_client_id: null },
      filters: [
        ["eq", "kind", "ga4_property"],
        ["eq", "mapped_client_id", CLIENT],
        ["neq", "id", ASSET],
      ],
    });
    expect(updates[1]).toMatchObject({ payload: { mapped_client_id: CLIENT }, filters: [["eq", "id", ASSET]] });
  });

  it("unmaps without touching other assets", async () => {
    await mapGoogleAsset(ASSET, null);
    const updates = db.calls.filter((c) => c.op === "update");
    expect(updates).toEqual([expect.objectContaining({ payload: { mapped_client_id: null }, filters: [["eq", "id", ASSET]] })]);
  });

  it("treats a non-uuid id as not found without querying", async () => {
    await expect(mapGoogleAsset("gasset_ct_ga4", CLIENT)).rejects.toBeInstanceOf(NotFoundError);
    await expect(mapGoogleAsset(ASSET, "client_clicktrends")).rejects.toBeInstanceOf(NotFoundError);
    expect(db.calls.filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("upserts by (kind, external_id) without sending a mapping", async () => {
    const result = await syncGoogleAssets();
    expect(result).toEqual({ ga4: 1, ads: 0, gsc: 0, warnings: [] });
    const upsert = db.calls.find((c) => c.op === "upsert")!;
    expect(upsert.options).toEqual({ onConflict: "kind,external_id" });
    const [row] = upsert.payload as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ kind: "ga4_property", external_id: "properties/123", currency: "AUD" });
    expect(row).not.toHaveProperty("mapped_client_id");
    expect(row).not.toHaveProperty("id");
  });
});
