import { describe, expect, it } from "vitest";
import {
  STRATEGY_BRIEF_MARKER,
  buildStrategyClarifyingQuestion,
  looksLikeStrategyBriefReply,
  parseStrategyBrief,
  resolveStrategyBrief,
} from "@/lib/agent/strategy-brief";
import {
  detectRequestIntent,
  detectRequestIntentWithHistory,
  planTaskSteps,
  REPORT_INTENTS,
} from "@/lib/agent/task-plan";
import type { ResolvedGoals } from "@/lib/clients/goals";

const noGoals = {} as ResolvedGoals;
const defaults = (goals: Partial<ResolvedGoals> = {}, spend: number | null = null) => ({
  goals: goals as ResolvedGoals,
  currentDailySpendCents: spend,
});

describe("parseStrategyBrief", () => {
  it("reads target, stretch targets and a daily budget", () => {
    const r = parseStrategyBrief(
      "Plan to hit 10x ROAS on $1,200/day, stretch 12x and 15x",
      defaults(),
    );
    expect(r.brief).toEqual({ dailyBudgetCents: 120000, targetRoas: 10, stretchTargets: [12, 15] });
    expect(r.missing).toEqual([]);
    expect(r.usedDefaults).toEqual([]);
  });

  it("converts a monthly budget to daily", () => {
    const r = parseStrategyBrief("$36k/month at a roas of 8", defaults());
    expect(r.brief?.dailyBudgetCents).toBe(118421);
    expect(r.brief?.targetRoas).toBe(8);
  });

  it("supports k suffix, 'per day' and 'a day'", () => {
    expect(parseStrategyBrief("8x on $30k a day", defaults()).brief?.dailyBudgetCents).toBe(3_000_000);
    expect(parseStrategyBrief("8x on 1200 per day", defaults()).brief?.dailyBudgetCents).toBe(120000);
  });

  it("drops stretch values equal to the target and sorts/de-duplicates", () => {
    const r = parseStrategyBrief("10x ROAS, $500/day, stretch 15x, 12x, 10x, 15x", defaults());
    expect(r.brief?.stretchTargets).toEqual([12, 15]);
  });

  it("asks for everything when nothing is given", () => {
    const r = parseStrategyBrief("build me a strategy", defaults());
    expect(r.brief).toBeNull();
    expect(r.missing).toEqual(["budget", "target_roas"]);
  });

  it("falls back to goals and current spend, and says so", () => {
    const t = parseStrategyBrief("build me a strategy", defaults({ target_roas: 6 }));
    expect(t.missing).toEqual(["budget"]);
    expect(t.usedDefaults).toEqual(["target_roas"]);
    const b = parseStrategyBrief("build me a strategy", defaults({ target_roas: 6, daily_account_cap_cents: 90000 }, 50000));
    expect(b.brief).toEqual({ dailyBudgetCents: 90000, targetRoas: 6, stretchTargets: [] });
    expect(b.usedDefaults).toEqual(["budget", "target_roas"]);
    const s = parseStrategyBrief("strategy at 6x", defaults({}, 50000));
    expect(s.brief?.dailyBudgetCents).toBe(50000);
    expect(s.usedDefaults).toEqual(["budget"]);
  });

  it("derives the target from '$A to get $B back' but not the budget", () => {
    const r = parseStrategyBrief("build a strategy for $4k to get $40k back", defaults());
    expect(r.missing).toEqual(["budget"]);
    const r2 = parseStrategyBrief("$4k to get $40k back, $800/day", defaults());
    expect(r2.brief).toEqual({ dailyBudgetCents: 80000, targetRoas: 10, stretchTargets: [] });
  });

  it("lets an explicit Nx win over the A-to-B form", () => {
    const r = parseStrategyBrief("$4k to get $40k back, aim for 12x, $800/day", defaults());
    expect(r.brief?.targetRoas).toBe(12);
  });

  it("needs a connector before a roas number, so a budget is never read as a stretch target", () => {
    const r = parseStrategyBrief("10x ROAS 500 per day", defaults());
    expect(r.brief).toEqual({ dailyBudgetCents: 50000, targetRoas: 10, stretchTargets: [] });
    for (const q of ["roas of 8", "roas at 8", "roas target 8", "roas: 8", "roas = 8"]) {
      expect(parseStrategyBrief(`${q}, $500/day`, defaults()).brief?.targetRoas).toBe(8);
    }
  });

  it("reads 'roas of 400%' as 4x", () => {
    expect(parseStrategyBrief("roas of 400% on $500/day", defaults()).brief?.targetRoas).toBe(4);
  });

  it("treats a roas over 100 as missing, not a target", () => {
    const r = parseStrategyBrief("hit 500x roas on $500/day", defaults());
    expect(r.brief).toBeNull();
    expect(r.missing).toEqual(["target_roas"]);
    expect(parseStrategyBrief("10x roas on $500/day, stretch 250x", defaults()).brief?.stretchTargets).toEqual([]);
    expect(parseStrategyBrief("$1 to get $500 back, $500/day", defaults()).missing).toEqual(["target_roas"]);
  });
});

