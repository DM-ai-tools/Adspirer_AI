import { afterEach, describe, expect, it } from "vitest";
import { gatherDiagnoseEvidence, runAdspirerAgent } from "@/lib/agent/adspirer-agent";
import { createTask } from "@/lib/agent/task-runner";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import {
  buildLeadClarifyingQuestion,
  isLeadStrategy,
  looksLikeLeadBriefReply,
  parseLeadGoal,
  resolveLeadBrief,
} from "@/lib/agent/lead-brief";
import { STRATEGY_BRIEF_MARKER } from "@/lib/agent/strategy-brief";
import { detectRequestIntent, detectRequestIntentWithHistory } from "@/lib/agent/task-plan";
import { resolveGoals, type GoalsProfile } from "@/lib/clients/goals";
import {
  demoMetaAuditSnapshot,
  type AuditCampaign,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";
import { buildLeadPlan, type LeadBrief } from "@/lib/strategy/lead-plan";
import { renderLeadStrategyEvidence } from "@/lib/strategy/lead-render";

function perf(spendCents: number, results: number | null): PeriodPerformance {
  return {
    spendCents,
    impressions: 1000,
    reach: 800,
    frequency: 1.2,
    linkCtr: 1,
    cpmCents: null,
    results,
    resultLabel: "Leads",
    costPerResultCents: results ? Math.round(spendCents / results) : null,
    roas: null,
  };
}

function campaign(id: string, name: string, spendCents: number, results: number | null): AuditCampaign {
  return {
    id,
    name,
    objective: "OUTCOME_LEADS",
    status: "ACTIVE",
    bidStrategy: null,
    dailyBudgetCents: null,
    lifetimeBudgetCents: null,
    advantagePlus: false,
    specialAdCategories: [],
    createdTime: null,
    performance: perf(spendCents, results),
  };
}

/** 30 days: $3,000 spent for 100 leads, so $30 a lead and $100 a day. */
function snap(campaigns: AuditCampaign[], totals: PeriodPerformance | null = perf(300_000, 100)): MetaAuditSnapshot {
  return { ...demoMetaAuditSnapshot("act_1", "Demo", 30), totals, campaigns, previousTotals: undefined };
}

const goalsFor = (profile: GoalsProfile = {}) => resolveGoals({ goals_profile: { business_model: "lead_gen", ...profile } });
const brief = (over: Partial<LeadBrief> = {}): LeadBrief => ({
  targetLeads: 100,
  periodDays: 30,
  dailyBudgetCents: null,
  targetCplCents: null,
  ...over,
});
const threeCampaigns = [
  campaign("c1", "Implants", 150_000, 60), // $25 a lead: proven
  campaign("c2", "Veneers", 100_000, 30), // $33.33: promising
  campaign("c3", "Whitening", 50_000, 5), // $100: hold
];

describe("parseLeadGoal", () => {
  it("reads the count and the period right after it", () => {
    expect(parseLeadGoal("to get 100 leads in a month")).toEqual({ leads: 100, periodDays: 30 });
    expect(parseLeadGoal("50 leads per week")).toEqual({ leads: 50, periodDays: 7 });
    expect(parseLeadGoal("get 200 enquiries over 2 weeks")).toEqual({ leads: 200, periodDays: 14 });
    expect(parseLeadGoal("1.5k bookings monthly")).toEqual({ leads: 1500, periodDays: 30 });
  });

  it("leaves the period open when none follows the count", () => {
    expect(parseLeadGoal("I want 100 leads")).toEqual({ leads: 100, periodDays: null });
  });

  it("does not read a dollar amount or a plain number as a lead count", () => {
    expect(parseLeadGoal("$100 leads")).toBeNull();
    expect(parseLeadGoal("spend $500/day")).toBeNull();
  });
});

describe("resolveLeadBrief", () => {
  it("sizes a lead goal with no budget and no ROAS", () => {
    const r = resolveLeadBrief("According to you, to get 100 leads in a month tell me what is the budget i need to put");
    expect(r.missing).toEqual([]);
    expect(r.brief).toEqual({ targetLeads: 100, periodDays: 30, dailyBudgetCents: null, targetCplCents: null });
    expect(r.periodAssumed).toBe(false);
  });

  it("assumes a month and says so when the period is missing", () => {
    const r = resolveLeadBrief("get me 80 leads, what budget do I need");
    expect(r.brief?.periodDays).toBe(30);
    expect(r.periodAssumed).toBe(true);
  });

  it("reads a target cost per lead and a stated budget", () => {
    const r = resolveLeadBrief("100 leads a month at $25 per lead on $120/day");
    expect(r.brief).toMatchObject({ targetLeads: 100, targetCplCents: 2500, dailyBudgetCents: 12000 });
    expect(resolveLeadBrief("100 leads a month, cpl under $40").brief?.targetCplCents).toBe(4000);
  });

  it("projects leads for a budget with no goal", () => {
    const r = resolveLeadBrief("what would $80/day get me");
    expect(r.brief).toEqual({ targetLeads: null, periodDays: 30, dailyBudgetCents: 8000, targetCplCents: null });
  });

  it("asks for the lead goal when the ask has neither a goal nor a budget", () => {
    const r = resolveLeadBrief("build me a strategy");
    expect(r.brief).toBeNull();
    expect(r.missing).toEqual(["leads"]);
  });

  it("merges the reply to the question with the earlier ask", () => {
    const history = [
      { role: "user" as const, content: "build me a strategy, cpl under $30" },
      { role: "assistant" as const, content: buildLeadClarifyingQuestion() },
    ];
    const r = resolveLeadBrief("100 leads a month", history);
    expect(r.brief).toMatchObject({ targetLeads: 100, periodDays: 30, targetCplCents: 3000 });
  });
});

describe("the lead question", () => {
  it("never asks for ROAS and carries the marker history routing keys on", () => {
    const q = buildLeadClarifyingQuestion();
    expect(q.toLowerCase()).toContain(STRATEGY_BRIEF_MARKER);
    expect(q.toLowerCase()).not.toContain("roas");
    expect(q).toContain("100 leads a month");
  });

  it("is recognised as the answer's question, so a short reply stays a strategy ask", () => {
    const history = [
      { role: "user" as const, content: "build me a strategy" },
      { role: "assistant" as const, content: buildLeadClarifyingQuestion() },
    ];
    expect(looksLikeLeadBriefReply("100 leads a month")).toBe(true);
    expect(looksLikeLeadBriefReply("$80/day")).toBe(true);
    expect(detectRequestIntentWithHistory("100 leads a month", history)).toBe("strategy");
  });
});

describe("isLeadStrategy", () => {
  it("is true for lead, local-service and B2B clients and false for ecommerce", () => {
    for (const m of ["lead_gen", "local_service", "b2b"] as const) {
      expect(isLeadStrategy(m, ["what budget do I need and what is the ad strategy"])).toBe(true);
      expect(isLeadStrategy(m, ["100 leads a month"])).toBe(true);
    }
    expect(isLeadStrategy("ecommerce", ["100 leads a month"])).toBe(false);
    expect(isLeadStrategy("ecommerce", ["build me a strategy"])).toBe(false);
  });

  it("honours a ROAS the operator states, unless the ask also gives a lead count", () => {
    expect(isLeadStrategy("lead_gen", ["Plan to hit 10x ROAS on $500/day"])).toBe(false);
    expect(isLeadStrategy("lead_gen", ["hit 10x roas, 100 leads a month"])).toBe(true);
  });

  it("follows the ask for an unset or other client: a lead count with no ROAS", () => {
    expect(isLeadStrategy(undefined, ["100 leads a month, what budget"])).toBe(true);
    expect(isLeadStrategy("other", ["100 leads a month, what budget"])).toBe(true);
    expect(isLeadStrategy(undefined, ["hit 10x roas on $500/day"])).toBe(false);
    expect(isLeadStrategy(undefined, ["hit 10x roas, 100 leads a month"])).toBe(false);
  });
});

describe("intent", () => {
  it("treats a lead goal with a budget question as a strategy ask, with or without the word strategy", () => {
    expect(detectRequestIntent("to get 100 leads in a month tell me what is the budget i need to put and the ad strategy")).toBe("strategy");
    expect(detectRequestIntent("how much do I need to spend to get 100 leads a month")).toBe("strategy");
    expect(detectRequestIntent("what budget do I need to get 50 enquiries in 2 weeks")).toBe("strategy");
  });

  it("leaves a report about leads alone", () => {
    expect(detectRequestIntent("which campaigns got 100 leads last month")).not.toBe("strategy");
  });
});

describe("buildLeadPlan: sizing a budget", () => {
  const plan = (b: Partial<LeadBrief> = {}, goals: GoalsProfile = {}, campaigns = threeCampaigns) =>
    buildLeadPlan({ snapshot: snap(campaigns), goals: goalsFor(goals), brief: brief(b) });

  it("uses the account's own cost per lead", () => {
    const p = plan();
    expect(p.baseline.cplCents).toBe(3000);
    expect(p.reference).toEqual({ cplCents: 3000, source: "observed" });
    expect(p.mode).toBe("size");
  });

  it("keeps today's cost per lead when the goal is at or below today's volume", () => {
    // 100 leads over 30 days is today's run-rate: $100/day, $30 a lead, in every case.
    const p = plan();
    expect(p.scenarios.map((s) => s.dailyBudgetCents)).toEqual([10_000, 10_000, 10_000]);
    expect(p.scenarios.map((s) => s.periodBudgetCents)).toEqual([300_000, 300_000, 300_000]);
  });

  it("makes extra leads dearer: 200 leads costs the base plus the extra at reduced efficiency", () => {
    const p = plan({ targetLeads: 200 });
    // base $100/day for 3.33 leads/day; need 6.67/day. extra 3.33/day at $30 / eff.
    const byId = Object.fromEntries(p.scenarios.map((s) => [s.id, s]));
    expect(byId.best.dailyBudgetCents).toBe(20_000);
    expect(byId.expected.dailyBudgetCents).toBe(Math.round(10_000 + (10_000 / 0.85)));
    expect(byId.conservative.dailyBudgetCents).toBe(Math.round(10_000 + (10_000 / 0.7)));
    expect(byId.best.dailyBudgetCents).toBeLessThan(byId.expected.dailyBudgetCents);
    expect(byId.expected.dailyBudgetCents).toBeLessThan(byId.conservative.dailyBudgetCents);
    expect(byId.expected.cplCents).toBeGreaterThan(3000);
    expect(p.plannedDailyCents).toBe(byId.expected.dailyBudgetCents);
  });

  it("scales to a different period", () => {
    const p = plan({ targetLeads: 50, periodDays: 7 }); // 7.14/day: above the 3.33 run-rate
    const expected = p.scenarios.find((s) => s.id === "expected")!;
    expect(expected.periodBudgetCents).toBe(expected.dailyBudgetCents * 7);
  });

  it("shows the budget at the operator's own target cost per lead", () => {
    const p = plan({ targetCplCents: 2000 });
    expect(p.atTargetCpl).toEqual({ cplCents: 2000, dailyBudgetCents: Math.round((100 / 30) * 2000), periodBudgetCents: 200_000 });
  });

  it("falls back to the client's target CPA when the account has no leads", () => {
    const p = buildLeadPlan({
      snapshot: snap([], perf(0, null)),
      goals: goalsFor({ target_cpa_cents: 4000 }),
      brief: brief(),
    });
    expect(p.reference).toEqual({ cplCents: 4000, source: "client_target" });
    expect(p.scenarios.find((s) => s.id === "best")!.dailyBudgetCents).toBe(Math.round((100 / 30) * 4000));
  });

  it("sizes nothing, and invents nothing, with no cost per lead anywhere", () => {
    const p = buildLeadPlan({ snapshot: snap([], perf(0, null)), goals: goalsFor(), brief: brief() });
    expect(p.reference.cplCents).toBeNull();
    expect(p.scenarios).toEqual([]);
    expect(p.plannedDailyCents).toBeNull();
    const text = renderLeadStrategyEvidence(p, { score: { score: 50, grade: "D" } });
    expect(text).toContain("cannot be sized");
    expect(text).toContain("No budget could be sized");
  });
});

describe("buildLeadPlan: projecting a budget", () => {
  it("projects fewer leads on a low budget and more on a high one, as a range", () => {
    const low = buildLeadPlan({ snapshot: snap(threeCampaigns), goals: goalsFor(), brief: brief({ targetLeads: null, dailyBudgetCents: 5_000 }) });
    const high = buildLeadPlan({ snapshot: snap(threeCampaigns), goals: goalsFor(), brief: brief({ targetLeads: null, dailyBudgetCents: 30_000 }) });
    expect(low.mode).toBe("project");
    expect(low.scenarios).toEqual([]);
    expect(low.projections.find((p) => p.id === "expected")!.periodLeads).toBe(50);
    const h = Object.fromEntries(high.projections.map((p) => [p.id, p.periodLeads]));
    expect(h.best).toBe(300);
    expect(h.expected).toBeLessThan(h.best);
    expect(h.conservative).toBeLessThan(h.expected);
  });

  it("gives a verdict when a goal and a budget are both stated", () => {
    const verdict = (dailyBudgetCents: number, targetLeads = 200) =>
      buildLeadPlan({ snapshot: snap(threeCampaigns), goals: goalsFor(), brief: brief({ targetLeads, dailyBudgetCents }) }).budgetVerdict;
    expect(verdict(40_000)).toBe("meets");
    expect(verdict(5_000)).toBe("short");
    expect(verdict(20_000)).toBe("stretch");
  });
});

describe("buildLeadPlan: campaigns and checks", () => {
  const p = buildLeadPlan({ snapshot: snap(threeCampaigns), goals: goalsFor(), brief: brief({ targetLeads: 200 }) });
  const row = (id: string) => p.campaigns.find((c) => c.id === id)!;

  it("tiers campaigns against the reference cost per lead", () => {
    expect([row("c1").tier, row("c2").tier, row("c3").tier]).toEqual(["proven", "promising", "hold"]);
  });

  it("splits the planned budget by tier and funds no hold", () => {
    const total = p.campaigns.reduce((s, c) => s + c.dailyBudgetCents, 0);
    expect(total).toBe(p.plannedDailyCents);
    expect(row("c3").dailyBudgetCents).toBe(0);
    expect(row("c1").dailyBudgetCents).toBeGreaterThan(row("c2").dailyBudgetCents);
  });

  it("plans a ramp in the client's scale steps", () => {
    expect(p.ramp).toMatchObject({ fromCents: 10_000, stepPct: 20, minDaysPerStep: 7 });
    expect(p.ramp!.steps).toBeGreaterThan(1);
  });

  it("flags a budget over the daily cap and a cost per lead over break-even", () => {
    const capped = buildLeadPlan({
      snapshot: snap(threeCampaigns),
      goals: goalsFor({ daily_account_cap_cents: 15_000, average_value_cents: 5_000, gross_margin_pct: 40 }),
      brief: brief({ targetLeads: 200 }),
    });
    expect(capped.checks.some((c) => /daily account cap/.test(c))).toBe(true);
    expect(capped.checks.some((c) => /break-even CPA/.test(c))).toBe(true);
  });
});

describe("renderLeadStrategyEvidence", () => {
  const p = buildLeadPlan({ snapshot: snap(threeCampaigns), goals: goalsFor(), brief: brief({ targetLeads: 200 }) });
  const text = renderLeadStrategyEvidence(p, { score: { score: 71, grade: "B" }, periodAssumed: true });

  it("keeps the heading the rest of the pipeline keys on, and says the goal is leads", () => {
    expect(text).toContain("### Strategy inputs");
    expect(text).toContain("Goal type: lead generation");
    expect(text).toContain("Lead goal: 200 leads over 30 days");
    expect(text).toContain("period not stated");
    expect(text).toContain("Word for offerings: service");
  });

  it("never mentions a target ROAS as an input", () => {
    expect(text).not.toMatch(/Target ROAS/);
    expect(text).not.toMatch(/Daily budget: /);
  });

  it("lays out the three levels, the budget cases, the allocation and the next step", () => {
    for (const h of ["### Level 1: where you are", "### Level 2: how it compares", "### Level 3: budget & plan", "### Assumptions", "### Next step"]) {
      expect(text).toContain(h);
    }
    expect(text).toContain("Recommended budget:");
    expect(text).toContain("| Implants | Proven |");
    expect(text).toContain("Ramp:");
  });
});

afterEach(() => {
  resetDemoStore();
});

async function strategyTurn(clientId: string, request: string) {
  const task = await createTask({ clientId, createdBy: "profile_operator_demo", title: request, goal: request });
  const gathered = await gatherDiagnoseEvidence({ clientId, request, intent: "strategy" });
  const result = await runAdspirerAgent({ task, clientContext: "", toolEvidence: gathered.evidence, intent: "strategy" });
  return { gathered, result };
}

describe("strategy turn for a lead-gen client (DEMO_MODE)", () => {
  it("sizes the budget for a lead goal without asking for ROAS", async () => {
    const { gathered, result } = await strategyTurn(
      "client_modern_dental",
      "to get 100 leads in a month tell me what is the budget i need to put and the ad strategy",
    );
    expect(gathered.strategyBriefIncomplete).toBeFalsy();
    expect(gathered.strategyPlanBuilt).toBe(true);
    expect(gathered.evidence).toContain("### Strategy framework");
    expect(gathered.evidence).toContain("Lead goal: 100 leads over 30 days");
    expect(result.summary).toContain("Level 3");
    expect(result.summary).toContain("Recommended budget:");
    expect(result.summary).not.toMatch(/Target ROAS/i);
    expect(gathered.toolCalls.find((c) => c.name === "strategy_plan")?.args).toMatchObject({
      goal: "leads",
      target_leads: 100,
      period_days: 30,
    });
    expect(gathered.offered ?? []).toEqual([]);
  });

  it("asks for the lead goal, not a target ROAS, when the ask has none", async () => {
    const { gathered, result } = await strategyTurn("client_modern_dental", "Build me a strategy");
    expect(gathered.strategyBriefIncomplete).toBe(true);
    expect(result.summary.toLowerCase()).toContain("strategy brief");
    expect(result.summary).toContain("Lead goal");
    expect(result.summary).not.toMatch(/ROAS/i);
    expect(gathered.toolCalls.map((c) => c.name)).not.toContain("strategy_plan");
  });

  it("still plans on ROAS for an ecommerce client", async () => {
    const client = getDemoStore().clients.find((c) => c.id === "client_modern_dental")!;
    client.goals_profile = { ...client.goals_profile, business_model: "ecommerce" };
    const { gathered } = await strategyTurn("client_modern_dental", "Plan to hit 10x ROAS on $500/day");
    expect(gathered.toolCalls.find((c) => c.name === "strategy_plan")?.args).toMatchObject({ target_roas: 10 });
  });
});
