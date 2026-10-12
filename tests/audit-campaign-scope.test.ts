import { describe, expect, it } from "vitest";
import { resolveAuditBrief, resolveAuditCampaigns } from "@/lib/agent/audit-brief";
import { detectRequestIntent } from "@/lib/agent/task-plan";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { demoMetaAuditSnapshot, scopeAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { renderAdSetEvidence, renderScorecardMarkdown } from "@/lib/audit/render";

const campaigns = [
  { id: "120249373802720685", name: "TR | Lead Gen Traffic Radius | Sep 2026", status: "ACTIVE" },
  { id: "120200000000000001", name: "TR | Old Leads | Jun 2026", status: "PAUSED" },
  { id: "120200000000000002", name: "TR | Brand | Aug 2026", status: "PAUSED" },
];

describe("audit brief: 'the active campaign'", () => {
  it.each([
    "Audit the active campaign from 9th sept to 12th sept",
    "audit the live ad sets of the active campaign from 9th sept to 12th sept",
    "Audit all live campaigns for 9 Sep to 12 Sep",
    "audit the campaigns that are running from 9th sept to 12th sept",
  ])("%s → ready, scoped to active campaigns", (text) => {
    expect(detectRequestIntent(text)).toBe("audit");
    const brief = resolveAuditBrief(text);
    expect(brief.scope).toBe("campaigns");
    expect(brief.activeCampaigns).toBe(true);
    expect(brief.campaignHints).toEqual([]);
    expect(brief.missing).toEqual([]);
    expect(brief.ready).toBe(true);
    expect(brief.dateStart).toMatch(/-09-09$/);
    expect(brief.dateStop).toMatch(/-09-12$/);
  });

  it("a named campaign is not an 'active campaigns' request", () => {
    const brief = resolveAuditBrief("Audit campaign TR | Brand | Aug 2026 for last 7 days");
    expect(brief.activeCampaigns).toBe(false);
    expect(brief.campaignHints).toEqual(["TR | Brand | Aug 2026"]);
  });

  it("keeps a campaign name that contains a month", () => {
    const brief = resolveAuditBrief(
      "Audit campaign TR | Lead Gen Traffic Radius | Sep 2026 from 9th sept to 12th sept",
    );
    expect(brief.campaignHints).toEqual(["TR | Lead Gen Traffic Radius | Sep 2026"]);
    expect(resolveAuditCampaigns(campaigns, brief).map((c) => c.id)).toEqual(["120249373802720685"]);
    expect(brief.ready).toBe(true);
  });

  it("resolves to the live campaigns, plus any named ones", () => {
    const active = resolveAuditBrief("Audit the active campaign last 7 days");
    expect(resolveAuditCampaigns(campaigns, active).map((c) => c.id)).toEqual(["120249373802720685"]);

    const both = { ...active, campaignHints: ["TR | Brand | Aug 2026"] };
    expect(resolveAuditCampaigns(campaigns, both).map((c) => c.id)).toEqual([
      "120200000000000002",
      "120249373802720685",
    ]);
  });

  it("finds nothing when no campaign is live", () => {
    const brief = resolveAuditBrief("Audit the active campaign last 7 days");
    const paused = campaigns.map((c) => ({ ...c, status: "PAUSED" }));
    expect(resolveAuditCampaigns(paused, brief)).toEqual([]);
  });
});

describe("campaign-scoped audit snapshot", () => {
  const snap = demoMetaAuditSnapshot("act_1", "Demo", 4);

  it("keeps only the scoped campaigns, their ad sets and ads", () => {
    const scoped = scopeAuditSnapshot(snap, ["demo_campaign_1"]);
    expect(scoped.campaigns.map((c) => c.id)).toEqual(["demo_campaign_1"]);
    expect(scoped.adSets.map((a) => a.id)).toEqual(["as_1", "as_2"]);
    expect(scoped.ads.map((a) => a.id)).toEqual(["ad_1", "ad_2", "ad_3"]);
    expect(scoped.totals?.spendCents).toBe(178_000);
    expect(scoped.totals?.results).toBe(49);
    expect(scoped.scope?.campaigns).toEqual([{ id: "demo_campaign_1", name: "Implants | Leads | Broad | Oct" }]);
    // Account-wide placement split would misattribute other campaigns' spend.
    expect(scoped.placements).toEqual([]);
  });

  it("sums totals across several scoped campaigns", () => {
    const scoped = scopeAuditSnapshot(snap, ["demo_campaign_1", "demo_campaign_3"]);
    expect(scoped.totals?.spendCents).toBe(178_000 + 76_000);
    expect(scoped.totals?.results).toBe(49 + 14);
    expect(scoped.totals?.costPerResultCents).toBe(Math.round((178_000 + 76_000) / 63));
  });

  it("scorecard states the campaign scope", () => {
    const scoped = scopeAuditSnapshot(snap, ["demo_campaign_1"]);
    const md = renderScorecardMarkdown(evaluateCheckpoints(scoped), scoped);
    expect(md).toContain("Implants | Leads | Broad | Oct");
  });
});

describe("ad set evidence", () => {
  it("lists every ad set in scope with its period numbers and setup", () => {
    const scoped = scopeAuditSnapshot(demoMetaAuditSnapshot("act_1", "Demo", 4), ["demo_campaign_1"]);
    const text = renderAdSetEvidence(scoped);
    expect(text).toContain("### Ad sets");
    expect(text).toContain("Implants – Broad AU 30-65 (as_1)");
    expect(text).toContain("Implants – Interests: dental (as_2)");
    expect(text).toContain("Learning limited");
    expect(text).toContain("$1,180"); // as_1 spend
    expect(text).toContain("38 Leads");
    expect(text).toContain("live ads 2 of 2");
    expect(text).not.toContain("as_3");
  });

  it("says so when the campaign has no ad sets", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 4);
    const scoped = scopeAuditSnapshot({ ...snap, adSets: [] }, ["demo_campaign_1"]);
    expect(renderAdSetEvidence(scoped)).toMatch(/No ad sets/i);
  });
});
