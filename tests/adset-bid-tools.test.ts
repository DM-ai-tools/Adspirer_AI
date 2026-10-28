import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderForBackend } from "@/lib/adspirer/client";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { listChanges } from "@/lib/changes/change-log";
import { rollbackChange } from "@/lib/changes/rollback";
import { classify } from "@/lib/tools/policy";

const CLIENT_ID = "client_modern_dental";
const REVIEWER = "profile_admin_demo";
const ACCOUNT = "act_100200300";
const ADSET = "adset_mdc_npl_2";

const provider = () => getProviderForBackend(null);
const propose = (args: Record<string, unknown>) =>
  createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_bid", proposedArgs: { account_id: ACCOUNT, ...args } });
async function run(args: Record<string, unknown>) {
  const pending = await propose(args);
  await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
  const { approval } = await executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER });
  return { pending, approval };
}
const capAt = (amount: number) => provider().updateAdSetBid({ adset_id: ADSET, bid_strategy: "COST_CAP", bid_amount: amount });

beforeEach(() => {
  delete (globalThis as { __adspirerMockMetaState?: unknown }).__adspirerMockMetaState;
});

describe("update_adset_bid", () => {
  it("is an execute tool", () => {
    expect(classify("update_adset_bid")).toBe("execute");
  });

  it("refuses a request that does not fit the strategy, and queues a cap with no amount as needing a fix", async () => {
    await expect(propose({ adset_id: ADSET, bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_amount: 30 })).rejects.toThrow(/bid_amount/);
    await expect(propose({ adset_id: ADSET, bid_strategy: "NOT_A_STRATEGY" })).rejects.toThrow(/bid_strategy/);
    const flagged = await propose({ adset_id: ADSET, bid_strategy: "COST_CAP" });
    expect(flagged.execution_error).toMatch(/bid_amount/);
    await approve({ approvalId: flagged.id, reviewedBy: REVIEWER });
    const spy = vi.spyOn(provider(), "updateAdSetBid");
    spy.mockClear();
    await expect(executeApprovedAction({ approvalId: flagged.id, executedBy: REVIEWER })).rejects.toThrow(/bid_amount/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is medium risk and says the learning phase restarts", async () => {
    const queued = await propose({ adset_id: ADSET, bid_strategy: "COST_CAP", bid_amount: 30 });
    expect(queued.risk_level).toBe("medium");
    expect(queued.risk_reason).toMatch(/learning/i);
  });

  it("is high risk when it takes a cap off, and when it cannot tell what it is changing", async () => {
    await capAt(30);
    expect((await propose({ adset_id: ADSET, bid_strategy: "LOWEST_COST_WITHOUT_CAP" })).risk_level).toBe("high");
    expect((await propose({ adset_id: "adset_nowhere", bid_strategy: "LOWEST_COST_WITHOUT_CAP" })).risk_level).toBe("high");
  });

  it("runs once with the approved values and logs the strategy and cap before and after", async () => {
    await capAt(30);
    const spy = vi.spyOn(provider(), "updateAdSetBid");
    spy.mockClear();
    const { approval } = await run({ adset_id: ADSET, bid_strategy: "COST_CAP", bid_amount: 25 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      account_id: ACCOUNT,
      adset_id: ADSET,
      bid_strategy: "COST_CAP",
      bid_amount: 25,
      roas_average_floor: undefined,
    });
    expect((approval.execution_result?.proof as Record<string, unknown>).bid_amount_cents).toBe(2500);
    const [entry] = await listChanges(CLIENT_ID, 1);
    expect(entry!.before).toMatchObject({ bid_strategy: "COST_CAP", bid_amount_cents: 3000 });
    expect(entry!.after).toMatchObject({ bid_strategy: "COST_CAP", bid_amount_cents: 2500 });
  });

  it("can be rolled back to the earlier strategy and cap", async () => {
    await capAt(30);
    await run({ adset_id: ADSET, bid_strategy: "COST_CAP", bid_amount: 25 });
    const [entry] = await listChanges(CLIENT_ID, 1);
    await rollbackChange({ changeId: entry!.id, userId: REVIEWER });
    expect(await provider().getAdSetDetail!(ACCOUNT, ADSET)).toMatchObject({ bid_strategy: "COST_CAP", bid_amount_cents: 3000 });
  });

  it("refuses to run when the bid was changed in Meta after it was proposed", async () => {
    await capAt(30);
    const pending = await propose({ adset_id: ADSET, bid_strategy: "COST_CAP", bid_amount: 25 });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await capAt(40);
    const spy = vi.spyOn(provider(), "updateAdSetBid");
    spy.mockClear();
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(
      /bid.*changed in Meta since this was proposed/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("the provider's own refusal (a minimum ROAS on a leads ad set) fails the approval and changes nothing", async () => {
    const pending = await propose({ adset_id: ADSET, bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2.5 });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(/Sales.*Nothing was changed/);
    expect((await provider().getAdSetDetail!(ACCOUNT, ADSET))?.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
  });
});
