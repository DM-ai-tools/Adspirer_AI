import { afterEach, describe, expect, it, vi } from "vitest";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { accountDailyTotalCents } from "@/lib/approvals/validator";
import { getProviderForBackend } from "@/lib/adspirer/client";
import { BudgetCeilingViolation } from "@/lib/errors";

// Modern Dental: daily account cap $300 (30,000 cents). Live MDC account:
// New Patient Leads $80 + Cosmetic $50 active, Retargeting $20 paused → $130.
const CLIENT_ID = "client_modern_dental";
const ADMIN = "profile_admin_demo";
const ACCOUNT = "act_100200300";
const provider = getProviderForBackend(null);

afterEach(async () => {
  vi.restoreAllMocks();
  await provider.updateCampaignBudget({ account_id: ACCOUNT, campaign_id: "camp_mdc_cosmetic", daily_budget_cents: 5000 });
  await provider.updateCampaignBudget({ account_id: ACCOUNT, campaign_id: "camp_mdc_npl", daily_budget_cents: 8000 });
  await provider.pauseCampaign(ACCOUNT, "camp_mdc_retarget");
});

async function run(toolName: string, proposedArgs: Record<string, unknown>) {
  const pending = await createPendingApproval({ clientId: CLIENT_ID, toolName, proposedArgs });
  await approve({ approvalId: pending.id, reviewedBy: ADMIN });
  return executeApprovedAction({ approvalId: pending.id, executedBy: ADMIN });
}

describe("accountDailyTotalCents", () => {
  it("adds campaign budgets, or live ad set budgets where the campaign has none, for live campaigns only", () => {
    expect(
      accountDailyTotalCents(
        [
          { id: "cbo", status: "ACTIVE", daily_budget_cents: 8000 },
          { id: "abo", status: "ACTIVE" },
          { id: "off", status: "PAUSED", daily_budget_cents: 9000 },
        ],
        [
          { campaign_id: "cbo", status: "ACTIVE", daily_budget_cents: 0 },
          { campaign_id: "abo", status: "ACTIVE", daily_budget_cents: 1500 },
          { campaign_id: "abo", status: "PAUSED", daily_budget_cents: 7000 },
        ],
      ),
    ).toBe(9500);
  });
});

describe("daily account cap at execution", () => {
  it("allows an increase that keeps the account under the cap", async () => {
    const { approval } = await run("update_campaign_budget", { account_id: ACCOUNT, campaign_id: "camp_mdc_cosmetic", daily_budget_cents: 22_000 });
    expect(approval.status).toBe("executed");
  });

  it("blocks an increase that would take the account over the cap", async () => {
    const write = vi.spyOn(provider, "updateCampaignBudget");
    await expect(
      run("update_campaign_budget", { account_id: ACCOUNT, campaign_id: "camp_mdc_cosmetic", daily_budget_cents: 23_000 }),
    ).rejects.toThrow(/\$310.*daily cap of \$300/);
    expect(write).not.toHaveBeenCalled();
  });

  it("counts a resumed campaign's budget against the cap", async () => {
    await provider.updateCampaignBudget({ account_id: ACCOUNT, campaign_id: "camp_mdc_npl", daily_budget_cents: 28_000 }); // live total now $330 with retargeting
    await provider.updateCampaignBudget({ account_id: ACCOUNT, campaign_id: "camp_mdc_cosmetic", daily_budget_cents: 1000 }); // $290 live
    await expect(run("resume_campaign", { account_id: ACCOUNT, campaign_id: "camp_mdc_retarget" })).rejects.toBeInstanceOf(
      BudgetCeilingViolation,
    );
  });

  it("never blocks a decrease", async () => {
    await provider.updateCampaignBudget({ account_id: ACCOUNT, campaign_id: "camp_mdc_npl", daily_budget_cents: 40_000 }); // over the cap already
    const { approval } = await run("update_campaign_budget", { account_id: ACCOUNT, campaign_id: "camp_mdc_npl", daily_budget_cents: 30_000 });
    expect(approval.status).toBe("executed");
  });
});
