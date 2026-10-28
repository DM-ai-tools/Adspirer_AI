import { beforeEach, describe, expect, it, vi } from "vitest";
import { getProviderForBackend } from "@/lib/adspirer/client";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { listChanges } from "@/lib/changes/change-log";
import { rollbackChange } from "@/lib/changes/rollback";
import { ApprovalValidationError } from "@/lib/errors";
import { classify } from "@/lib/tools/policy";

const CLIENT_ID = "client_modern_dental";
const REVIEWER = "profile_admin_demo";
const ACCOUNT = "act_100200300";
const ADSET = "adset_mdc_npl_2";

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const provider = () => getProviderForBackend(null);

async function propose(toolName: string, args: Record<string, unknown>) {
  return createPendingApproval({ clientId: CLIENT_ID, toolName, proposedArgs: { account_id: ACCOUNT, ...args } });
}
async function run(toolName: string, args: Record<string, unknown>) {
  const pending = await propose(toolName, args);
  await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
  const { approval } = await executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER });
  return { pending, approval };
}

beforeEach(() => {
  // The demo Meta account is one shared in-memory object; every test starts from the seed.
  delete (globalThis as { __adspirerMockMetaState?: unknown }).__adspirerMockMetaState;
});

describe("update_adset_schedule", () => {
  it("is an execute tool", () => {
    expect(classify("update_adset_schedule")).toBe("execute");
  });

  it("is refused at proposal time when it asks for nothing, or asks for contradictions", async () => {
    await expect(propose("update_adset_schedule", { adset_id: ADSET })).rejects.toThrow(/Provide end_time/);
    await expect(
      propose("update_adset_schedule", { adset_id: ADSET, end_time: inDays(10), clear_end_time: true }),
    ).rejects.toThrow(/not both/);
    await expect(propose("update_adset_schedule", { adset_id: ADSET, end_time: inDays(-2) })).rejects.toThrow(/future/);
  });

  it("scores the risk by what it does to how long the ad set spends", async () => {
    await provider().updateAdSetSchedule({ adset_id: ADSET, end_time: inDays(30) });
    expect((await propose("update_adset_schedule", { adset_id: ADSET, end_time: inDays(10) })).risk_level).toBe("low");
    expect((await propose("update_adset_schedule", { adset_id: ADSET, end_time: inDays(60) })).risk_level).toBe("medium");
    expect((await propose("update_adset_schedule", { adset_id: ADSET, clear_end_time: true })).risk_level).toBe("medium");
  });

  it("records the live end date it is changing from", async () => {
    await provider().updateAdSetSchedule({ adset_id: ADSET, end_time: inDays(30) });
    const queued = await propose("update_adset_schedule", { adset_id: ADSET, end_time: inDays(10) });
    const before = (queued.proposed_args.__before ?? {}) as { end_time?: string | null };
    expect(Date.parse(String(before.end_time))).toBeCloseTo(Date.parse(inDays(30)), -4);
  });

  it("runs once, with exactly the approved values, and logs before and after", async () => {
    await provider().updateAdSetSchedule({ adset_id: ADSET, end_time: inDays(30) });
    const spy = vi.spyOn(provider(), "updateAdSetSchedule");
    const end = new Date(inDays(10)).toISOString();
    const { approval } = await run("update_adset_schedule", { adset_id: ADSET, end_time: end });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ account_id: ACCOUNT, adset_id: ADSET, end_time: end, clear_end_time: false, start_time: undefined });
    expect(approval.status).toBe("executed");
    expect((approval.execution_result?.proof as Record<string, unknown>).end_time).toBe(end);

    const [entry] = await listChanges(CLIENT_ID, 1);
    expect(entry).toMatchObject({ tool_name: "update_adset_schedule", entity_type: "adset", entity_id: ADSET });
    expect(entry!.after?.end_time).toBe(end);
    expect(Date.parse(String(entry!.before?.end_time))).toBeCloseTo(Date.parse(inDays(30)), -4);
  });

  it("can be rolled back to the earlier end date", async () => {
    const original = new Date(inDays(30)).toISOString();
    await provider().updateAdSetSchedule({ adset_id: ADSET, end_time: original });
    await run("update_adset_schedule", { adset_id: ADSET, end_time: inDays(10) });
    const [entry] = await listChanges(CLIENT_ID, 1);
    await rollbackChange({ changeId: entry!.id, userId: REVIEWER });
    const state = await provider().getAdSetDetail!(ACCOUNT, ADSET);
    expect(state?.end_time).toBe(original);
  });

  it("refuses to roll back over a newer change", async () => {
    await provider().updateAdSetSchedule({ adset_id: ADSET, end_time: inDays(30) });
    await run("update_adset_schedule", { adset_id: ADSET, end_time: inDays(10) });
    const [entry] = await listChanges(CLIENT_ID, 1);
    await provider().updateAdSetSchedule({ adset_id: ADSET, end_time: inDays(20) });
    await expect(rollbackChange({ changeId: entry!.id, userId: REVIEWER })).rejects.toThrow(/changed again in Meta/);
  });

  it("refuses to run when the end date moved in Meta after it was proposed", async () => {
    await provider().updateAdSetSchedule({ adset_id: ADSET, end_time: inDays(30) });
    const pending = await propose("update_adset_schedule", { adset_id: ADSET, end_time: inDays(10) });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await provider().updateAdSetSchedule({ adset_id: ADSET, end_time: inDays(25) });
    // The spy may already be attached from an earlier test; count only what execution does.
    const spy = vi.spyOn(provider(), "updateAdSetSchedule");
    spy.mockClear();
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(ApprovalValidationError);
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(/end date changed in Meta/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an ad set that is not in the account, and never calls Meta", async () => {
    const pending = await propose("update_adset_schedule", { adset_id: "adset_nowhere", end_time: inDays(10) });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    const spy = vi.spyOn(provider(), "updateAdSetSchedule");
    spy.mockClear();
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(/no longer be found/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts ad_set_id as a name for adset_id", async () => {
    const queued = await propose("update_adset_schedule", { ad_set_id: ADSET, end_time: inDays(10) });
    expect(queued.proposed_args.adset_id).toBe(ADSET);
    expect(queued.proposed_args.ad_set_id).toBeUndefined();
  });

  it("two identical proposals are one approval", async () => {
    const end = new Date(inDays(10)).toISOString();
    const a = await propose("update_adset_schedule", { adset_id: ADSET, end_time: end });
    const b = await propose("update_adset_schedule", { adset_id: ADSET, end_time: end });
    expect(b.id).toBe(a.id);
  });
});
