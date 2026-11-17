import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWriterMessages, gatherDiagnoseEvidence } from "@/lib/agent/adspirer-agent";
import { COMPARISON_FRAMEWORK } from "@/lib/agent/comparison-framework";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { AuditAd, AuditCampaign, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { comparisonUserContext } from "@/lib/comparison/user-context";
import { entitySplit } from "@/lib/comparison/entities";
import { buildComparison, comparisonFindings, type ComparisonInput } from "@/lib/comparison/findings";
import { renderComparisonEvidence } from "@/lib/comparison/render";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import { resolveProvider } from "@/lib/adspirer/client";
import type { Task } from "@/types";

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

function block(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n#### /);
  return next < 0 ? rest : rest.slice(0, next);
}

const bridgeFinding = (snap: MetaAuditSnapshot) => comparisonFindings(input(snap)).find((f) => / drove /.test(f.title));

describe("bridge: materiality and direction (item 2)", () => {
  it("prints exact driver effects for a material change", () => {
    // Previous: CPM $20, CTR 1.2%, CVR 100/600. Current: spend +50% on the same impressions and clicks, 90 results.
    const snap = demo({
      totals: perf({ spendCents: 150_000, results: 90, cpmCents: 3000, costPerResultCents: 1667 }),
      previousTotals: perf(),
    });
    const c = buildComparison(input(snap));
    const cpr = c.bridges[0];
    if (!("effects" in cpr)) throw new Error("expected a bridge");
    const share = Object.fromEntries(cpr.effects.map((e) => [e.driver, e.shareOfChangePct]));
    expect(share.CPM).toBeCloseTo(79.374, 2);
    expect(share.CVR).toBeCloseTo(20.626, 2);
    expect(share.CTR).toBeCloseTo(0, 6);
    const bridge = block(renderComparisonEvidence(input(snap)), "#### Bridge");
    expect(bridge).toContain("- cost per result: $10.00 -> $16.67; drivers: CPM +$5.29 (79% of the change)");
    expect(bridge).toContain("CVR +$1.38 (21% of the change)");
    // Drivers that pull against each other get no share: "-385%" reads as an error to a client.
    expect(bridge).toContain(
      "- results: 100 -> 90; drivers: Volume +38.48 (offset by other drivers; share n/a); CPM -38.48 (offset by other drivers; share n/a)",
    );
    expect(bridge).not.toMatch(/(-\d+|(?<!\d)(?!100%)\d{3,})% of the change/);

    // The finding is the largest effect with a 0–100% share. CPM (-38.48) and Volume (+38.48) cancel out,
    // so the conversion-rate drop is the whole change; never a "385%" driver.
    const f = bridgeFinding(snap)!;
    expect(f.title).toBe("CVR drove 100% of the change in results");
    expect(f.evidence).toBe("results moved 100 -> 90; CVR -10 (100% of the change)");
    expect(f.kind).toBe("decline");
    expect(f.bucket).toBe("Investigate");
  });

  it("a bridge within the 5% materiality is flat, with no driver split and no finding", () => {
    // Results 100 -> 101 while spend and link CTR each rose 30%.
    const snap = demo({
      totals: perf({ spendCents: 130_000, linkClicks: 780, linkCtr: 1.56, results: 101, cpmCents: 2600, costPerResultCents: 1287 }),
      previousTotals: perf(),
    });
    const bridge = block(renderComparisonEvidence(input(snap)), "#### Bridge");
    expect(bridge).toContain("- results: 100 -> 101; no material change (no driver split)");
    // Before the fix the results line split a 1% move: "Volume … (2637% of the change)".
    expect(bridge).not.toMatch(/\d{4,}% of the change/);
    const findings = comparisonFindings(input(snap));
    expect(findings.some((f) => / in results$/.test(f.title))).toBe(false);
    expect(findings.some((f) => f.kind === "win" && / drove /.test(f.title))).toBe(false);
  });

  it("4% is flat; 6% is not", () => {
    const flat = demo({ totals: perf({ results: 104, costPerResultCents: 962 }), previousTotals: perf() });
    expect(block(renderComparisonEvidence(input(flat)), "#### Bridge")).toContain("- results: 100 -> 104; no material change (no driver split)");
    const moved = demo({ totals: perf({ results: 106, costPerResultCents: 943 }), previousTotals: perf() });
    expect(block(renderComparisonEvidence(input(moved)), "#### Bridge")).toContain("- results: 100 -> 106; drivers:");
  });

  it("no bridge finding when the matching KPI row is Low volume", () => {
    const snap = demo({
      totals: perf({ spendCents: 150_000, results: 15, costPerResultCents: 10_000, cpmCents: 3000 }),
      previousTotals: perf({ results: 20, costPerResultCents: 5000 }),
    });
    expect(bridgeFinding(snap)).toBeUndefined();
  });

  it("entity contribution is n/a when the account spend barely moved", () => {
    const base = demoMetaAuditSnapshot("act_1", "Demo").campaigns[0];
    const camp = (id: string, cur: number, prev: number): AuditCampaign => ({
      ...base,
      id,
      name: `Camp ${id}`,
      performance: perf({ spendCents: cur }),
      previousPerformance: perf({ spendCents: prev }),
    });
    const small = demo({
      campaigns: [camp("a", 61_000, 50_000), camp("b", 41_000, 50_000)],
      totals: perf({ spendCents: 102_000, results: 100 }),
      previousTotals: perf(),
    });
    const split = entitySplit(small);
    expect(split.likeForLike.every((e) => e.spendContributionPct === null)).toBe(true);
    expect(split.likeForLike.every((e) => e.resultsContributionPct === null)).toBe(true);

    const big = demo({
      campaigns: [camp("a", 90_000, 50_000), camp("b", 40_000, 50_000)],
      totals: perf({ spendCents: 130_000, results: 130 }),
      previousTotals: perf(),
    });
    // "a" moved by more than the net change (133%) and "b" against it (-33%): both shares are n/a.
    const parts = entitySplit(big).likeForLike;
    expect(parts.find((e) => e.id === "a")!.spendContributionPct).toBeNull();
    expect(parts.find((e) => e.id === "b")!.spendContributionPct).toBeNull();

    const within = demo({
      campaigns: [camp("a", 70_000, 50_000), camp("b", 60_000, 50_000)],
      totals: perf({ spendCents: 130_000, results: 130 }),
      previousTotals: perf(),
    });
    expect(entitySplit(within).likeForLike.find((e) => e.id === "a")!.spendContributionPct).toBeCloseTo(66.67, 1);
  });
});

describe("finding titles say the movement and the verdict (item 3)", () => {
  const titles = (current: PeriodPerformance) => comparisonFindings(input(demo({ totals: current, previousTotals: perf() }))).map((f) => f.title);

  it("CPM rose 30.0% (worse)", () => {
    const t = titles(perf({ cpmCents: 2600 }));
    expect(t).toContain("CPM rose 30.0% (worse)");
    expect(t.join("\n")).not.toMatch(/declined \(\+/);
  });

  it("Cost per result fell 12.0% (better)", () => {
    expect(titles(perf({ costPerResultCents: 880 }))).toContain("Cost per result fell 12.0% (better)");
  });

  it("Spend rose 20.0% while results rose less (worse)", () => {
    expect(titles(perf({ spendCents: 120_000, results: 105 }))).toContain("Spend rose 20.0% while results rose less (worse)");
  });

  it("Spend rose 20.0% while results fell (worse)", () => {
    expect(titles(perf({ spendCents: 120_000, results: 90 }))).toContain("Spend rose 20.0% while results fell (worse)");
  });
});

describe("ids and codes stay out of the evidence (minors)", () => {
  it("tracking finding titles carry no checkpoint code", () => {
    const i = input(demo());
    const tracking = comparisonFindings(i).filter((f) => f.kind === "tracking");
    expect(tracking.length).toBeGreaterThan(0);
    const titles = new Set(i.scorecard.checkpoints.map((c) => c.title));
    for (const t of tracking) {
      expect(titles.has(t.title)).toBe(true);
      expect(t.title).not.toMatch(/^[A-Z]\d+\s/);
    }
  });

  it("entity, stopped and fatigue lines show names without ids", () => {
    const base = demo();
    const adBase = base.ads[0] as AuditAd;
    const ads: AuditAd[] = [
      { ...adBase, id: "ad_both_1", name: "Both", performance: perf(), previousPerformance: perf() },
      { ...adBase, id: "ad_gone_1", name: "Gone ad", performance: null, previousPerformance: perf({ spendCents: 90_000 }), frequency7d: null },
      { ...adBase, id: "ad_tired_1", name: "Tired ad", performance: perf({ linkCtr: 0.8 }), previousPerformance: perf({ linkCtr: 1.2 }), frequency7d: 3.6 },
    ];
    const snap = { ...base, ads, previousTotals: perf({ spendCents: 360_000 }) };
    const text = renderComparisonEvidence(input(snap));
    for (const id of ["ad_both_1", "ad_gone_1", "ad_tired_1", "demo_campaign_1"]) expect(text).not.toContain(id);
    const f = comparisonFindings(input(snap));
    expect(f.find((x) => x.kind === "structure")!.evidence).toMatch(/^ad Gone ad spent/);
    expect(f.find((x) => x.title === "Creative fatigue: Tired ad")!.evidence).toMatch(/^Ad Tired ad: Link CTR/);
  });

  it("KPI rows say n/a (no previous delivery) when the previous window spent nothing", () => {
    const zero = perf({ spendCents: 0, impressions: 0, linkClicks: 0, results: 0 });
    const kpi = block(renderComparisonEvidence(input(demo({ totals: perf(), previousTotals: zero }))), "#### KPI scorecard");
    const spend = kpi.split("\n").find((l) => l.startsWith("| Spend "))!;
    expect(spend.split("|").map((c) => c.trim()).slice(3, 6)).toEqual(["n/a (no previous delivery)", "n/a", "n/a"]);
    const none = block(renderComparisonEvidence(input(demo({ totals: perf(), previousTotals: null }))), "#### KPI scorecard");
    expect(none.split("\n").find((l) => l.startsWith("| Results "))).toContain("| n/a (no previous delivery) |");
  });
});

describe("scope and windows lines (item 4)", () => {
  it("prints the exact Current / Previous / Scope lines for the whole account", () => {
    const w = block(renderComparisonEvidence(input(demo())), "#### Windows");
    expect(w).toMatch(/^- \*\*Current:\*\* \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} \(\d+ days\)$/m);
    expect(w).toMatch(/^- \*\*Previous:\*\* \d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} \(\d+ days\)$/m);
    expect(w).toContain("- **Scope:** whole account");
  });

  it("names the campaigns on a scoped snapshot", () => {
    const scoped = demo({ scope: { campaigns: [{ id: "demo_campaign_1", name: "Implants" }, { id: "demo_campaign_2", name: "Veneers" }] } });
    expect(block(renderComparisonEvidence(input(scoped)), "#### Windows")).toContain("- **Scope:** campaigns: Implants, Veneers");
  });

  it("every evidence block the framework names is in the rendered evidence", () => {
    const facts = COMPARISON_FRAMEWORK.slice(COMPARISON_FRAMEWORK.indexOf("## Where the facts come from"), COMPARISON_FRAMEWORK.indexOf("## Hard rules"));
    const names = [...facts.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(14);
    const text = renderComparisonEvidence(input(demo()));
    for (const n of names) expect(text, n).toContain(`#### ${n}`);
  });
});

describe("objective mix (item 5)", () => {
  const camp = (id: string, objective: string, spend: number): AuditCampaign => ({
    ...demoMetaAuditSnapshot("act_1", "Demo").campaigns[0],
    id,
    name: `Camp ${id}`,
    objective,
    performance: perf({ spendCents: spend }),
    previousPerformance: perf({ spendCents: spend }),
  });

  it("labels results rows and bridges 'all objectives combined' when no objective has 90% of spend", () => {
    const snap = demo({
      campaigns: [camp("s", "OUTCOME_SALES", 60_000), camp("l", "OUTCOME_LEADS", 30_000), camp("t", "OUTCOME_TRAFFIC", 10_000)],
      totals: perf({ spendCents: 100_000, results: 80, costPerResultCents: 1250 }),
      previousTotals: perf(),
    });
    const text = renderComparisonEvidence(input(snap));
    const mix = block(text, "#### Objective mix");
    expect(mix).toContain("- Sales: 60.0% of current spend");
    expect(mix).toContain("- Leads: 30.0% of current spend");
    expect(mix).toContain("- Other: 10.0% of current spend");
    expect(mix).toContain("all objectives combined");
    const kpi = block(text, "#### KPI scorecard");
    expect(kpi).toMatch(/^\| Results \(all objectives combined\) \|/m);
    expect(kpi).toMatch(/^\| Cost per result \(all objectives combined\) \|/m);
    const bridge = block(text, "#### Bridge");
    expect(bridge).toContain("- cost per result (all objectives combined):");
    expect(bridge).toContain("- results (all objectives combined):");
  });

  it("no label when one objective carries 90% or more", () => {
    const snap = demo({
      campaigns: [camp("l", "OUTCOME_LEADS", 95_000), camp("t", "OUTCOME_TRAFFIC", 5_000)],
      totals: perf({ results: 80, costPerResultCents: 1250 }),
      previousTotals: perf(),
    });
    const text = renderComparisonEvidence(input(snap));
    expect(text).not.toContain("all objectives combined");
    expect(block(text, "#### Objective mix")).toContain("- Leads: 95.0% of current spend");
  });

  it("the framework tells the writer not to present a blended cost per result as one objective's", () => {
    expect(COMPARISON_FRAMEWORK).toContain("all objectives combined");
    const s0 = COMPARISON_FRAMEWORK.slice(COMPARISON_FRAMEWORK.indexOf("## 0."), COMPARISON_FRAMEWORK.indexOf("## 1."));
    const s3 = COMPARISON_FRAMEWORK.slice(COMPARISON_FRAMEWORK.indexOf("## 3."), COMPARISON_FRAMEWORK.indexOf("## 4."));
    expect(s0).toMatch(/Objective mix/);
    expect(s3).toMatch(/all objectives combined/);
  });
});

describe("comparison writer rules (items 4, 6 and minors)", () => {
  const rules = (toolEvidence: string) => {
    const task = { goal: "compare last 14 days", title: "compare" } as Task;
    return buildWriterMessages({ task, clientContext: "", intent: "comparison", toolEvidence, history: [] }).messages.at(-1)!.content;
  };

  it("no comparison evidence is treated as unavailable: no sections, no numbers", () => {
    const text = rules("No granted Meta Account is mapped to this client.");
    expect(text).toMatch(/The comparison can't be built/);
    expect(text).toMatch(/no sections/i);
    expect(text).not.toContain("Write the comparison report with the headings");
  });

  it("drops the tool escape hatch and states the scope fallback", () => {
    const text = rules("### Comparison evidence — X\n#### Windows\n### Comparison scope\n- No campaign matched \"Foo\", so this report covers the whole account.");
    expect(text).not.toMatch(/use one only if a figure/);
    expect(text).toMatch(/Comparison scope/);
    expect(text).toContain("Write the comparison report with the headings");
  });
});

describe("comparison turns in DEMO_MODE (items 4 and 6)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetDemoStore();
  });

  it("a client with no Meta account gets an unavailable notice, not the framework", async () => {
    const store = getDemoStore();
    store.connectedMetaAccounts = store.connectedMetaAccounts.filter((a) => a.client_id !== "client_modern_dental");
    const gathered = await gatherDiagnoseEvidence({ clientId: "client_modern_dental", request: "compare last 14 days with the 14 before", intent: "comparison" });
    expect(gathered.evidence).not.toContain("### Comparison evidence —");
    expect(gathered.evidence).not.toContain("### Comparison framework");
    const task = { goal: "compare", title: "compare" } as Task;
    const text = buildWriterMessages({ task, clientContext: "", intent: "comparison", toolEvidence: gathered.evidence, history: [] }).messages.at(-1)!.content;
    expect(text).toMatch(/The comparison can't be built/);
  });

  it("a campaign-scoped comparison prints its scope", async () => {
    // The mock provider's campaign list uses other ids than its snapshot; list the snapshot's campaigns.
    const provider = await resolveProvider();
    const listed = demoMetaAuditSnapshot("act_1", "Demo").campaigns.map((c) => ({ id: c.id, name: c.name, status: "ACTIVE" }));
    vi.spyOn(provider, "listCampaigns").mockResolvedValue(listed as unknown as Awaited<ReturnType<typeof provider.listCampaigns>>);
    const gathered = await gatherDiagnoseEvidence({
      clientId: "client_modern_dental",
      request: "compare campaign Veneers Advantage+ for the last 14 days vs the 14 before",
      intent: "comparison",
    });
    expect(gathered.evidence).toContain("- **Scope:** campaigns: Veneers Advantage+");
    expect(gathered.toolCalls.find((c) => c.name === "comparison_report")?.args).toMatchObject({ campaign_ids: ["demo_campaign_2"] });
  });
});

describe("user context (item 8)", () => {
  it("ignores comparison wording that only mentions sales", () => {
    expect(comparisonUserContext("compare sales results Oct vs Sep")).toBeNull();
    expect(comparisonUserContext("compare last 14 days with the 14 before")).toBeNull();
    expect(comparisonUserContext("how did sales and prices look this month vs last month")).toBeNull();
  });

  it("keeps what the operator said about the business", () => {
    expect(comparisonUserContext("compare Oct vs Sep — we ran a 20% off sale in October")).toBe("we ran a 20% off sale in October");
    expect(comparisonUserContext("compare last 14 days. Two products were out of stock last week")).toBe("Two products were out of stock last week");
    expect(comparisonUserContext("compare Oct vs Sep, we launched a new range on 10 Oct")).toBe("we launched a new range on 10 Oct");
    expect(comparisonUserContext("compare this month to last; there was a price increase on the 5th")).toBe("there was a price increase on the 5th");
  });
});
