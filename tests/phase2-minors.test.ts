import { afterEach, describe, expect, it, vi } from "vitest";
import { assessRisk } from "@/lib/approvals/risk";
import { approve, createPendingApproval, edit } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { parseGoalsProfile } from "@/lib/clients/goals";
import { listChanges } from "@/lib/changes/change-log";
import { rollbackChange } from "@/lib/changes/rollback";
import { getProviderForBackend } from "@/lib/adspirer/client";
import { BudgetCeilingViolation } from "@/lib/errors";
import { getDemoStore } from "@/lib/demo/store";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";
import { GET as getChanges } from "@/app/api/clients/[id]/changes/route";
import { POST as postRollback } from "@/app/api/changes/[id]/rollback/route";

const CLIENT_ID = "client_modern_dental";
const ADMIN = "profile_admin_demo";
const OPERATOR = "profile_operator_demo";
const ACCOUNT = "act_100200300";
const provider = getProviderForBackend(null);

afterEach(async () => {
  vi.restoreAllMocks();
  await provider.updateCampaignBudget({ account_id: ACCOUNT, campaign_id: "camp_mdc_npl", daily_budget_cents: 8000 });
  await provider.updateCampaignBudget({ account_id: ACCOUNT, campaign_id: "camp_mdc_cosmetic", daily_budget_cents: 5000 });
  await provider.updateAdSetBudget({ account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4000 });
});

describe("risk scoring", () => {
  it("compares the unrounded increase with the limit", () => {
    expect(assessRisk("update_campaign_budget", { previous_daily_budget_cents: 5000, daily_budget_cents: 6020 }, { goals_profile: {} }).level).toBe("high");
  });

  it("flags a change that would take the account over its daily cap", () => {
    const risk = assessRisk(
      "update_campaign_budget",
      { previous_daily_budget_cents: 5000, daily_budget_cents: 5500 },
      { goals_profile: { daily_account_cap_cents: 30_000 } },
      { projectedAccountDailyCents: 30_500 },
    );
    expect(risk.level).toBe("high");
    expect(risk.reason).toMatch(/daily cap/);
  });

  it("shows the cap on the approval when it is queued", async () => {
    await provider.updateCampaignBudget({ account_id: ACCOUNT, campaign_id: "camp_mdc_npl", daily_budget_cents: 25_000 }); // live total $300
    const queued = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_campaign_budget",
      proposedArgs: { account_id: ACCOUNT, campaign_id: "camp_mdc_cosmetic", daily_budget_cents: 5500 },
    });
    expect(queued.risk_level).toBe("high");
    expect(queued.risk_reason).toMatch(/daily cap/);
  });
});

describe("daily cap covers campaigns created active", () => {
  it("blocks an active campaign whose budget would take the account over the cap", async () => {
    const write = vi.spyOn(provider, "createCampaign");
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "create_campaign",
      proposedArgs: { account_id: ACCOUNT, name: "Big launch", objective: "OUTCOME_TRAFFIC", status: "ACTIVE", daily_budget_cents: 20_000 },
    });
    await approve({ approvalId: pending.id, reviewedBy: ADMIN });
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: ADMIN })).rejects.toBeInstanceOf(BudgetCeilingViolation);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("stored goals profile", () => {
  it("keeps the valid fields of a profile with one bad field", () => {
    expect(parseGoalsProfile({ target_cpa_cents: 6000, max_budget_change_pct: "lots", bogus: 1 })).toEqual({ target_cpa_cents: 6000 });
  });
});

describe("edits can't set internal fields", () => {
  it("ignores __rollback_of and __before supplied in an edit", async () => {
    const args = { account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4400 };
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_budget", proposedArgs: args });
    const edited = await edit({
      approvalId: queued.id,
      reviewedBy: ADMIN,
      editedArgs: { ...args, daily_budget_cents: 4600, __rollback_of: "change_forged", __before: { daily_budget_cents: 1 } },
    });
    expect(edited.edited_args?.__rollback_of).toBeUndefined();
    expect(edited.edited_args?.__before).toEqual({ daily_budget_cents: 4000, status: "ACTIVE" });
  });
});

describe("rollback", () => {
  async function executedBudgetChange() {
    const pending = await createPendingApproval({
      clientId: CLIENT_ID,
      toolName: "update_adset_budget",
      proposedArgs: { account_id: ACCOUNT, adset_id: "adset_mdc_npl_1", daily_budget_cents: 4400 },
    });
    await approve({ approvalId: pending.id, reviewedBy: ADMIN });
    await executeApprovedAction({ approvalId: pending.id, executedBy: ADMIN });
    return (await listChanges(CLIENT_ID))[0]!;
  }

  it("gives a clear answer to a second click while the first is running", async () => {
    const change = await executedBudgetChange();
    const results = await Promise.allSettled([
      rollbackChange({ changeId: change.id, userId: ADMIN }),
      rollbackChange({ changeId: change.id, userId: ADMIN }),
    ]);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failed[0]?.reason.message).toMatch(/already (in progress|been rolled back)/);
  });

  it("enforces client access on the change log and rollback routes", async () => {
    const change = await executedBudgetChange();
    const store = getDemoStore();
    store.userClientAccess = store.userClientAccess.filter((a) => !(a.user_id === OPERATOR && a.client_id === CLIENT_ID));
    const operator = store.profiles.find((p) => p.id === OPERATOR)!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: OPERATOR, email: operator.email, profile: operator });

    const list = await getChanges(new Request("http://x"), { params: Promise.resolve({ id: CLIENT_ID }) });
    expect(list.status).toBe(403);
    const rollback = await postRollback(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: change.id }) });
    expect(rollback.status).toBe(403);

    const admin = store.profiles.find((p) => p.id === ADMIN)!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: ADMIN, email: admin.email, profile: admin });
    const ok = await getChanges(new Request("http://x"), { params: Promise.resolve({ id: CLIENT_ID }) });
    expect(ok.status).toBe(200);
  });

  it("answers a malformed change id with not found, not a server error", async () => {
    const admin = getDemoStore().profiles.find((p) => p.id === ADMIN)!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: ADMIN, email: admin.email, profile: admin });
    const res = await postRollback(new Request("http://x", { method: "POST" }), { params: Promise.resolve({ id: "not a real id" }) });
    expect(res.status).toBe(404);
  });
});
