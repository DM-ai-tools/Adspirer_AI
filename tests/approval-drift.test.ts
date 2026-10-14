import { afterEach, describe, expect, it, vi } from "vitest";
import { approve, createPendingApproval, edit } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { getProviderForBackend } from "@/lib/adspirer/client";

const CLIENT_ID = "client_modern_dental";
const ADMIN = "profile_admin_demo";
const ACCOUNT = "act_100200300";
const provider = getProviderForBackend(null);

async function setAdSetBudget(cents: number) {
  await provider.updateAdSetBudget({ account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: cents });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await setAdSetBudget(4000);
  await provider.resumeCampaign(ACCOUNT, "camp_mdc_npl");
});

const raise = (next: number, prev: number) => ({
  account_id: ACCOUNT,
  adset_id: "adset_mdc_npl_1",
  daily_budget_cents: next,
  previous_daily_budget_cents: prev,
});

describe("live before values", () => {
  it("replaces the proposal's current budget with the live one and records it", async () => {
    // The proposal believed the budget was 3,000; Meta says 4,000.
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_budget", proposedArgs: raise(4400, 3000) });
    expect(queued.proposed_args.previous_daily_budget_cents).toBe(4000);
    expect(queued.proposed_args.__before).toEqual({ daily_budget_cents: 4000, status: "ACTIVE" });
    expect(queued.budget_impact_cents).toBe(400);
    expect(queued.risk_level).toBe("medium");
  });

  it("records the live status for status changes", async () => {
    const queued = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "pause_campaign",
      proposedArgs: { account_id: ACCOUNT, campaign_id: "camp_mdc_npl" },
    });
    expect(queued.proposed_args.__before).toMatchObject({ status: "ACTIVE" });
  });
});

describe("risk is re-scored from the live budget at execution", () => {
  it("refuses an operator-approved increase that the live budget shows is large", async () => {
    // Meta couldn't be read when it was proposed, so the proposal's claim stood:
    // $100 → $110 looks like +10% (medium). Live, the budget is $40: +175%.
    vi.spyOn(provider, "getEntityState").mockRejectedValueOnce(new Error("Meta unavailable"));
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_budget", proposedArgs: raise(11_000, 10_000) });
    expect(queued.risk_level).toBe("medium");
    expect(queued.proposed_args.__before).toBeUndefined();
    await approve({ approvalId: queued.id, reviewedBy: "profile_operator_demo" });
    const write = vi.spyOn(provider, "updateAdSetBudget");
    await expect(executeApprovedAction({ approvalId: queued.id, executedBy: "profile_operator_demo" })).rejects.toThrow(
      /admin/,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("lets an admin-approved change through after re-scoring", async () => {
    vi.spyOn(provider, "getEntityState").mockRejectedValueOnce(new Error("Meta unavailable"));
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_budget", proposedArgs: raise(11_000, 10_000) });
    await approve({ approvalId: queued.id, reviewedBy: ADMIN });
    const { approval } = await executeApprovedAction({ approvalId: queued.id, executedBy: ADMIN });
    expect(approval.status).toBe("executed");
  });
});

describe("drift between proposal and execution", () => {
  it("blocks a budget change when the budget changed in Meta since it was proposed", async () => {
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_budget", proposedArgs: raise(4400, 4000) });
    await approve({ approvalId: queued.id, reviewedBy: ADMIN });
    await setAdSetBudget(4500); // someone edited it in Ads Manager
    const write = vi.spyOn(provider, "updateAdSetBudget");
    await expect(executeApprovedAction({ approvalId: queued.id, executedBy: ADMIN })).rejects.toThrow(
      /changed in Meta since this was proposed.*\$40\.00.*\$45\.00/,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("blocks a pause when the campaign was already paused in Meta", async () => {
    const queued = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "pause_campaign",
      proposedArgs: { account_id: ACCOUNT, campaign_id: "camp_mdc_npl" },
    });
    await approve({ approvalId: queued.id, reviewedBy: ADMIN });
    await provider.pauseCampaign(ACCOUNT, "camp_mdc_npl");
    await expect(executeApprovedAction({ approvalId: queued.id, executedBy: ADMIN })).rejects.toThrow(/status was ACTIVE, now PAUSED/);
  });

  it("executes when nothing changed", async () => {
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_budget", proposedArgs: raise(4400, 4000) });
    await approve({ approvalId: queued.id, reviewedBy: ADMIN });
    const { approval } = await executeApprovedAction({ approvalId: queued.id, executedBy: ADMIN });
    expect(approval.status).toBe("executed");
  });

  it("re-reads the live values when the approval is edited", async () => {
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_budget", proposedArgs: raise(4400, 4000) });
    await setAdSetBudget(4200);
    const edited = await edit({ approvalId: queued.id, reviewedBy: ADMIN, editedArgs: raise(4600, 4000) });
    expect(edited.edited_args?.__before).toEqual({ daily_budget_cents: 4200, status: "ACTIVE" });
    expect(edited.edited_args?.previous_daily_budget_cents).toBe(4200);
    await approve({ approvalId: queued.id, reviewedBy: ADMIN });
    const { approval } = await executeApprovedAction({ approvalId: queued.id, executedBy: ADMIN });
    expect(approval.status).toBe("executed");
  });
});
