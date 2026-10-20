import { beforeEach, describe, expect, it, vi } from "vitest";

// Chat settings saved against a fake Supabase client that records each update,
// as in competitor-supabase-paths.test.ts.
const db = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  reply: "",
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    isDemoMode: false,
    hasSupabase: true,
    hasOpenAI: true,
    OPENAI_API_KEY: "test-key",
    OPENAI_MODEL: "gpt-4o-mini",
  }),
}));

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: vi.fn(async () => ({ text: db.reply })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      // A chainable read that resolves to the table's first row matching every .eq().
      const read = () => {
        const filters: Array<[string, unknown]> = [];
        const rows = () => (db.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
        const q: Record<string, unknown> = {
          eq: (k: string, v: unknown) => {
            filters.push([k, v]);
            return q;
          },
          single: async () => ({ data: rows()[0] ?? null, error: rows()[0] ? null : { message: "no row" } }),
          maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
        };
        return q;
      };
      return {
        select: () => read(),
        update: (patch: Record<string, unknown>) => {
          const entry = { table, patch, filters: [] as Array<[string, unknown]> };
          db.updates.push(entry);
          const saved = () => ({ data: { ...(db.rows[table]?.[0] ?? {}), ...patch }, error: null });
          const q: Record<string, unknown> = {
            eq: (k: string, v: unknown) => {
              entry.filters.push([k, v]);
              return q;
            },
            select: () => ({ single: async () => saved() }),
            then: (resolve: (v: unknown) => unknown) => resolve({ error: null }),
          };
          return q;
        },
      };
    },
  }),
}));

import { applyChatSettings } from "@/lib/clients/chat-settings";
import type { ClientService } from "@/types";

const SERVICE_ID = "6f1c2b9e-0d4a-4c5e-9b8a-2f3e4d5c6b7a";
const service: ClientService = {
  id: SERVICE_ID,
  client_id: "c1",
  name: "Bar stools",
  description: null,
  keywords: ["bar stools"],
  landing_page_url: null,
  is_active: true,
  gross_margin_pct: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  db.updates = [];
  db.rows = {
    profiles: [
      { id: "u_admin", role: "admin" },
      { id: "u_op", role: "operator" },
    ],
    clients: [
      {
        id: "c1",
        name: "During Days",
        slug: "during-days",
        currency: "AUD",
        budget_ceiling: 5000,
        goals_profile: { business_model: "ecommerce", target_roas: 6 },
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ],
    client_services: [service as unknown as Record<string, unknown>],
  };
  db.reply = JSON.stringify({
    settings: [
      { field: "target_roas", value: 8 },
      { field: "budget_ceiling", value: 10000 },
      { field: "category_margin", category: "bar stools", value: 45 },
    ],
  });
});

describe("chat settings on Supabase", () => {
  it("updates the client with its DB column names and the service through its update path", async () => {
    const turn = await applyChatSettings({
      clientId: "c1",
      userId: "u_admin",
      request: "our target ROAS is 8x, budget ceiling is $10k and bar stools margin is 45%",
      services: [service],
    });

    const client = db.updates.find((u) => u.table === "clients")!;
    expect(client.patch).toMatchObject({
      goals_profile: { business_model: "ecommerce", target_roas: 8 },
      budget_ceiling: 10000,
    });
    expect(client.patch).not.toHaveProperty("budget_ceiling_cents");
    expect(typeof client.patch.updated_at).toBe("string");
    expect(client.filters).toEqual([["id", "c1"]]);

    const svc = db.updates.find((u) => u.table === "client_services")!;
    expect(svc.patch).toMatchObject({ gross_margin_pct: 45 });
    expect(svc.filters).toEqual([
      ["id", SERVICE_ID],
      ["client_id", "c1"],
    ]);

    expect(turn.evidence()).toContain(
      "Saved to During Days' settings: target ROAS 8× (was 6×); budget ceiling A$10,000 (was A$5,000); Bar stools margin 45% (was not set).",
    );
    expect(turn.withServiceOverrides([service])[0].gross_margin_pct).toBe(45);
  });

  it("reads the role from profiles and saves nothing for an operator", async () => {
    const turn = await applyChatSettings({
      clientId: "c1",
      userId: "u_op",
      request: "our target ROAS is 8x, budget ceiling is $10k and bar stools margin is 45%",
      services: [service],
    });
    expect(db.updates).toEqual([]);
    expect(turn.evidence()).toContain("Only an admin can save client settings; I used");
    expect(turn.toolCall()).toBeNull();
    // Still used for this turn.
    expect(turn.goalsOverride()).toMatchObject({ target_roas: 8 });
    expect(turn.withServiceOverrides([service])[0].gross_margin_pct).toBe(45);
  });
});
