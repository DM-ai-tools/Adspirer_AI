import { describe, expect, it } from "vitest";
import { parseStrategyBrief, resolveStrategyBrief, buildStrategyClarifyingQuestion } from "@/lib/agent/strategy-brief";
import { detectRequestIntent } from "@/lib/agent/task-plan";
import { scopeCategoriesFromRequest, type StrategyCategory } from "@/lib/strategy/categories";
import type { ResolvedGoals } from "@/lib/clients/goals";

const defaults = (goals: Partial<ResolvedGoals> = {}, spend: number | null = null) => ({
  goals: goals as ResolvedGoals,
  currentDailySpendCents: spend,
});

const category = (name: string, keywords: string[] = []): StrategyCategory => ({
  id: name.toLowerCase(),
  name,
  landingPageUrl: null,
  urlPatterns: [],
  keywords,
  grossMarginPct: null,
  averageOrderValueCents: null,
  priority: 0,
});

describe("total budgets in the strategy brief", () => {
  const ask = "How do we spend $4k and get $40k back on bar stools using Google Ads and Meta?";

  it("reads 'spend $A and get $B back' as a total, a default period and a target", () => {
    const r = parseStrategyBrief(ask, defaults());
    expect(r.brief).toMatchObject({ totalBudgetCents: 400000, periodDays: 30, dailyBudgetCents: 13333, targetRoas: 10 });
    expect(r.usedDefaults).toContain("period");
    expect(r.usedDefaults).not.toContain("budget");
    expect(r.missing).toEqual([]);
  });

  it("routes it to strategy", () => {
    expect(detectRequestIntent(ask)).toBe("strategy");
    expect(detectRequestIntent("$4k to get $40k")).not.toBe("chat");
    expect(detectRequestIntent("spend $4k to make $40k")).toBe("strategy");
    expect(detectRequestIntent("$4k for $40k in sales")).toBe("strategy");
  });

  it("reads the other total forms", () => {
    for (const q of ["spend $4k to make $40k", "$4k for $40k in sales", "$4k to get $40k"]) {
      const r = parseStrategyBrief(q, defaults());
      expect(r.brief).toMatchObject({ totalBudgetCents: 400000, targetRoas: 10 });
    }
  });

  it("honours a stated period", () => {
    const r = parseStrategyBrief("$4k over 2 weeks to get $40k", defaults());
    expect(r.brief).toMatchObject({ totalBudgetCents: 400000, periodDays: 14, dailyBudgetCents: 28571, targetRoas: 10 });
    expect(r.usedDefaults).not.toContain("period");
    expect(parseStrategyBrief("$6k over 2 months at 8x", defaults()).brief).toMatchObject({ periodDays: 60 });
    expect(parseStrategyBrief("$9k over 30 days at 8x", defaults()).brief).toMatchObject({ periodDays: 30, dailyBudgetCents: 30000 });
  });

  it("reads '$A this month' as 30 days", () => {
    const r = parseStrategyBrief("$6k this month at 8x", defaults());
    expect(r.brief).toMatchObject({ totalBudgetCents: 600000, periodDays: 30, dailyBudgetCents: 20000, targetRoas: 8 });
    expect(r.usedDefaults).not.toContain("period");
  });

  it("lets an explicit daily budget win over a total", () => {
    const r = parseStrategyBrief("$500/day, and we have $4k to get $40k back", defaults());
    expect(r.brief).toMatchObject({ dailyBudgetCents: 50000, targetRoas: 10, totalBudgetCents: 400000, periodDays: 30 });
  });

  it("leaves plain daily asks without total fields", () => {
    const r = parseStrategyBrief("hit 10x roas on $500/day", defaults());
    expect(r.brief).toEqual({ dailyBudgetCents: 50000, targetRoas: 10, stretchTargets: [] });
  });

  it("does not turn a roas comparison into a strategy", () => {
    expect(detectRequestIntent("Which campaigns are under 2x ROAS?")).not.toBe("strategy");
  });

  it("keeps the suppression rules for total-budget wording", () => {
    expect(detectRequestIntent("create a campaign with $4k to get $40k back")).not.toBe("strategy");
  });

  it("merges totals from a reply over the earlier ask", () => {
    const history = [
      { role: "user" as const, content: "build a strategy at 8x on $200/day" },
      { role: "assistant" as const, content: buildStrategyClarifyingQuestion(["budget"]) },
    ];
    const r = resolveStrategyBrief("$6k over 3 weeks", history, defaults());
    expect(r.brief).toMatchObject({ totalBudgetCents: 600000, periodDays: 21, dailyBudgetCents: 28571, targetRoas: 8 });
    const earlierTotal = [
      { role: "user" as const, content: "strategy: $4k over 2 weeks" },
      { role: "assistant" as const, content: buildStrategyClarifyingQuestion(["target_roas"]) },
    ];
    const r2 = resolveStrategyBrief("aim for 10x", earlierTotal, defaults());
    expect(r2.brief).toMatchObject({ totalBudgetCents: 400000, periodDays: 14, targetRoas: 10 });
  });
});

describe("scopeCategoriesFromRequest", () => {
  const cats = [category("Bar stools", ["counter stool"]), category("Sofas"), category("All"), category("Other")];

  it("matches a category by whole-word name or keyword, in category order", () => {
    expect(scopeCategoriesFromRequest("spend $4k on sofas and bar stools", cats).map((c) => c.name)).toEqual([
      "Bar stools",
      "Sofas",
    ]);
    expect(scopeCategoriesFromRequest("a counter stool push", cats).map((c) => c.name)).toEqual(["Bar stools"]);
    expect(scopeCategoriesFromRequest("sofass", cats)).toEqual([]);
  });

  it("ignores generic category names", () => {
    expect(scopeCategoriesFromRequest("all of it, other channels too", cats)).toEqual([]);
  });
});