describe("resolveStrategyBrief (a reply to the brief question)", () => {
  const asked = (earlier: string) => [
    { role: "user" as const, content: earlier },
    { role: "assistant" as const, content: buildStrategyClarifyingQuestion(["budget"]) },
  ];

  it("lets the reply's target win over the earlier ask, without making it a stretch target", () => {
    const r = resolveStrategyBrief("$500/day, actually make it 12x", asked("Plan to hit 10x"), defaults());
    expect(r.brief).toEqual({ dailyBudgetCents: 50000, targetRoas: 12, stretchTargets: [] });
    expect(r.missing).toEqual([]);
    expect(r.usedDefaults).toEqual([]);
  });

  it("lets a restated budget win and keeps the earlier target", () => {
    const r = resolveStrategyBrief("make it $500/day", asked("Plan to hit 10x ROAS on $300/day"), defaults());
    expect(r.brief).toEqual({ dailyBudgetCents: 50000, targetRoas: 10, stretchTargets: [] });
  });

  it("fills only missing fields from the earlier ask and unions the stretch targets", () => {
    const r = resolveStrategyBrief(
      "$500/day, 12x, stretch 20x",
      asked("Plan to hit 10x, stretch 12x and 15x"),
      defaults(),
    );
    expect(r.brief).toEqual({ dailyBudgetCents: 50000, targetRoas: 12, stretchTargets: [15, 20] });
  });

  it("reports defaults and missing values for the merged brief", () => {
    const viaCap = resolveStrategyBrief("8x", asked("Build me a strategy"), defaults({ daily_account_cap_cents: 30000 }));
    expect(viaCap.brief).toEqual({ dailyBudgetCents: 30000, targetRoas: 8, stretchTargets: [] });
    expect(viaCap.usedDefaults).toEqual(["budget"]);
    const stillMissing = resolveStrategyBrief("$500/day", asked("Build me a strategy"), defaults());
    expect(stillMissing.brief).toBeNull();
    expect(stillMissing.missing).toEqual(["target_roas"]);
  });

  it("reads the request alone when the last reply was not the brief question", () => {
    const r = resolveStrategyBrief(
      "$500/day",
      [
        { role: "user", content: "Plan to hit 10x" },
        { role: "assistant", content: "Here is your audit." },
      ],
      defaults(),
    );
    expect(r.missing).toEqual(["target_roas"]);
  });
});

describe("clarifying question and reply detection", () => {
  it("asks only for what's missing", () => {
    const both = buildStrategyClarifyingQuestion(["budget", "target_roas"]);
    expect(both).toMatch(/daily budget/i);
    expect(both).toMatch(/target ROAS/i);
    const one = buildStrategyClarifyingQuestion(["target_roas"]);
    expect(one).toMatch(/target ROAS/i);
    expect(one).not.toMatch(/daily budget/i);
  });

  it("recognises short brief replies", () => {
    expect(looksLikeStrategyBriefReply("$1,200/day")).toBe(true);
    expect(looksLikeStrategyBriefReply("10x")).toBe(true);
    expect(looksLikeStrategyBriefReply("roas of 8")).toBe(true);
    expect(looksLikeStrategyBriefReply("thanks")).toBe(false);
    expect(looksLikeStrategyBriefReply("x".repeat(900) + " $5")).toBe(false);
  });
});

