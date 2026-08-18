import { describe, expect, it } from "vitest";
import { assertWithinBudgetCeiling } from "@/lib/approvals/validator";
import { createPendingApproval } from "@/lib/approvals/service";
import { BudgetCeilingViolation } from "@/lib/errors";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";

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
