import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot, type AuditAdSet, type MetaAuditSnapshot, type PeriodPerformance } from "@/lib/audit/meta-audit-data";
import {
  accountGoal,
  baselineOf,
  judgeTarget,
  leversOf,
  proposeTargets,
} from "@/lib/strategy/account-strategy";
import { renderStrategyPlanEvidence, renderTargetProposalEvidence } from "@/lib/strategy/account-strategy-render";
import {
  STRATEGY_TARGET_MARKER,
  parseStatedTarget,
  pickedOption,
  resolveStrategyTarget,
  strategyPeriod,
  strategyTargetClosing,
  wantsBudgetPlan,
} from "@/lib/agent/account-strategy-brief";
import { detectRequestIntentWithHistory } from "@/lib/agent/task-plan";

const perf = (spend: number, leads: number, over: Partial<PeriodPerformance> = {}): PeriodPerformance => ({
  spendCents: spend,
  impressions: 10_000,
  reach: 5_000,
  frequency: 2,
  linkCtr: 1,
  cpmCents: 1_000,
  results: leads,
  resultLabel: "Leads",
  costPerResultCents: leads ? Math.round(spend / leads) : null,
  roas: null,
  leads,
  ...over,
});

/** A lead account whose business type was never set: 3 ad sets, one wasting, one winning. */
function leadAccount(): MetaAuditSnapshot {
  const base = demoMetaAuditSnapshot("act_1", "Clinic", 30);
  const adSet = (id: string, name: string, p: PeriodPerformance): AuditAdSet => ({ ...base.adSets[0]!, id, name, campaignId: "c1", status: "ACTIVE", learningStatus: "SUCCESS", performance: p });
  return {
    ...base,
    campaigns: [{ ...base.campaigns[0]!, id: "c1", objective: "OUTCOME_LEADS", performance: perf(300_000, 100) }],
    adSets: [
      adSet("a1", "Broad", perf(100_000, 50)), // $20 per lead: the winner
      adSet("a2", "Lookalike", perf(100_000, 40)), // $25
      adSet("a3", "Interests", perf(100_000, 10)), // $100: waste (account average is $30)
    ],
    totals: perf(300_000, 100),
  };
}

describe("what the account is run for", () => {
  it("reads a lead account from its spend when the business type was never set (no ROAS asked)", () => {
    expect(accountGoal(leadAccount(), undefined)).toMatchObject({ kind: "leads", unit: "lead" });
    expect(accountGoal(leadAccount(), undefined).basis).toContain("100% of spend is on Leads campaigns");
  });

  it("trusts the client's business type over the data", () => {
    expect(accountGoal(leadAccount(), "ecommerce").kind).toBe("sales");
    expect(accountGoal(demoMetaAuditSnapshot("act_1", "Shop", 30), "lead_gen").kind).toBe("leads");
  });
});

