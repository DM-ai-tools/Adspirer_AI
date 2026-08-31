import { describe, expect, it } from "vitest";
import { assertWithinBudgetCeiling } from "@/lib/approvals/validator";
import { createPendingApproval } from "@/lib/approvals/service";
import { BudgetCeilingViolation } from "@/lib/errors";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import { resolveBudgetDaily } from "@/lib/meta/resolve-budget-daily";

describe("resolveBudgetDaily", () => {
  it("reads daily_budget alias used in approval JSON", () => {
    expect(resolveBudgetDaily({ daily_budget: 5 })).toBe(5);
  });

  it("prefers budget_daily when both are set", () => {
    expect(resolveBudgetDaily({ budget_daily: 10, daily_budget: 5 })).toBe(10);
  });

  it("coerces positive numeric strings", () => {
    expect(resolveBudgetDaily({ daily_budget: "7.5" })).toBe(7.5);
  });

  it("returns undefined for zero or missing values", () => {
    expect(resolveBudgetDaily({ daily_budget: 0 })).toBeUndefined();
    expect(resolveBudgetDaily({})).toBeUndefined();
  });
});

describe("budget ceiling", () => {
  it("throws BudgetCeilingViolation when daily budget exceeds ceiling", () => {
    resetDemoStore();
    const client = getDemoStore().clients.find(
      (c) => c.id === "client_modern_dental",
    )!;
    // Modern Dental ceiling is 250_000 cents
    expect(() =>
      assertWithinBudgetCeiling(
        client,
        { daily_budget_cents: client.budget_ceiling_cents! + 1 },
        null,
      ),
    ).toThrow(BudgetCeilingViolation);
  });

  it("throws BudgetCeilingViolation when budget impact exceeds ceiling", () => {
    resetDemoStore();
    const client = getDemoStore().clients.find(
      (c) => c.id === "client_modern_dental",
    )!;
    expect(() =>
      assertWithinBudgetCeiling(
        client,
        { adset_id: "x" },
        client.budget_ceiling_cents! + 10_000,
      ),
    ).toThrow(BudgetCeilingViolation);
  });

  it("createPendingApproval rejects over-ceiling proposals", async () => {
    resetDemoStore();
    const client = getDemoStore().clients.find(
      (c) => c.id === "client_modern_dental",
    )!;

    await expect(
      createPendingApproval({
        clientId: client.id,
        toolName: "update_adset_budget",
        proposedArgs: {
          account_id: "act_100200300",
          adset_id: "adset_mdc_npl_1",
          daily_budget_cents: client.budget_ceiling_cents! + 50_000,
        },
        budgetImpactCents: client.budget_ceiling_cents! + 50_000,
        requestedBy: "profile_admin_demo",
        idempotencyKey: "idem_budget_over",
      }),
    ).rejects.toBeInstanceOf(BudgetCeilingViolation);
  });

  it("allows proposals within the ceiling", () => {
    resetDemoStore();
    const client = getDemoStore().clients.find(
      (c) => c.id === "client_modern_dental",
    )!;
    expect(() =>
      assertWithinBudgetCeiling(
        client,
        { daily_budget_cents: 5_500 },
        1_500,
      ),
    ).not.toThrow();
  });
});
