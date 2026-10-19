import { beforeEach, describe, expect, it, vi } from "vitest";

// The Supabase write paths for competitors and briefs, against a fake client
// that records what each insert sends. The demo store never caught these: it
// accepts any shape, while the real tables have uuid ids and their own column
// names (see supabase/migrations/00001_foundation.sql).
const db = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  rows: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({ isDemoMode: false, hasSupabase: true, hasSociaVault: false }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      // A chainable query that resolves to the table's rows (or the first row
      // after .single()); filters are ignored.
      const query = (single = false): Record<string, unknown> => {
        const rows = db.rows[table] ?? [];
        const result = { data: single ? (rows[0] ?? null) : rows, error: null };
        const q: Record<string, unknown> = {
          eq: () => q,
          limit: () => q,
          order: () => q,
          single: () => query(true),
          then: (resolve: (v: typeof result) => unknown) => resolve(result),
        };
        return q;
      };
      return {
        select: () => query(),
        update: () => ({ eq: async () => ({ error: null }) }),
        insert: (row: Record<string, unknown>) => {
          db.inserts.push({ table, row });
          const saved = { id: "0b7c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f", ...row };
          const done = { error: null, data: saved };
          return {
            select: () => ({ single: async () => done }),
            then: (resolve: (v: typeof done) => unknown) => resolve(done),
          };
        },
      };
    },
  }),
}));

import { researchClientService } from "@/lib/competitors/service";
import { upsertImportedCompetitors } from "@/lib/competitors/import-service";

const SERVICE_ID = "6f1c2b9e-0d4a-4c5e-9b8a-2f3e4d5c6b7a";

beforeEach(() => {
  db.inserts = [];
  db.rows = {
    clients: [{ id: "c1", name: "Client", industry: "Furniture", website_url: null }],
    client_services: [{ id: SERVICE_ID, client_id: "c1", name: "Bar stools", keywords: ["bar stools"] }],
    competitors: [],
  };
});

describe("competitor brief on Supabase", () => {
  it("inserts a row with the table's column names and no app-made id", async () => {
    const brief = await researchClientService({ clientId: "c1", serviceId: SERVICE_ID });

    const insert = db.inserts.find((i) => i.table === "competitor_briefs");
    expect(insert).toBeDefined();
    const row = insert!.row;
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("client_service_id");
    expect(row).not.toHaveProperty("raw_research");
    expect(row).not.toHaveProperty("generated_at");
    expect(row.service_id).toBe(SERVICE_ID);
    expect(row.source_metadata).toMatchObject({ provider: "mock" });
    expect(typeof row.researched_at).toBe("string");

    // And the saved row comes back in the app's shape.
    expect(brief.client_service_id).toBe(SERVICE_ID);
    expect(brief.raw_research).toMatchObject({ provider: "mock" });
    expect(brief.id).toBe("0b7c1d2e-3f4a-4b5c-8d9e-0a1b2c3d4e5f");
  });
});

describe("competitor import on Supabase", () => {
  it("lets the database assign the competitor id", async () => {
    await upsertImportedCompetitors({
      clientId: "c1",
      rows: [{ name: "Stool Co", website_url: "https://stoolco.example", domain: "stoolco.example", notes: null }],
    });
    const insert = db.inserts.find((i) => i.table === "competitors");
    expect(insert).toBeDefined();
    expect(insert!.row).not.toHaveProperty("id");
    expect(insert!.row).toMatchObject({ client_id: "c1", name: "Stool Co", website: "https://stoolco.example" });
  });
});
