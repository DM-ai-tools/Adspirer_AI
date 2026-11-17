import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { AuditAd, AuditChange, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { moneyFor } from "@/lib/audit/render";
import { kpiRows } from "@/lib/comparison/kpis";
import {
  buildComparison,
  comparisonFindings,
  formatKpiRow,
  type ComparisonInput,
} from "@/lib/comparison/findings";
import { renderComparisonEvidence } from "@/lib/comparison/render";

const TODAY = "2026-11-17";

function perf(over: Partial<PeriodPerformance> = {}): PeriodPerformance {
  return {
    spendCents: 100_000,
    impressions: 50_000,
    reach: 30_000,
    frequency: 1.6,
    linkCtr: 1.2,
    cpmCents: 2000,
    results: 100,
    resultLabel: "Leads",
    costPerResultCents: 1000,
    roas: null,
    linkClicks: 600,
    landingPageViews: 500,
    ...over,
  };
}

function demo(over: Partial<MetaAuditSnapshot> = {}): MetaAuditSnapshot {
  const base = demoMetaAuditSnapshot("act_1", "Demo Dental", { comparisonDetail: true, until: "2026-11-10", days: 30 });
  return { ...base, ...over } as MetaAuditSnapshot;
}

function input(snapshot: MetaAuditSnapshot, over: Partial<ComparisonInput> = {}): ComparisonInput {
  return {
    snapshot,
    today: TODAY,
    scorecard: evaluateCheckpoints(snapshot, { now: new Date(`${TODAY}T00:00:00Z`) }),
    userContext: null,
    ...over,
  };
}

const HEADINGS = [
  "#### Windows",
  "#### Settings",
  "#### KPI scorecard",
  "#### Bridge",
  "#### Funnel",
  "#### Entities",
  "#### Creative",
  "#### Breakdown shifts",
  "#### Changes",
  "#### Tracking",
  "#### User context",
  "#### Failed to load",
  "#### Findings",
  "#### Thresholds",
];

function block(text: string, heading: string): string {
  const start = text.indexOf(`${heading}`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n#### /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("renderComparisonEvidence", () => {
  it("starts with the account title and has every sub-block", () => {
    const text = renderComparisonEvidence(input(demo()));
    expect(text.startsWith("### Comparison evidence — Demo Dental")).toBe(true);
    for (const h of HEADINGS) expect(text, h).toContain(h);
  });

  it("prints n/a (never a percent) when the previous value is missing", () => {
    const snap = demo({ totals: perf({ purchases: 5 }), previousTotals: perf() });
    const text = renderComparisonEvidence(input(snap));
    const row = block(text, "#### KPI scorecard")
      .split("\n")
      .find((l) => l.startsWith("| Purchases "));
    expect(row).toBeDefined();
    const cells = row!.split("|").map((c) => c.trim());
    // ["", metric, current, previous, delta, deltaPct, status, ""]
    expect(cells[3]).toBe("n/a");
    expect(cells[4]).toBe("n/a");
    expect(cells[5]).toBe("n/a");
    expect(cells[6]).toMatch(/Low volume - not a trend/);
  });

  it("scorecard rows carry exactly the numbers kpiRows computes", () => {
    const snap = demo({
      totals: perf({ spendCents: 120_000, purchases: 40, purchaseValueCents: 300_000, roas: 2.5 }),
      previousTotals: perf({ spendCents: 100_000, purchases: 35, purchaseValueCents: 245_000, roas: 2.45 }),
    });
    const i = input(snap, { businessModel: "ecommerce" });
    const built = buildComparison(i);
    const money = moneyFor(snap.account.currency);
    const table = block(renderComparisonEvidence(i), "#### KPI scorecard");
    expect(built.kpis.length).toBeGreaterThan(5);
    for (const row of built.kpis) expect(table).toContain(formatKpiRow(row, money));
    const spend = built.kpis.find((r) => r.metric === "Spend")!;
    expect(table).toContain(`| Spend | ${money(spend.current!)} | ${money(spend.previous!)} |`);
    const ctr = built.kpis.find((r) => r.metric === "Link CTR")!;
    expect(table).toContain(`${ctr.current!.toFixed(2)}%`);
    // The same rows kpiRows returns directly.
    expect(built.kpis).toEqual(kpiRows(snap, built.windows, built.type, built.breaks));
  });

  it("lists a failed part under Failed to load", () => {
    const snap = demo({ comparisonFailures: ["ads"], warnings: ["Ad performance: boom"] });
    const failed = block(renderComparisonEvidence(input(snap)), "#### Failed to load");
    expect(failed).toContain("ads: failed to load");
    expect(failed).toContain("Ad performance: boom");
  });

  it("says none supplied when there is no user context, and echoes it otherwise", () => {
    const none = block(renderComparisonEvidence(input(demo())), "#### User context");
    expect(none).toContain("none supplied");
    const some = block(renderComparisonEvidence(input(demo(), { userContext: "We paused Meta in week 2" })), "#### User context");
    expect(some).toContain("We paused Meta in week 2");
  });

  it("labels breakdown shifts as whole account on a campaign-scoped snapshot", () => {
    const scoped = demo({ scope: { campaigns: [{ id: "demo_campaign_1", name: "Implants" }] } });
    expect(renderComparisonEvidence(input(scoped))).toContain("#### Breakdown shifts (whole account)");
    expect(renderComparisonEvidence(input(demo()))).not.toContain("(whole account)");
  });

  it("splits ads into like-for-like, New and Stopped, and says why when there are no bridges", () => {
    const base = demo();
    const adBase = base.ads[0] as AuditAd;
    const ads: AuditAd[] = [
      { ...adBase, id: "a1", name: "Both", performance: perf(), previousPerformance: perf() },
      { ...adBase, id: "a2", name: "Fresh", performance: perf(), previousPerformance: null },
      { ...adBase, id: "a3", name: "Gone", performance: null, previousPerformance: perf() },
    ];
    const text = renderComparisonEvidence(input({ ...base, ads, previousTotals: null }));
    const entities = block(text, "#### Entities");
    for (const label of ["Like-for-like", "New", "Stopped"]) expect(entities).toContain(label);
    expect(entities.indexOf("Like-for-like")).toBeLessThan(entities.indexOf("New"));
    expect(entities.indexOf("New")).toBeLessThan(entities.indexOf("Stopped"));
    const creative = block(text, "#### Creative");
    expect(creative).toContain("Fresh");
    expect(creative).toContain("Gone");
    expect(block(text, "#### Bridge")).toMatch(/not available|unavailable/i);
  });

  it("prints no material change instead of shares when the metric did not move", () => {
    const snap = demo({ totals: perf(), previousTotals: perf({ spendCents: 100_010, results: 100 }) });
    const bridge = block(renderComparisonEvidence(input(snap)), "#### Bridge");
    expect(bridge).toContain("no material change");
  });

  it("rounds bridge shares to whole percents", () => {
    const snap = demo({
      totals: perf({ spendCents: 150_000, results: 90, impressions: 40_000, linkClicks: 500 }),
      previousTotals: perf(),
    });
    const bridge = block(renderComparisonEvidence(input(snap)), "#### Bridge");
    expect(bridge).toMatch(/\(-?\d+% of the change\)/);
    expect(bridge).not.toMatch(/\d+\.\d+% of the change/);
  });
});

describe("comparisonFindings", () => {
  const change = (over: Partial<AuditChange>): AuditChange =>
    ({
      localDate: "2026-11-05",
      eventType: "update_ad_set_attribution_spec",
      label: "Changed attribution",
      objectName: "Implants – Broad",
      detail: "attribution_spec",
      ...over,
    }) as AuditChange;

  it("gives identical ids and content for the same input", () => {
    const i = input(demo());
    const a = comparisonFindings(i);
    const b = comparisonFindings(i);
    expect(a).toEqual(b);
    expect(a.map((f) => f.id)).toEqual(a.map((_, n) => `CMP-${String(n + 1).padStart(3, "0")}`));
  });

  it("orders measurement, tracking, declines, bridge, stopped, fatigue, then wins", () => {
    const snap = demo({
      changes: [change({})],
      totals: perf({ spendCents: 150_000, results: 70, purchases: 70 }),
      previousTotals: perf({ results: 100, purchases: 100 }),
    });
    const kinds = comparisonFindings(input(snap)).map((f) => f.kind);
    expect(kinds[0]).toBe("measurement");
    const firstDecline = kinds.indexOf("decline");
    const firstWin = kinds.indexOf("win");
    const lastTracking = kinds.lastIndexOf("tracking");
    expect(kinds.indexOf("measurement")).toBeLessThan(firstDecline);
    if (lastTracking >= 0) expect(lastTracking).toBeLessThan(firstDecline);
    if (firstWin >= 0) expect(firstWin).toBeGreaterThan(firstDecline);
  });

  it("maps measurement breaks and tracking fails to Fix tracking", () => {
    const f = comparisonFindings(input(demo({ changes: [change({})] })));
    const m = f.find((x) => x.kind === "measurement")!;
    expect(m.bucket).toBe("Fix tracking");
    expect(m.evidence).toContain("2026-11-05");
    for (const t of f.filter((x) => x.kind === "tracking")) expect(t.bucket).toBe("Fix tracking");
  });

  it("orders declined KPIs by absolute change, largest first", () => {
    const snap = demo({
      totals: perf({ spendCents: 100_000, results: 60, costPerResultCents: 1667, cpmCents: 2600, linkCtr: 1.1 }),
      previousTotals: perf(),
    });
    const f = comparisonFindings(input(snap)).filter((x) => x.kind === "decline" && /\(worse\)$/.test(x.title));
    expect(f.length).toBeGreaterThan(1);
    const pcts = f.map((x) => Math.abs(Number(/(-?\d+(?:\.\d)?)%/.exec(x.title)?.[1] ?? 0)));
    expect(pcts).toEqual([...pcts].sort((a, b) => b - a));
  });

  it("flags a stopped entity that held at least 5% of previous spend, and fatigue", () => {
    const base = demo();
    const adBase = base.ads[0] as AuditAd;
    const ads: AuditAd[] = [
      { ...adBase, id: "gone", name: "Gone ad", performance: null, previousPerformance: perf({ spendCents: 90_000 }), frequency7d: null },
      { ...adBase, id: "tired", name: "Tired ad", performance: perf({ linkCtr: 0.8 }), previousPerformance: perf({ linkCtr: 1.2 }), frequency7d: 3.6 },
    ];
    const f = comparisonFindings(input({ ...base, ads, previousTotals: perf({ spendCents: 360_000 }) }));
    const stopped = f.find((x) => x.kind === "structure");
    expect(stopped?.title).toContain("Gone ad");
    expect(stopped?.bucket).toBe("Budget");
    const tired = f.find((x) => x.bucket === "Creative" && x.title.includes("Tired ad"));
    expect(tired).toBeDefined();
    expect(f.findIndex((x) => x.kind === "structure")).toBeLessThan(f.indexOf(tired!));
  });
});
