import { describe, expect, it } from "vitest";
import { holdIncreasesOnSilentTracking } from "@/lib/agent/optimize-proposals";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";

// Demo pixel stats: Lead fires; make as_1's event silent by pointing it at a
// pixel event that recorded nothing this week.
function snapshotWithSilentAdSet() {
  const snap = demoMetaAuditSnapshot("act_1", "Demo", 7);
  snap.adSets = snap.adSets.map((a) =>
    a.id === "as_1" ? { ...a, customEventType: "COMPLETE_REGISTRATION" } : a,
  );
  return snap;
}

const increase = (name: string, args: Record<string, unknown>) => ({
  name,
  args: { account_id: "act_1", previous_daily_budget_cents: 1000, daily_budget_cents: 1200, ...args },
});

describe("holdIncreasesOnSilentTracking", () => {
  it("holds an ad set increase when its optimisation event wasn't recorded", () => {
    const { kept, heldLines } = holdIncreasesOnSilentTracking(
      [increase("update_adset_budget", { adset_id: "as_1" }), increase("update_adset_budget", { adset_id: "as_3" })],
      snapshotWithSilentAdSet(),
    );
    expect(kept.map((p) => p.args.adset_id)).toEqual(["as_3"]);
    expect(heldLines.join("\n")).toMatch(/ad set as_1/);
  });

  it("holds a campaign budget increase when any of its ad sets has silent tracking", () => {
    const { kept, heldLines } = holdIncreasesOnSilentTracking(
      [
        increase("update_campaign_budget", { campaign_id: "demo_campaign_1" }),
        increase("update_campaign_budget", { campaign_id: "demo_campaign_2" }),
      ],
      snapshotWithSilentAdSet(),
    );
    expect(kept.map((p) => p.args.campaign_id)).toEqual(["demo_campaign_2"]);
    expect(heldLines.join("\n")).toMatch(/campaign demo_campaign_1/);
  });

  it("never holds decreases or pauses", () => {
    const proposals = [
      { name: "update_campaign_budget", args: { campaign_id: "demo_campaign_1", previous_daily_budget_cents: 1000, daily_budget_cents: 800 } },
      { name: "pause_adset", args: { adset_id: "as_1" } },
    ];
    expect(holdIncreasesOnSilentTracking(proposals, snapshotWithSilentAdSet()).kept).toHaveLength(2);
  });
});
