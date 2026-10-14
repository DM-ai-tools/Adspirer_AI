import { describe, expect, it } from "vitest";
import { GOALS_DEFAULTS, goalsProfileSchema, resolveGoals } from "@/lib/clients/goals";
import { mapClientRow, toClientDbPatch } from "@/lib/clients/map-client";
import { getDemoStore } from "@/lib/demo/store";

const row = (goals: unknown) => ({
  id: "c1",
  name: "Client",
  slug: "client",
  currency: "AUD",
  budget_ceiling: "2500.00",
  goals_profile: goals,
  is_demo: false,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
});

describe("goals profile schema", () => {
  it("accepts a full lead-gen profile", () => {
    const parsed = goalsProfileSchema.parse({
      business_model: "lead_gen",
      optimisation_event: "LEAD",
      target_cpa_cents: 6000,
      average_value_cents: 40000,
      gross_margin_pct: 35,
      attribution: "7d_click",
      daily_account_cap_cents: 30000,
      max_budget_change_pct: 25,
      allowed_countries: ["AU", "NZ"],
      special_ad_category: "NONE",
      policy: { scale_step_pct: 15, kill_multiple: 2.5 },
    });
    expect(parsed.target_cpa_cents).toBe(6000);
  });

  it("rejects unknown fields, fractional cents and out-of-range values", () => {
    expect(goalsProfileSchema.safeParse({ target_cpa: 60 }).success).toBe(false);
    expect(goalsProfileSchema.safeParse({ target_cpa_cents: 60.5 }).success).toBe(false);
    expect(goalsProfileSchema.safeParse({ gross_margin_pct: 140 }).success).toBe(false);
    expect(goalsProfileSchema.safeParse({ allowed_countries: ["Australia"] }).success).toBe(false);
  });
});

describe("resolveGoals", () => {
  it("fills the plan's defaults when nothing is set", () => {
    const goals = resolveGoals({ goals_profile: {} });
    expect(goals.max_budget_change_pct).toBe(20);
    expect(goals.attribution).toBe("7d_click_1d_view");
    expect(goals.policy).toEqual(GOALS_DEFAULTS.policy);
    expect(goals.policy).toEqual({
      scale_step_pct: 20,
      kill_multiple: 3,
      min_days_of_data: 7,
      prospecting_frequency_max: 3,
      retargeting_frequency_max: 6,
    });
    expect(goals.break_even_cpa_cents).toBeNull();
  });

  it("keeps the client's overrides and derives break-even CPA and ROAS", () => {
    const goals = resolveGoals({
      goals_profile: { average_value_cents: 40000, gross_margin_pct: 25, policy: { scale_step_pct: 10 } },
    });
    expect(goals.policy.scale_step_pct).toBe(10);
    expect(goals.policy.kill_multiple).toBe(3);
    expect(goals.break_even_cpa_cents).toBe(10000);
    expect(goals.break_even_roas).toBe(4);
  });
});

describe("client row mapping", () => {
  it("reads goals_profile from the database row", () => {
    expect(mapClientRow(row({ target_cpa_cents: 6000 })).goals_profile).toEqual({ target_cpa_cents: 6000 });
  });

  it("drops a stored profile that no longer validates instead of failing the whole client", () => {
    expect(mapClientRow(row({ target_cpa_cents: "lots" })).goals_profile).toEqual({});
    expect(mapClientRow(row(null)).goals_profile).toEqual({});
  });

  it("writes goals_profile in a patch", () => {
    expect(toClientDbPatch({ goals_profile: { max_budget_change_pct: 30 } })).toEqual({
      goals_profile: { max_budget_change_pct: 30 },
    });
  });

  it("seeds a demo client with a profile", () => {
    const dental = getDemoStore().clients.find((c) => c.id === "client_modern_dental");
    expect(dental?.goals_profile.target_cpa_cents).toBeGreaterThan(0);
  });
});
