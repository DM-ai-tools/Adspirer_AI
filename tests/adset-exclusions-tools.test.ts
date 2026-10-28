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
// The demo account's custom audiences.
const VISITORS = "120330000000001";
const CUSTOMERS = "120330000000004";
const ENGAGED = "120330000000003";

const provider = () => getProviderForBackend(null);
const propose = (args: Record<string, unknown>) =>
  createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_audience_exclusions", proposedArgs: { account_id: ACCOUNT, ...args } });
async function run(args: Record<string, unknown>) {
  const pending = await propose(args);
  await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
  const { approval } = await executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER });
  return { pending, approval };
}
const exclude = (ids: string[]) => provider().updateAdSetAudienceExclusions({ adset_id: ADSET, add_excluded_custom_audiences: ids });
const excluded = async () => (await provider().getAdSetDetail!(ACCOUNT, ADSET))?.excluded_custom_audiences;

beforeEach(() => {
  delete (globalThis as { __adspirerMockMetaState?: unknown }).__adspirerMockMetaState;
});

describe("update_adset_audience_exclusions", () => {
  it("is an execute tool", () => {
    expect(classify("update_adset_audience_exclusions")).toBe("execute");
  });

  it("refuses an empty request and the same audience in both lists", async () => {
    await expect(propose({ adset_id: ADSET })).rejects.toThrow(/Provide add_excluded_custom_audiences/);
    await expect(
      propose({ adset_id: ADSET, add_excluded_custom_audiences: [CUSTOMERS], remove_excluded_custom_audiences: [CUSTOMERS] }),
    ).rejects.toThrow(/both/);
  });

  it("accepts ids as numbers or objects and writes them one way", async () => {
    const a = await propose({ adset_id: ADSET, add_excluded_custom_audiences: [Number(VISITORS), { id: CUSTOMERS, name: "CRM" }] });
    expect(a.proposed_args.add_excluded_custom_audiences).toEqual([VISITORS, CUSTOMERS].sort());
    const b = await propose({ ad_set_id: ADSET, add_excluded_custom_audiences: [CUSTOMERS, VISITORS] });
    expect(b.id).toBe(a.id);
  });

  it("is medium risk and says no extra spend is added", async () => {
    const queued = await propose({ adset_id: ADSET, add_excluded_custom_audiences: [CUSTOMERS] });
    expect(queued.risk_level).toBe("medium");
    expect(queued.risk_reason).toMatch(/no extra spend/i);
  });

  it("runs once with the approved values and logs the exclusions before and after", async () => {
    await exclude([ENGAGED]);
    const spy = vi.spyOn(provider(), "updateAdSetAudienceExclusions");
    spy.mockClear();
    const { approval } = await run({ adset_id: ADSET, add_excluded_custom_audiences: [CUSTOMERS], remove_excluded_custom_audiences: [ENGAGED] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      account_id: ACCOUNT,
      adset_id: ADSET,
      add_excluded_custom_audiences: [CUSTOMERS],
      remove_excluded_custom_audiences: [ENGAGED],
    });
    expect((approval.execution_result?.proof as Record<string, unknown>).excluded_custom_audiences).toEqual([CUSTOMERS]);
    const [entry] = await listChanges(CLIENT_ID, 1);
    expect(entry!.before?.excluded_custom_audiences).toEqual([ENGAGED]);
    expect(entry!.after?.excluded_custom_audiences).toEqual([CUSTOMERS]);
  });

  it("can be rolled back", async () => {
    await exclude([ENGAGED]);
    await run({ adset_id: ADSET, add_excluded_custom_audiences: [CUSTOMERS], remove_excluded_custom_audiences: [ENGAGED] });
    const [entry] = await listChanges(CLIENT_ID, 1);
    await rollbackChange({ changeId: entry!.id, userId: REVIEWER });
    expect(await excluded()).toEqual([ENGAGED]);
  });

  it("refuses to roll back over a newer change", async () => {
    await run({ adset_id: ADSET, add_excluded_custom_audiences: [CUSTOMERS] });
    const [entry] = await listChanges(CLIENT_ID, 1);
    await exclude([VISITORS]);
    await expect(rollbackChange({ changeId: entry!.id, userId: REVIEWER })).rejects.toThrow(/changed again in Meta/);
  });

  it("refuses to run when the exclusions changed in Meta after it was proposed", async () => {
    const pending = await propose({ adset_id: ADSET, add_excluded_custom_audiences: [CUSTOMERS] });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await exclude([ENGAGED]);
    const spy = vi.spyOn(provider(), "updateAdSetAudienceExclusions");
    spy.mockClear();
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(
      /exclusions changed in Meta since this was proposed/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("an audience that is not in the account fails the approval and changes nothing", async () => {
    const pending = await propose({ adset_id: ADSET, add_excluded_custom_audiences: ["999999"] });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(/Audience 999999.*Nothing was changed/);
    expect(await excluded()).toEqual([]);
  });
});
