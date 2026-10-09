import { describe, expect, it } from "vitest";
import {
  adSetsWithSilentTracking,
  evaluateCheckpoints,
  type Checkpoint,
} from "@/lib/audit/checkpoints";
import {
  demoMetaAuditSnapshot,
  type AuditAdSet,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";
import { renderScorecardEvidence, renderScorecardMarkdown } from "@/lib/audit/render";
import { evaluateHealth, healthWindow, type HealthSnapshot } from "@/lib/monitoring/health";

const NOW = new Date();
const get = (cps: Checkpoint[], id: string) => cps.find((c) => c.id === id);

function perf(over: Partial<PeriodPerformance> = {}): PeriodPerformance {
  return {
    spendCents: 45_600,
    impressions: 3_500,
    reach: 2_200,
    frequency: 1.6,
    linkCtr: 0.82,
    cpmCents: 13_000,
    results: 0,
    resultLabel: "Registrations",
    costPerResultCents: null,
    roas: null,
    ...over,
  };
}

/** Mirrors a real account: campaign on, ad sets off, registrations firing on site but not credited. */
function trAccount(): MetaAuditSnapshot {
  const base = demoMetaAuditSnapshot("act_1", "TR Internal Marketing", 30);
  const adSet = (id: string, name: string): AuditAdSet => ({
    ...base.adSets[0]!,
    id,
    name,
    campaignId: "c1",
    status: "PAUSED",
    pixelId: "px",
    customEventType: "COMPLETE_REGISTRATION",
    attributionWindows: id === "a3" ? ["7d_click"] : ["7d_click", "1d_view"],
    performance: perf(),
  });
  return {
    ...base,
    demo: false,
    pixels: [
      {
        id: "px",
        name: "TR-Master_Pixel",
        lastFiredTime: NOW.toISOString(),
        automaticMatching: true,
        stats7d: { events: { PageView: 40, Lead: 3 }, serverShare: 0.53, piiShare: { Lead: 0.77 } },
        stats28d: {
          events: { PageView: 986, Lead: 198, CompleteRegistration: 82 },
          serverShare: 0.5,
          piiShare: { CompleteRegistration: 0.68, Lead: 0.77 },
        },
      },
    ],
    campaigns: [
      { ...base.campaigns[0]!, id: "c1", name: "TR | Lead Gen Traffic Radius | Sep 2026", status: "ACTIVE", dailyBudgetCents: 3_000 },
    ],
    adSets: [adSet("a1", "Broad - Job title | Google Scale"), adSet("a2", "Broad - Job title | Google consult"), adSet("a3", "Broad Aud. - Job title | Google Audit")],
    ads: [
      { ...base.ads[0]!, id: "x1", adSetId: "a2", campaignId: "c1", status: "DISAPPROVED", name: "Video Ad | Consult | Oct 2026", issue: null },
    ],
    audiences: [],
  };
}

describe("evaluateCheckpoints", () => {
  it("catches the tracking and delivery problems of a real account", () => {
    const card = evaluateCheckpoints(trAccount(), { now: NOW });
    const cps = card.checkpoints;
    expect(get(cps, "T2")).toMatchObject({ status: "warn" }); // registrations fired earlier, not this week
    expect(get(cps, "T3")).toMatchObject({ status: "fail", severity: "high" });
    expect(get(cps, "T3")!.evidence).toContain("82 CompleteRegistration events");
    expect(get(cps, "T4")).toMatchObject({ status: "pass" });
    expect(get(cps, "T6")).toMatchObject({ status: "warn" }); // 68% < 70%
    expect(get(cps, "T8")).toMatchObject({ status: "warn" }); // mixed attribution
    expect(get(cps, "S1")).toMatchObject({ status: "fail", severity: "critical" });
    expect(get(cps, "C1")).toMatchObject({ status: "fail" }); // rejected ad in a live campaign
    expect(get(cps, "F1")).toMatchObject({ status: "warn" }); // no retargeting
    expect(card.priorities[0]!.status).toBe("fail");
    expect(card.score).toBeLessThan(70);
  });

  it("flags browser-only tracking, low customer-info share and learning-limited ad sets in the demo", () => {
    const card = evaluateCheckpoints(demoMetaAuditSnapshot("act_demo", "Demo", 30), { now: NOW });
    const cps = card.checkpoints;
    expect(get(cps, "T4")).toMatchObject({ status: "fail" });
    expect(get(cps, "T6")).toMatchObject({ status: "warn" }); // 44%: below 70% target, above 40% floor
    expect(get(cps, "T7")).toMatchObject({ status: "warn" });
    expect(get(cps, "B1")).toMatchObject({ status: "warn" });
    expect(get(cps, "A2")).toMatchObject({ status: "warn" }); // no customer exclusions
    expect(get(cps, "A3")).toMatchObject({ status: "warn" }); // 820-person audience
    expect(get(cps, "C1")).toMatchObject({ status: "fail" });
    expect(get(cps, "F2")).toMatchObject({ status: "warn" }); // prospecting ad set at 3.9 in 7 days
    expect(get(cps, "F2")!.evidence).toContain("Veneers – Advantage+ audience (3.9 in 7 days, prospecting)");
    expect(get(cps, "F2")!.evidence).not.toContain("Retargeting –"); // 4.2 is fine for retargeting
    expect(card.byCategory.map((c) => c.category)).toContain("Funnel & frequency");
  });

  it("passes a clean account", () => {
    const snap = demoMetaAuditSnapshot("act_ok", "Clean", 7);
    snap.pixels = [
      {
        ...snap.pixels[0]!,
        automaticMatching: true,
        stats7d: { events: { Lead: 60 }, serverShare: 0.5, piiShare: { Lead: 0.85 } },
        stats28d: { events: { Lead: 240 }, serverShare: 0.5, piiShare: { Lead: 0.85 } },
      },
    ];
    snap.audiences = [];
    snap.ads = snap.ads.filter((a) => a.status === "ACTIVE");
    snap.adSets = snap.adSets.map((a) => ({
      ...a,
      learningStatus: "SUCCESS",
      bidStrategy: "LOWEST_COST_WITHOUT_CAP",
      attributionWindows: ["7d_click", "1d_view"],
      publisherPlatforms: ["facebook", "instagram"],
      performance: perf({ results: 40, frequency: 2, linkCtr: 1.1 }),
    }));
    const card = evaluateCheckpoints(snap, { now: NOW });
    expect(card.counts.fail).toBe(0);
    expect(get(card.checkpoints, "T2")).toMatchObject({ status: "pass" });
  });
});

describe("scoring", () => {
  it("weights by severity, halves warnings, and leaves note-only areas unscored", () => {
    const card = evaluateCheckpoints(trAccount(), { now: NOW });
    const scored = card.checkpoints.filter((c) => c.status !== "info" && c.status !== "not_checked");
    const weights = { critical: 10, high: 6, medium: 3, low: 1 } as const;
    const possible = scored.reduce((s, c) => s + weights[c.severity], 0);
    const earned = scored.reduce(
      (s, c) => s + (c.status === "pass" ? weights[c.severity] : c.status === "warn" ? weights[c.severity] / 2 : 0),
      0,
    );
    expect(card.possible).toBe(possible);
    expect(card.earned).toBe(earned);
    expect(card.score).toBe(Math.round((earned / possible) * 100));
    for (const area of card.byCategory) {
      if (area.possible === 0) expect(area.score).toBeNull();
      else expect(area.score).toBe(Math.round((area.earned / area.possible) * 100));
    }
  });
});

describe("adSetsWithSilentTracking", () => {
  it("lists ad sets whose optimisation event didn't fire this week", () => {
    const silent = adSetsWithSilentTracking(trAccount());
    expect([...silent.keys()]).toEqual(["a1", "a2", "a3"]);
    expect(silent.get("a1")).toBe("CompleteRegistration");
  });
});

describe("scorecard rendering", () => {
  it("renders an exportable checklist table and authoritative evidence", () => {
    const snap = trAccount();
    const card = evaluateCheckpoints(snap, { now: NOW });
    const md = renderScorecardMarkdown(card, snap);
    expect(md).toMatch(/^## Audit checklist/);
    expect(md).toContain("### How the score works");
    expect(md).toContain("| Area | Score | Points | Checkpoints in this area | What lowered the score |");
    expect(md).toContain("| ID | Checkpoint | Result | Points | Evidence | Fix |");
    // Each area lists its checkpoints and what cost it points.
    expect(md).toMatch(/\| Account structure \| \d+\/100 \| [\d.]+ of [\d.]+ \| [^|]*S1 Fail[^|]*\| S1 Fail \(−10\)/);
    expect(md).toContain("### Account structure —");
    expect(md).toMatch(/\| S1 \| Live campaigns have live ad sets \| Fail · Critical \| 0 of 10 \|/);
    // Pipes inside names must not break the table.
    expect(md).not.toContain("TR | Lead Gen");
    const evidence = renderScorecardEvidence(card, snap);
    expect(evidence).toContain("authoritative");
    expect(evidence).toContain("[S1] FAIL");
  });
});

describe("monitoring tracking check", () => {
  it("raises a critical alert when a live ad set's event stops firing", () => {
    const zero = { spendCents: 0, impressions: 0, linkClicks: 0, linkCtr: 0, cpmCents: null, frequency: 0, results: null, resultLabel: "Results", costPerResultCents: null };
    const snap: HealthSnapshot = {
      account: { id: "act_1", name: "A", currency: "AUD", timezone: "UTC", statusLabel: "Active", statusProblem: false, disableReason: null, amountSpentCents: 0, spendCapCents: null },
      window: healthWindow("2026-10-09", 7),
      current: { ...zero, spendCents: 20_000 },
      previous: { ...zero, spendCents: 20_000 },
      dailyAllottedCents: 0,
      activeCampaigns: 1,
      campaigns: [],
      adIssues: [],
      tracking: [{ pixelId: "px", eventName: "Lead", events7d: 0, adSetNames: ["Prospecting"] }],
      warnings: [],
      fetchedAt: NOW.toISOString(),
    };
    const f = evaluateHealth(snap).findings.find((x) => x.code === "TRACKING_STOPPED")!;
    expect(f.severity).toBe("critical");
    expect(f.title).toBe("No Lead events recorded this week");
  });
});
