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
      const matching = (filters: Array<[string, unknown]>) =>
        (db.rows[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
      // A chainable read that resolves to the rows matching every .eq().
      const read = () => {
        const filters: Array<[string, unknown]> = [];
        const q: Record<string, unknown> = {
          eq: (k: string, v: unknown) => {
            filters.push([k, v]);
            return q;
          },
          single: async () => {
            const row = matching(filters)[0];
            return { data: row ? structuredClone(row) : null, error: row ? null : { message: "no row" } };
          },
          maybeSingle: async () => ({ data: matching(filters)[0] ?? null, error: null }),
          then: (resolve: (v: unknown) => unknown) => resolve({ data: matching(filters), error: null }),
        };
        return q;
      };
      return {
        select: () => read(),
        // Records the update and applies it to the matching rows when awaited.
        update: (patch: Record<string, unknown>) => {
          const entry = { table, patch, filters: [] as Array<[string, unknown]> };
          db.updates.push(entry);
          const run = () => {
            const rows = matching(entry.filters);
            for (const row of rows) Object.assign(row, structuredClone(patch));
            return { data: rows[0] ?? null, error: null };
          };
          const q: Record<string, unknown> = {
            eq: (k: string, v: unknown) => {
              entry.filters.push([k, v]);
              return q;
            },
            select: () => ({ single: async () => run() }),
            then: (resolve: (v: unknown) => unknown) => resolve(run()),
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
const REQUEST = "our target ROAS is 8x, budget ceiling is $10k and bar stools margin is 45%";
const clientRow = () => db.rows.clients[0]!;

beforeEach(() => {
  db.updates = [];
  db.rows = {
    profiles: [
      { id: "u_admin", role: "admin", is_active: true },
      { id: "u_off", role: "admin", is_active: false },
      { id: "u_op", role: "operator", is_active: true },
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
    client_services: [{ ...service } as unknown as Record<string, unknown>],
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
      request: REQUEST,
      loadServices: async () => [service],
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

  it("reads the role from profiles and saves nothing for an operator or a switched-off admin", async () => {
    for (const userId of ["u_op", "u_off"]) {
      const turn = await applyChatSettings({ clientId: "c1", userId, request: REQUEST, loadServices: async () => [service] });
      expect(db.updates).toEqual([]);
      expect(turn.evidence()).toContain("Only an admin can save client settings; I used");
      expect(turn.toolCall()).toBeNull();
      // Still used for this turn.
      expect(turn.goalsOverride()).toMatchObject({ target_roas: 8 });
      expect(turn.withServiceOverrides([service])[0].gross_margin_pct).toBe(45);
    }
  });

  it("re-reads the client before each write and merges onto the fresh profile", async () => {
    db.reply = JSON.stringify({ settings: [{ field: "budget_ceiling", value: 10000 }] });
    const turn = await applyChatSettings({
      clientId: "c1",
      userId: "u_admin",
      request: "budget ceiling is $10k",
      loadServices: async () => [service],
    });
    // Someone saves the Settings tab between the two writes.
    clientRow().goals_profile = { business_model: "ecommerce", target_roas: 6, monthly_cap_cents: 3_000_000 };
    await turn.saveStrategyTarget(10);
    const last = db.updates.filter((u) => u.table === "clients").at(-1)!;
    expect(last.patch.goals_profile).toEqual({ business_model: "ecommerce", target_roas: 10, monthly_cap_cents: 3_000_000 });
  });
});