describe("levers and targets", () => {
  const snap = leadAccount();
  const baseline = baselineOf(snap, "leads")!;
  const levers = leversOf(snap, "leads", baseline);

  it("finds the waste and the winner from the account's own average", () => {
    expect(baseline.costPerCents).toBe(3_000);
    expect(levers.waste.map((w) => w.name)).toEqual(["Interests"]);
    expect(levers.winners.map((w) => w.name)).toEqual(["Broad"]);
    // Without Interests: $2,000 for 90 leads.
    expect(levers.costWithoutWasteCents).toBe(Math.round(200_000 / 90));
    // Its $1,000 moved to Broad at $20 × 1.3 = $26 per lead: 90 + 38.46 leads for $3,000.
    expect(levers.costWithShiftCents).toBe(Math.round(300_000 / (90 + 100_000 / 2_600)));
  });

  it("proposes safe ≥ recommended ≥ bold, each with what it rests on", () => {
    const [safe, rec, bold] = proposeTargets("leads", baseline, levers);
    expect(safe!.costPerCents!).toBeGreaterThanOrEqual(rec!.costPerCents!);
    expect(rec!.costPerCents!).toBeGreaterThanOrEqual(bold!.costPerCents!);
    expect(rec!.roas).toBeNull();
    expect(rec!.basis).toMatch(/wasting ad sets stop/);
    expect(bold!.windowDays).toBe(60);
  });

  it("judges a stated target against those levers", () => {
    expect(judgeTarget({ costPerCents: 3_500 }, baseline, levers)).toBe("already_met");
    expect(judgeTarget({ costPerCents: 2_300 }, baseline, levers)).toBe("reachable");
    expect(judgeTarget({ costPerCents: 2_400 - 100 }, baseline, levers)).toBe("reachable");
    expect(judgeTarget({ costPerCents: 2_000 }, baseline, levers)).toBe("beyond_the_data");
  });

  it("never calls an ad set optimised for conversations waste for having no leads", () => {
    const chats = {
      ...snap,
      adSets: snap.adSets.map((a) =>
        a.id === "a3" ? { ...a, optimizationGoal: "CONVERSATIONS", performance: perf(100_000, 0, { results: 20, resultLabel: "Messaging conversations started", leads: 0 }) } : a,
      ),
    };
    const l = leversOf(chats, "leads", baselineOf(chats, "leads")!);
    expect(l.waste).toEqual([]);
    expect(l.otherGoal.map((r) => [r.name, r.ownResults])).toEqual([["Interests", 20]]);
    const text = renderTargetProposalEvidence({ snapshot: chats, goal: accountGoal(chats, undefined), baseline: baselineOf(chats, "leads"), levers: l, periodSource: "x", today: "2026-11-14", options: [] });
    expect(text).toContain("Optimised for a different result, so NOT judged on leads");
    expect(text).toContain("20 messaging conversations started");
  });

  it("counts an already-paused wasting ad set as no saving left to make", () => {
    const paused = { ...snap, adSets: snap.adSets.map((a) => (a.id === "a3" ? { ...a, status: "CAMPAIGN_PAUSED" } : a)) };
    const l = leversOf(paused, "leads", baselineOf(paused, "leads")!);
    expect(l.waste).toEqual([]);
    expect(l.stoppedWaste.map((w) => w.name)).toEqual(["Interests"]);
    expect(l.costWithoutWasteCents).toBe(3_000);
  });

  it("proposes nothing, and says why, when Meta didn't return the ad sets", () => {
    const failed = { ...snap, adSets: [], warnings: ["Ad sets: Ad Account Has Too Many API Calls (code 17)"] };
    const b = baselineOf(failed, "leads")!;
    const text = renderTargetProposalEvidence({ snapshot: failed, goal: accountGoal(failed, undefined), baseline: b, levers: leversOf(failed, "leads", b), periodSource: "x", today: "2026-11-14", options: [] });
    expect(text).toContain("UNKNOWN, not absent");
    expect(text).not.toContain("no clear waste to cut");
    expect(text).toContain("the ad sets didn't load");
  });

  it("sets no target and calls nothing waste when there are no results", () => {
    const none = { ...snap, adSets: snap.adSets.map((a) => ({ ...a, performance: perf(100_000, 0) })), totals: perf(300_000, 0) };
    const b = baselineOf(none, "leads")!;
    const l = leversOf(none, "leads", b);
    expect(l.waste).toEqual([]);
    expect(proposeTargets("leads", b, l)).toEqual([]);
  });
});

describe("scale targets for an account that already makes money", () => {
  const sales = (roas: number) => ({ days: 30, spendPerDayCents: 4_400, conversions: 21, conversionsPerDay: 0.7, costPerCents: 6_300, roas, revenuePerDayCents: Math.round(4_400 * roas) });
  const noLevers = { otherGoal: [], waste: [], wasteSpendCents: 0, stoppedWaste: [], winners: [], costWithoutWasteCents: 6_300, roasWithoutWaste: 15.5, costWithShiftCents: 6_300, roasWithShift: 15.5, thinData: false };

  it("targets volume, not a cheaper sale, when ROAS is far above any plausible break-even", () => {
    const [safe, rec, bold] = proposeTargets("sales", sales(15.5), noLevers);
    expect(rec).toMatchObject({ mode: "scale", dailyBudgetCents: 8_800, costPerCents: 7_560, windowDays: 45 });
    expect(rec!.roas).toBeCloseTo(15.5 / 1.2, 2);
    expect(safe!.conversionsPerDay!).toBeLessThan(rec!.conversionsPerDay!);
    expect(rec!.conversionsPerDay!).toBeLessThan(bold!.conversionsPerDay!);
    expect(rec!.basis).toMatch(/gross margin above 7%/);
  });

  it("stays on efficiency when the client's own break-even leaves little room", () => {
    expect(proposeTargets("sales", sales(15.5), noLevers, { breakEvenRoas: 12 })[0]!.mode).toBe("efficiency");
    expect(proposeTargets("sales", sales(2.5), noLevers)[0]!.mode).toBe("efficiency");
  });

  it("scales a lead account under its target cost, never past that target", () => {
    const leads = { ...sales(0), roas: null, costPerCents: 3_000, conversions: 100, conversionsPerDay: 3.3 };
    const opts = proposeTargets("leads", leads, { ...noLevers, costWithoutWasteCents: 3_000 }, { targetCostCents: 4_000 });
    expect(opts.map((o) => o.mode)).toEqual(["scale", "scale", "scale"]);
    expect(Math.max(...opts.map((o) => o.costPerCents!))).toBeLessThanOrEqual(4_000);
    expect(opts.every((o) => o.roas == null)).toBe(true);
  });
});

