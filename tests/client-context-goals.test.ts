import { beforeEach, describe, expect, it } from "vitest";
import { buildClientContext } from "@/lib/agent/context-builder";
import { mapClientRow, toClientDbPatch } from "@/lib/clients/map-client";
import { clientPatchSchema } from "@/lib/clients/patch";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";

// Every chat turn gets this context, so the agent can answer "what's our
// target ROAS?" and follows the client's standing instructions outside audits.
beforeEach(() => {
  resetDemoStore();
});

function firstClient() {
  return getDemoStore().clients[0]!;
}

describe("buildClientContext: goals & guardrails", () => {
  it("lists the client's targets, margin and break-even figures", async () => {
    const client = firstClient();
    client.currency = "AUD";
    client.goals_profile = {
      business_model: "ecommerce",
      optimisation_event: "PURCHASE",
      target_roas: 6,
      gross_margin_pct: 40,
      average_value_cents: 18900,
      daily_account_cap_cents: 120000,
    };
    const ctx = await buildClientContext(client.id);
    expect(ctx).toContain("## Goals & guardrails");
    expect(ctx).toContain("- Business model: ecommerce");
    expect(ctx).toContain("- Optimises for: PURCHASE");
    expect(ctx).toContain("- Target ROAS: 6×");
    expect(ctx).toContain("- Gross margin: 40%");
    expect(ctx).toContain("- Break-even ROAS: 2.5×");
    expect(ctx).toContain("- Average order / lead value: 189.00 AUD");
    expect(ctx).toContain("- Break-even CPA: 75.60 AUD");
    expect(ctx).toContain("- Daily account cap: 1200.00 AUD");
  });

  it("says when no goals are set instead of leaving the agent to guess", async () => {
    const client = firstClient();
    client.goals_profile = {};
    const ctx = await buildClientContext(client.id);
    expect(ctx).toContain("## Goals & guardrails");
    expect(ctx).toContain("- No goals set yet");
    expect(ctx).not.toContain("Target ROAS:");
  });
});

describe("buildClientContext: standing instructions and business description", () => {
  it("includes both when set", async () => {
    const client = firstClient();
    client.standing_instructions = "Never pause the brand campaign.";
    client.business_description = "Family-run furniture store with 500 product categories.";
    const ctx = await buildClientContext(client.id);
    expect(ctx).toContain("## Standing instructions");
    expect(ctx).toContain("Never pause the brand campaign.");
    expect(ctx).toContain("Business: Family-run furniture store with 500 product categories.");
  });

  it("leaves the standing instructions section out when none are set", async () => {
    const client = firstClient();
    client.standing_instructions = null;
    const ctx = await buildClientContext(client.id);
    expect(ctx).not.toContain("## Standing instructions");
  });
});

describe("client fields round-trip", () => {
  const row = {
    id: "c1",
    name: "Client",
    slug: "client",
    currency: "USD",
    budget_ceiling: "100.00",
    goals_profile: {},
    standing_instructions: "Ask before raising budgets.",
    business_description: "Dental clinic.",
    is_demo: false,
    created_at: "2026-10-19T00:00:00Z",
    updated_at: "2026-10-19T00:00:00Z",
  };

  it("maps both columns from a row", () => {
    const client = mapClientRow(row);
    expect(client.standing_instructions).toBe("Ask before raising budgets.");
    expect(client.business_description).toBe("Dental clinic.");
  });

  it("accepts and writes both in a patch", () => {
    const body = clientPatchSchema.parse({ standing_instructions: "Use AUD.", business_description: null });
    expect(toClientDbPatch(body)).toEqual({ standing_instructions: "Use AUD.", business_description: null });
    expect(clientPatchSchema.safeParse({ standing_instructions: "x".repeat(4001) }).success).toBe(false);
  });
});
