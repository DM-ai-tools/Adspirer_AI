import { afterEach, describe, expect, it, vi } from "vitest";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { listChanges } from "@/lib/changes/change-log";
import { rollbackChange } from "@/lib/changes/rollback";
import { getProviderForBackend } from "@/lib/adspirer/client";
import { AuthorizationError } from "@/lib/errors";

const CLIENT_ID = "client_modern_dental";
const ADMIN = "profile_admin_demo";
const OPERATOR = "profile_operator_demo";
const ACCOUNT = "act_100200300";
const provider = getProviderForBackend(null);

afterEach(async () => {
  vi.restoreAllMocks();
  await provider.updateAdSetBudget({ account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4000 });
  await provider.resumeCampaign(ACCOUNT, "camp_mdc_npl");
});

async function run(toolName: string, proposedArgs: Record<string, unknown>) {
  const pending = await createPendingApproval({ clientId: CLIENT_ID, toolName, proposedArgs });
  await approve({ approvalId: pending.id, reviewedBy: ADMIN });
  await executeApprovedAction({ approvalId: pending.id, executedBy: ADMIN });
  return (await listChanges(CLIENT_ID))[0]!;
}

const liveAdSetBudget = async () =>
  (await provider.listAdSets(ACCOUNT)).find((a) => a.id === "adset_mdc_npl_1")!.daily_budget_cents;

describe("rollbackChange", () => {
  it("puts a budget back and logs the rollback against the original change", async () => {
    const change = await run("update_adset_budget", { account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4400 });
    const result = await rollbackChange({ changeId: change.id, userId: OPERATOR });
    expect(result.approval.status).toBe("executed");
    expect(result.approval.risk_level).toBe("low");
    expect(await liveAdSetBudget()).toBe(4000);
    const [latest] = await listChanges(CLIENT_ID);
    expect(latest).toMatchObject({
      rollback_of: change.id,
      tool_name: "update_adset_budget",
      before: { daily_budget_cents: 4400 },
      after: { daily_budget_cents: 4000 },
    });
  });

  it("undoes a pause by resuming, which needs an admin", async () => {
    const change = await run("pause_campaign", { account_id: ACCOUNT, campaign_id: "camp_mdc_npl" });
    await expect(rollbackChange({ changeId: change.id, userId: OPERATOR })).rejects.toBeInstanceOf(AuthorizationError);
    const result = await rollbackChange({ changeId: change.id, userId: ADMIN });
    expect(result.approval.tool_name).toBe("resume_campaign");
    expect((await provider.listCampaigns(ACCOUNT)).find((c) => c.id === "camp_mdc_npl")?.status).toBe("ACTIVE");
  });

  it("refuses to roll back the same change twice", async () => {
    const change = await run("update_adset_budget", { account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4400 });
    await rollbackChange({ changeId: change.id, userId: ADMIN });
    await expect(rollbackChange({ changeId: change.id, userId: ADMIN })).rejects.toThrow(/already been rolled back/);
  });

  it("refuses when the item changed again in Meta since, so a newer change is never overwritten", async () => {
    const change = await run("update_adset_budget", { account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4400 });
    await provider.updateAdSetBudget({ account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4600 });
    await expect(rollbackChange({ changeId: change.id, userId: ADMIN })).rejects.toThrow(/changed again in Meta/);
    expect(await liveAdSetBudget()).toBe(4600);
  });

  it("reads the live state directly, and says so when Meta can't be read rather than claiming it changed", async () => {
    const change = await run("pause_ad", { account_id: ACCOUNT, ad_id: "ad_mdc_npl_b" });
    const list = vi.spyOn(provider, "listAds");
    vi.spyOn(provider, "getEntityState").mockResolvedValueOnce(null);
    await expect(rollbackChange({ changeId: change.id, userId: ADMIN })).rejects.toThrow(/couldn't read its current state/);
    expect(list).not.toHaveBeenCalled();
    await provider.resumeAd(ACCOUNT, "ad_mdc_npl_b");
  });

  it("refuses changes that can't be undone with one action", async () => {
    const created = {
      ...(await run("pause_campaign", { account_id: ACCOUNT, campaign_id: "camp_mdc_npl" })),
    };
    const store = (await import("@/lib/demo/store")).getDemoStore();
    store.changeLog.push({ ...created, id: "change_create", tool_name: "create_meta_image_campaign", before: null });
    await expect(rollbackChange({ changeId: "change_create", userId: ADMIN })).rejects.toThrow(/Only budget and status changes/);
  });
});