describe("reading the target", () => {
  it("reads a cost per result and a window, and never a ROAS for a lead account", () => {
    expect(parseStatedTarget("strategy to get $40 per lead in 45 days", "leads")).toEqual({ costPerCents: 4_000, windowDays: 45 });
    expect(parseStatedTarget("hit 4x roas within 2 months", "leads")).toEqual({ windowDays: 60 });
    expect(parseStatedTarget("hit 4x roas within 2 months", "sales")).toEqual({ roas: 4, windowDays: 60 });
    expect(parseStatedTarget("100 leads a month", "leads")).toEqual({ volume: 100, windowDays: 30 });
    expect(parseStatedTarget("CPA under $35 in 6 weeks", "sales")).toEqual({ costPerCents: 3_500, windowDays: 42 });
  });

  it("doesn't take a data period or a daily budget for a target", () => {
    expect(parseStatedTarget("optimisation strategy based on the last 30 days", "leads")).toEqual({});
    expect(parseStatedTarget("strategy with $300/day", "leads")).toEqual({});
  });

  it("reads a pick from the proposal", () => {
    expect(pickedOption("recommended")).toBe("recommended");
    expect(pickedOption("go with your pick")).toBe("recommended");
    expect(pickedOption("let's do the bold one")).toBe("bold");
    expect(pickedOption("safe please")).toBe("safe");
    expect(pickedOption("what does bold mean for the budget and how long, explain in detail please and compare all three options thoroughly with numbers, I need a lot more context on this before deciding anything at all about what to pick and why, honestly this needs a very long and careful explanation of everything involved here first")).toBeNull();
  });

  it("only treats a pick as a pick when it answers the proposal", () => {
    const proposal = [{ role: "user" as const, content: "optimisation strategy in 45 days" }, { role: "assistant" as const, content: `...\n${strategyTargetClosing("leads", true)}` }];
    expect(strategyTargetClosing("leads", true).toLowerCase()).toContain(STRATEGY_TARGET_MARKER);
    expect(resolveStrategyTarget("recommended", proposal, "leads")).toMatchObject({ pick: "recommended", answering: true });
    expect(resolveStrategyTarget("recommended", [], "leads").pick).toBeNull();
    // Their own number in the reply wins, and the earlier ask's window fills the gap.
    expect(resolveStrategyTarget("$35 per lead", proposal, "leads").stated).toEqual({ costPerCents: 3_500, windowDays: 45 });
  });

  it("keeps the budget-split plan only for a stated money budget", () => {
    expect(wantsBudgetPlan(["$6,000 a month at 15x"], "sales")).toBe(true);
    expect(wantsBudgetPlan(["give me an optimisation strategy"], "sales")).toBe(false);
    expect(wantsBudgetPlan(["100 leads a month"], "leads")).toBe(false);
    expect(wantsBudgetPlan(["$80/day"], "other")).toBe(false);
  });
});

describe("the period read", () => {
  it("uses the audit's period when the chat has one", () => {
    const history = [{ role: "assistant" as const, content: "# Meta Ads Account Audit — Bethel\n\n**Period:** 16 Oct 2026 – 14 Nov 2026 (30 days) · **Scope:** Entire ad account" }];
    expect(strategyPeriod("strategy based on this audit", history)).toMatchObject({ dateStart: "2026-10-16", dateStop: "2026-11-14" });
  });

  it("never reads a target window as a data period", () => {
    expect(strategyPeriod("strategy to hit $40 per lead in 45 days", []).source).toMatch(/last 30 days/);
  });
});

describe("routing a reply to the proposal", () => {
  it("keeps the reply on the strategy flow", () => {
    const history = [{ role: "assistant" as const, content: `Long proposal…\n${strategyTargetClosing("sales", true)}` }];
    expect(detectRequestIntentWithHistory("recommended", history)).toBe("strategy");
    expect(detectRequestIntentWithHistory("4x in 60 days", history)).toBe("strategy");
    expect(detectRequestIntentWithHistory("give me an optimization strategy based on the audit", [])).toBe("strategy");
  });
});

describe("evidence for the writer", () => {
  const snap = leadAccount();
  const goal = accountGoal(snap, undefined);
  const baseline = baselineOf(snap, "leads");
  const levers = leversOf(snap, "leads", baseline!);
  const input = { snapshot: snap, goal, baseline, levers, periodSource: "the last 30 days", today: "2026-11-14" };

  it("tells the writer a lead account never talks ROAS, and lists the three targets with dates", () => {
    const text = renderTargetProposalEvidence({ ...input, options: proposeTargets("leads", baseline!, levers) });
    expect(text).toContain("never mention ROAS");
    expect(text).toContain("| Option | Cost per lead | By (days) | Rests on |");
    expect(text).toMatch(/\| recommended \| \$22\.22 \| 30 \(by 2026-12-14\)/);
    expect(text).toContain('"Interests"');
  });

  it("works out the gap, the verdict and the budget a volume goal needs", () => {
    const text = renderStrategyPlanEvidence({ ...input, target: { volume: 150, windowDays: 30, costPerCents: 2_500 }, targetSource: "stated by the operator", defaultWindowDays: 30 });
    expect(text).toContain("Verdict: reachable by stopping the waste alone");
    expect(text).toContain("Gap: cost per lead $30.00 now → $25.00 (−17%)");
    // 150 leads in 30 days at $25 = $125/day.
    expect(text).toContain("$125.00/day");
    expect(text).toContain("by day 15");
  });
});
