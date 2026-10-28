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
  createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_placements", proposedArgs: { account_id: ACCOUNT, ...args } });
async function run(args: Record<string, unknown>) {
  const pending = await propose(args);
  await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
  const { approval } = await executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER });
  return { pending, approval };
}
const manual = () =>
  provider().updateAdSetPlacements({
    adset_id: ADSET,
    publisher_platforms: ["facebook", "instagram", "audience_network"],
    facebook_positions: ["feed", "story"],
    instagram_positions: ["stream"],
    audience_network_positions: ["classic"],
  });
const dropAudienceNetwork = { publisher_platforms: ["facebook", "instagram"], facebook_positions: ["feed", "story"], instagram_positions: ["stream"] };

beforeEach(() => {
  delete (globalThis as { __adspirerMockMetaState?: unknown }).__adspirerMockMetaState;
});

describe("update_adset_placements", () => {
  it("is an execute tool", () => {
    expect(classify("update_adset_placements")).toBe("execute");
  });

  it("refuses a request that names no placement change, or contradicts itself", async () => {
    await expect(propose({ adset_id: ADSET })).rejects.toThrow(/Provide advantage_placements, publisher_platforms/);
    await expect(propose({ adset_id: ADSET, advantage_placements: true, publisher_platforms: ["facebook"] })).rejects.toThrow(/not both/);
    await expect(propose({ adset_id: ADSET, publisher_platforms: ["facebook"], instagram_positions: ["stream"] })).rejects.toThrow(/instagram_positions/);
    await expect(propose({ adset_id: ADSET, publisher_platforms: ["myspace"] })).rejects.toThrow(/publisher_platforms/);
  });

  it("is medium risk and says it can limit delivery", async () => {
    await manual();
    const queued = await propose({ adset_id: ADSET, ...dropAudienceNetwork });
    expect(queued.risk_level).toBe("medium");
    expect(queued.risk_reason).toMatch(/delivery/i);
    expect((queued.proposed_args.__before as { placements?: { publisher_platforms?: string[] } }).placements?.publisher_platforms).toEqual([
      "facebook",
      "instagram",
      "audience_network",
    ]);
  });

  it("runs once with the approved values and logs the placements before and after", async () => {
    await manual();
    const spy = vi.spyOn(provider(), "updateAdSetPlacements");
    spy.mockClear();
    const { approval } = await run({ adset_id: ADSET, ...dropAudienceNetwork });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ account_id: ACCOUNT, adset_id: ADSET, advantage_placements: false, ...dropAudienceNetwork });
    expect(approval.status).toBe("executed");
    expect((approval.execution_result?.proof as { placements: { publisher_platforms: string[] } }).placements.publisher_platforms).toEqual(["facebook", "instagram"]);
    const [entry] = await listChanges(CLIENT_ID, 1);
    expect(entry!.before?.placements?.publisher_platforms).toEqual(["facebook", "instagram", "audience_network"]);
    expect(entry!.after?.placements?.publisher_platforms).toEqual(["facebook", "instagram"]);
  });

  it("can be rolled back to the earlier placements", async () => {
    await manual();
    await run({ adset_id: ADSET, ...dropAudienceNetwork });
    const [entry] = await listChanges(CLIENT_ID, 1);
    await rollbackChange({ changeId: entry!.id, userId: REVIEWER });
    const detail = await provider().getAdSetDetail!(ACCOUNT, ADSET);
    expect(detail?.placements.publisher_platforms).toEqual(["facebook", "instagram", "audience_network"]);
    expect(detail?.placements.audience_network_positions).toEqual(["classic"]);
  });

  it("rolling back a move to automatic placements restores the manual list", async () => {
    await manual();
    await run({ adset_id: ADSET, advantage_placements: true });
    expect((await provider().getAdSetDetail!(ACCOUNT, ADSET))?.placements.publisher_platforms).toBeNull();
    const [entry] = await listChanges(CLIENT_ID, 1);
    await rollbackChange({ changeId: entry!.id, userId: REVIEWER });
    expect((await provider().getAdSetDetail!(ACCOUNT, ADSET))?.placements.publisher_platforms).toEqual(["facebook", "instagram", "audience_network"]);
  });

  it("rolling back a move from automatic to manual restores automatic", async () => {
    await run({ adset_id: ADSET, publisher_platforms: ["facebook"] });
    const [entry] = await listChanges(CLIENT_ID, 1);
    await rollbackChange({ changeId: entry!.id, userId: REVIEWER });
    expect((await provider().getAdSetDetail!(ACCOUNT, ADSET))?.placements.publisher_platforms).toBeNull();
  });

  it("refuses to roll back over a newer change", async () => {
    await manual();
    await run({ adset_id: ADSET, ...dropAudienceNetwork });
    const [entry] = await listChanges(CLIENT_ID, 1);
    await provider().updateAdSetPlacements({ adset_id: ADSET, publisher_platforms: ["instagram"] });
    await expect(rollbackChange({ changeId: entry!.id, userId: REVIEWER })).rejects.toThrow(/changed again in Meta/);
  });

  it("refuses to run when the placements changed in Meta after it was proposed", async () => {
    await manual();
    const pending = await propose({ adset_id: ADSET, ...dropAudienceNetwork });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await provider().updateAdSetPlacements({ adset_id: ADSET, publisher_platforms: ["facebook"] });
    const spy = vi.spyOn(provider(), "updateAdSetPlacements");
    spy.mockClear();
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(/placements changed in Meta since this was proposed/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("a request that changes nothing fails the approval without touching Meta", async () => {
    await manual();
    const pending = await propose({
      adset_id: ADSET,
      publisher_platforms: ["facebook", "instagram", "audience_network"],
      facebook_positions: ["feed", "story"],
      instagram_positions: ["stream"],
      audience_network_positions: ["classic"],
    });
    await approve({ approvalId: pending.id, reviewedBy: REVIEWER });
    await expect(executeApprovedAction({ approvalId: pending.id, executedBy: REVIEWER })).rejects.toThrow(/already uses those placements/);
  });

  it("accepts ad_set_id and de-duplicates identical proposals", async () => {
    const a = await propose({ ad_set_id: ADSET, ...dropAudienceNetwork });
    expect(a.proposed_args.adset_id).toBe(ADSET);
    expect((await propose({ ad_set_id: ADSET, ...dropAudienceNetwork })).id).toBe(a.id);
  });
});