describe("strategy intent", () => {
  it.each([
    "how do I get 10x roas",
    "build a strategy for $4k to get $40k back",
    "what's the plan to reach a 12x target",
    "Plan to hit 10x ROAS on $1,200/day, stretch 12x and 15x",
  ])("routes %s to strategy", (q) => {
    expect(detectRequestIntent(q)).toBe("strategy");
  });

  it("keeps audit and optimize", () => {
    expect(detectRequestIntent("audit the account")).toBe("audit");
    expect(detectRequestIntent("optimize budgets")).toBe("optimize");
    expect(detectRequestIntent("queue the changes")).toBe("optimize");
  });

  it("keeps a definition question conversational", () => {
    expect(detectRequestIntent("what does 10x roas mean")).toBe("chat");
  });

  it.each([
    ["optimize for 5x roas", "optimize"],
    ["hit 10x roas by optimizing budgets", "optimize"],
    ["create a campaign targeting 4x roas at $50/day", "create_campaign"],
    ["set my target roas to 4", "general"],
    ["get 3x more leads", "general"],
    ["reach 5x more customers", "general"],
    ["what is the strategy behind advantage+", "chat"],
    ["increase the budget to $50/day", "budget"],
    ["create a campaign with $30/day budget", "create_campaign"],
    ["what does roas mean", "chat"],
  ])("routes %s to %s", (q, expected) => {
    expect(detectRequestIntent(q)).toBe(expected);
  });

  it.each([
    "Which ads have 5x ROAS or better?",
    "Which campaigns are under 2x ROAS?",
    "show me ad sets above 3x roas last week",
    "list ads with at least 4x roas",
    "which ad sets are below a roas of 2",
  ])("does not route the reporting question %s to strategy", (q) => {
    expect(detectRequestIntent(q)).not.toBe("strategy");
  });

  it.each(["aim for 8x roas on $300/day", "target 6x roas this month", "can you plan for 5x roas"])(
    "still routes the goal %s to strategy",
    (q) => {
      expect(detectRequestIntent(q)).toBe("strategy");
    },
  );

  it("does not route 'pause campaigns under target roas' to strategy", () => {
    expect(detectRequestIntent("pause campaigns under target roas")).not.toBe("strategy");
  });

  it("does not hijack a campaign-budget reply", () => {
    const history = [
      { role: "assistant" as const, content: "What daily budget do you want for the new campaign?" },
    ];
    expect(detectRequestIntentWithHistory("$50/day", history)).not.toBe("strategy");
  });

  it("continues an open strategy brief", () => {
    const history = [
      { role: "user" as const, content: "build a strategy" },
      { role: "assistant" as const, content: buildStrategyClarifyingQuestion(["budget", "target_roas"]) },
    ];
    expect(detectRequestIntentWithHistory("my budget is $1,200/day, 10x", history)).toBe("strategy");
    expect(detectRequestIntentWithHistory("$900 a day", history)).toBe("strategy");
    expect(detectRequestIntentWithHistory("thanks", history)).not.toBe("strategy");
  });

  it("does not continue after a long delivered report", () => {
    const history = [
      { role: "assistant" as const, content: `${STRATEGY_BRIEF_MARKER} `.repeat(200) },
    ];
    expect(detectRequestIntentWithHistory("$900 a day", history)).not.toBe("strategy");
  });

  it("plans the strategy steps", () => {
    expect(planTaskSteps("x", "strategy").map((s) => s.id)).toEqual([
      "queued",
      "research",
      "clarify_brief",
      "fetch_overview",
      "pull_insights",
      "build_plan",
      "write_report",
      "complete",
    ]);
    expect(REPORT_INTENTS.has("strategy")).toBe(true);
  });
});
