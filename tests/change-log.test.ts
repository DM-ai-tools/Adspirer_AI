import { afterEach, describe, expect, it, vi } from "vitest";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { buildChangeEntry, listChanges } from "@/lib/changes/change-log";
import { getProviderForBackend } from "@/lib/adspirer/client";
import type { Approval } from "@/types";

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

async function run(toolName: string, proposedArgs: Record<string, unknown>, reviewer = ADMIN) {
  const pending = await createPendingApproval({ clientId: CLIENT_ID, toolName, proposedArgs, rationale: "Test change" });
  await approve({ approvalId: pending.id, reviewedBy: reviewer });
  return executeApprovedAction({ approvalId: pending.id, executedBy: OPERATOR });
}

describe("buildChangeEntry", () => {
  const approval = (tool: string, args: Record<string, unknown>) =>
    ({ id: "ap1", client_id: CLIENT_ID, tool_name: tool, proposed_args: args, edited_args: null, reviewed_by: ADMIN, rationale: "Why" }) as unknown as Approval;

  it("records a budget change's before and after", () => {
    const entry = buildChangeEntry(
      approval("update_adset_budget", { account_id: ACCOUNT, adset_id: "as1", __before: { daily_budget_cents: 4000, status: "ACTIVE" } }),
      { proof: { ad_set_id: "as1", daily_budget_cents: 4400 } },
      OPERATOR,
    );
    expect(entry).toMatchObject({
      entity_type: "adset",
      entity_id: "as1",
      account_id: ACCOUNT,
      before: { daily_budget_cents: 4000 },
      after: { daily_budget_cents: 4400 },
      approved_by: ADMIN,
      executed_by: OPERATOR,
      rationale: "Why",
    });
  });

  it("records a status change", () => {
    const entry = buildChangeEntry(
      approval("pause_campaign", { account_id: ACCOUNT, campaign_id: "c1", __before: { status: "ACTIVE" } }),
      { proof: { campaign_id: "c1", status: "PAUSED" } },
      OPERATOR,
    );
    expect(entry).toMatchObject({ entity_type: "campaign", entity_id: "c1", before: { status: "ACTIVE" }, after: { status: "PAUSED" } });
  });

  it("records creates without a before state", () => {
    const entry = buildChangeEntry(
      approval("create_meta_image_campaign", { account_id: ACCOUNT }),
      { proof: { campaign_id: "c9", ad_set_id: "as9", ad_id: "ad9", status: "PAUSED" } },
      OPERATOR,
    );
    expect(entry).toMatchObject({ entity_type: "campaign", entity_id: "c9", before: null });
  });
});

describe("change log on execution", () => {
  it("writes one entry per executed change, newest first", async () => {
    await run("update_adset_budget", { account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4400, previous_daily_budget_cents: 4000 });
    await run("pause_campaign", { account_id: ACCOUNT, campaign_id: "camp_mdc_npl" });
    const changes = await listChanges(CLIENT_ID);
    expect(changes.map((c) => c.tool_name)).toEqual(["pause_campaign", "update_adset_budget"]);
    expect(changes[1]).toMatchObject({
      entity_id: "adset_mdc_npl_1",
      before: { daily_budget_cents: 4000 },
      after: { daily_budget_cents: 4400 },
      approved_by: ADMIN,
      executed_by: OPERATOR,
    });
  });

  it("writes nothing when the change fails", async () => {
    vi.spyOn(provider, "updateAdSetBudget").mockRejectedValueOnce(new Error("Meta said no"));
    await expect(
      run("update_adset_budget", { account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4400, previous_daily_budget_cents: 4000 }),
    ).rejects.toThrow(/Meta said no/);
    expect(await listChanges(CLIENT_ID)).toEqual([]);
  });

  it("keeps clients' logs apart", async () => {
    await run("pause_campaign", { account_id: ACCOUNT, campaign_id: "camp_mdc_npl" });
    expect(await listChanges("client_trafficradius")).toEqual([]);
  });
});
