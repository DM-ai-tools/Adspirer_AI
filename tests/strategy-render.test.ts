import { describe, expect, it } from "vitest";
import { buildStrategyPlan, type StrategyBrief } from "@/lib/strategy/plan";
import { attributeSpendToCategories } from "@/lib/strategy/category-attribution";
import type { StrategyCategory } from "@/lib/strategy/categories";
import { renderStrategyEvidence } from "@/lib/strategy/render";
import { STRATEGY_FRAMEWORK } from "@/lib/agent/strategy-framework";
import { resolveGoals, type GoalsProfile } from "@/lib/clients/goals";
import {
  demoMetaAuditSnapshot,
  type AuditAd,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";

function cat(name: string, over: Partial<StrategyCategory> = {}): StrategyCategory {
  return {
    id: name.toLowerCase(),
    name,
    landingPageUrl: null,
    urlPatterns: [],
    keywords: [],
    grossMarginPct: null,
    averageOrderValueCents: null,
    priority: 0,
    ...over,
  };
}

function perf(spendCents: number, roas: number | null): PeriodPerformance {
  return {
    spendCents,
    impressions: 1000,
    reach: 800,
    frequency: 1.2,
    linkCtr: 1,
    cpmCents: null,
    results: 1,
    resultLabel: "Purchases",
    costPerResultCents: null,
    roas,
  };
}

function ad(name: string, spendCents: number, roas: number | null): AuditAd {
  return {
    id: `ad_${name.toLowerCase()}`,
    name: `${name} ad`,
    adSetId: "as_1",
    campaignId: "demo_campaign_1",
    status: "ACTIVE",
    createdTime: null,
    format: null,
    issue: null,
    performance: perf(spendCents, roas),
  };
}

function snap(ads: AuditAd[], totals: PeriodPerformance | null = perf(100_000, 2)): MetaAuditSnapshot {
  return { ...demoMetaAuditSnapshot("act_1", "Demo", 30), totals, ads };
}

function render(input: {
  snapshot: MetaAuditSnapshot;
  categories: StrategyCategory[];
  brief?: Partial<StrategyBrief>;
  goals?: GoalsProfile;
  categoryWord?: "category" | "service";
  defaultsUsed?: string[];
}) {
  const plan = buildStrategyPlan({
    snapshot: input.snapshot,
    scorecard: { score: 62, grade: "C" },
    categories: input.categories,
    goals: resolveGoals({ goals_profile: { business_model: "ecommerce", ...input.goals } }),
    brief: { dailyBudgetCents: 10_000, targetRoas: 4, stretchTargets: [], ...input.brief },
    categoryWord: input.categoryWord ?? "category",
  });
  const attribution = attributeSpendToCategories(input.snapshot, input.categories);
  const text = renderStrategyEvidence(plan, attribution, {
    currency: "USD",
    categoryWord: input.categoryWord ?? "category",
    defaultsUsed: input.defaultsUsed,
    warnings: input.snapshot.warnings,
  });
  return { plan, text };
}

/** The Task 7 fixture: Shoes proven, Bags promising, Hats hold, Belts and Socks test. */
const fiveCategories = [cat("Shoes"), cat("Bags"), cat("Hats"), cat("Belts"), cat("Socks")];
const fiveAds = [
  ad("Shoes", 20_000, 5),
  ad("Bags", 20_000, 3),
  ad("Hats", 20_000, 1),
  ad("Belts", 1_000, 6),
  { ...ad("Mystery", 9_000, 2), name: "Unbranded promo" },
];

const HEADINGS = [
  "### Strategy inputs",
  "### Level 1: spend & return by category",
  "### Untouched categories",
  "### Meta capabilities: in use / not used / unknown",
  "### Level 2: reality check",
  "### Level 3: allocation",
  "### Stretch scenarios",
  "### Assumptions",
];

/** Text of one evidence section, from its heading to the next `### `. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n### ", start + heading.length);
  return text.slice(start, next < 0 ? undefined : next);
}

describe("renderStrategyEvidence", () => {
  it("prints every section heading, in order", () => {
    const { text } = render({ snapshot: snap(fiveAds), categories: fiveCategories, brief: { stretchTargets: [6] } });
    const positions = HEADINGS.map((h) => text.indexOf(h));
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("lists each category with spend, revenue, ROAS, tier and match type", () => {
    const { text } = render({ snapshot: snap(fiveAds), categories: fiveCategories });
    const level1 = section(text, "### Level 1");
    expect(level1).toMatch(/\| Category \| Spend \(30d\) \| Revenue \| ROAS \| Tier \| Match \|/);
    expect(level1).toMatch(/\| Shoes \| \$200(\.00)? \| \$1,000(\.00)? \| 5× \| proven \| name \|/);
    expect(level1).toMatch(/\| Hats \| .* \| hold \|/);
    expect(level1).toMatch(/\| Socks \| \$0(\.00)? \| .* \| none \|/);
  });

  it("prints unmatched spend and the coverage %", () => {
    const { text } = render({ snapshot: snap(fiveAds), categories: fiveCategories });
    const level1 = section(text, "### Level 1");
    expect(level1).toContain("Unmatched spend");
    expect(level1).toMatch(/Unmatched spend: \$90(\.00)?/);
    // 61,000 of 70,000 cents matched.
    expect(level1).toMatch(/Coverage: 87\.1%/);
  });

  it("names untouched categories and the capability states", () => {
    const { text } = render({ snapshot: snap(fiveAds), categories: fiveCategories });
    expect(section(text, "### Untouched categories")).toContain("Socks");
    const caps = section(text, "### Meta capabilities");
    expect(caps).toMatch(/In use/);
    expect(caps).toMatch(/Not used/);
    expect(caps).toMatch(/Unknown/);
  });

  it("prints the reality check with the reference sources", () => {
    const { text, plan } = render({ snapshot: snap(fiveAds), categories: fiveCategories });
    const level2 = section(text, "### Level 2");
    expect(level2).toContain(plan.benchmark.realityCheck.verdict);
    for (const ref of plan.benchmark.references) expect(level2).toContain(ref.source);
  });

  it("prints the allocation table and the structure per tier", () => {
    const { text } = render({ snapshot: snap(fiveAds), categories: fiveCategories });
    const level3 = section(text, "### Level 3");
    expect(level3).toMatch(/\| Shoes \| proven \| 4× .*\| \$70(\.00)? \|/);
    expect(level3).toMatch(/Proven.*Advantage\+ sales campaigns/);
    expect(level3).toMatch(/Hold.*Hats/);
    expect(level3).not.toContain("No budget allocated");
  });

  it("labels every stretch scenario with its target, including ones below the main target", () => {
    const { text } = render({ snapshot: snap(fiveAds), categories: fiveCategories, brief: { stretchTargets: [3, 6] } });
    const scenarios = section(text, "### Stretch scenarios");
    expect(scenarios).toMatch(/3× target.*below the main 4× target/);
    expect(scenarios).toMatch(/6× target.*above the main 4× target/);
  });

  it("prints every assumption", () => {
    const { text, plan } = render({ snapshot: snap(fiveAds), categories: fiveCategories });
    const assumptions = section(text, "### Assumptions");
    for (const a of plan.assumptions) expect(assumptions).toContain(a);
  });

  it("prints the inputs, including any defaults used", () => {
    const { text } = render({
      snapshot: snap(fiveAds),
      categories: fiveCategories,
      categoryWord: "service",
      defaultsUsed: ["Daily budget not stated: used the client's daily account cap."],
    });
    const inputs = section(text, "### Strategy inputs");
    expect(inputs).toMatch(/Daily budget: \$100(\.00)?\/day/);
    expect(inputs).toMatch(/Target ROAS: 4×/);
    expect(inputs).toContain("Daily budget not stated: used the client's daily account cap.");
    expect(inputs).toMatch(/Word for offerings: service/);
  });

  it("uses the service word for non-ecommerce clients", () => {
    const { text } = render({ snapshot: snap(fiveAds), categories: fiveCategories, categoryWord: "service" });
    expect(text).toContain("### Level 1: spend & return by service");
    expect(text).toContain("### Untouched services");
    expect(text).toContain("| Service |");
  });

  it("never says category anywhere in the evidence when the word is service", () => {
    const margins = fiveCategories.map((c, i) => ({ ...c, grossMarginPct: i === 0 ? 60 : null }));
    const unknownRoas = [...fiveAds, { ...ad("Socks", 9_000, null), id: "ad_socks_2" }];
    for (const categories of [fiveCategories, margins, []]) {
      const { text, plan } = render({
        snapshot: snap(unknownRoas),
        categories,
        brief: { stretchTargets: [3, 6] },
        goals: { business_model: "lead_gen", gross_margin_pct: 40 },
        categoryWord: "service",
      });
      expect(plan.assumptions.some((a) => /service/.test(a))).toBe(true);
      expect(text).not.toMatch(/categor/i);
    }
  });

  it("truncates 60 categories to the top 25 by spend plus a count line", () => {
    const many = Array.from({ length: 60 }, (_, i) => cat(`Cat${String(i).padStart(2, "0")}`));
    const ads = many.map((c, i) => ad(c.name, 10_000 + i * 100, 2));
    const { text } = render({ snapshot: snap(ads), categories: many });
    const level1 = section(text, "### Level 1");
    const rows = level1.split("\n").filter((l) => /^\| Cat\d\d /.test(l));
    expect(rows).toHaveLength(25);
    // Highest spend first: Cat59 down to Cat35.
    expect(rows[0]).toMatch(/^\| Cat59 /);
    expect(rows[24]).toMatch(/^\| Cat35 /);
    expect(level1).toContain("…and 35 more");
  });

  it("prints No categories loaded yet instead of the tables when there are none", () => {
    const { text } = render({ snapshot: snap(fiveAds), categories: [] });
    expect(text).toContain("No categories loaded yet");
    expect(text).not.toMatch(/\| Category \|/);
    expect(section(text, "### Level 3")).toMatch(/No budget allocated: .*no categories/i);
  });

  it("prints ad-level coverage of account spend and keeps the untouched claim when it is full", () => {
    const { text } = render({ snapshot: snap(fiveAds, perf(70_000, 2)), categories: fiveCategories });
    const level1 = section(text, "### Level 1");
    expect(level1).toMatch(/Ad-level spend covered: \$700(\.00)? of account spend \$700(\.00)? \(100%\)/);
    expect(level1).not.toMatch(/partial/i);
    expect(section(text, "### Untouched categories")).toMatch(/1 with no ad spend in the last 30 days: Socks/);
  });

  it("says per-category figures are partial when the loaded ads cover under 80% of account spend", () => {
    // 70,000 of 100,000 cents of account spend is in the loaded ads.
    const { text } = render({ snapshot: snap(fiveAds), categories: fiveCategories });
    const level1 = section(text, "### Level 1");
    expect(level1).toMatch(/Ad-level spend covered: \$700(\.00)? of account spend \$1,000(\.00)? \(70%\)/);
    expect(level1).toMatch(/Per-category figures are partial/);
    const untouched = section(text, "### Untouched categories");
    expect(untouched).toMatch(/not seen in the loaded ads: Socks/);
    expect(untouched).not.toMatch(/no ad spend/);
  });

  it("prints the snapshot warnings and says figures are partial when the Ads load failed", () => {
    const failed = { ...snap(fiveAds, perf(70_000, 2)), warnings: ["Ads: (#17) User request limit reached"] };
    const { text } = render({ snapshot: failed, categories: fiveCategories });
    const level1 = section(text, "### Level 1");
    expect(level1).toContain("Snapshot warning: Ads: (#17) User request limit reached");
    expect(level1).toMatch(/Per-category figures are partial/);
    expect(section(text, "### Untouched categories")).toMatch(/not seen in the loaded ads/);
  });

  it("says plainly when every category is held and nothing is allocated", () => {
    const held = [cat("Hats"), cat("Caps")];
    const { text } = render({ snapshot: snap([ad("Hats", 20_000, 1), ad("Caps", 20_000, 0.5)]), categories: held });
    const level3 = section(text, "### Level 3");
    expect(level3).toMatch(/No budget allocated: .*break-even/);
  });
});

describe("STRATEGY_FRAMEWORK", () => {
  it("lists the report headings in order", () => {
    const order = [
      "Bottom line",
      "Level 1: where you are",
      "Level 2: how it compares",
      "Level 3: the plan",
      "Stretch scenarios",
      "What would make this plan better",
      "One next step",
    ].map((h) => STRATEGY_FRAMEWORK.indexOf(h));
    for (const p of order) expect(p).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("carries the writer rules", () => {
    expect(STRATEGY_FRAMEWORK).toMatch(/only numbers from the evidence/i);
    expect(STRATEGY_FRAMEWORK).toMatch(/External/);
    expect(STRATEGY_FRAMEWORK).toMatch(/Internal/);
    expect(STRATEGY_FRAMEWORK).toMatch(/3 new concepts a month/);
    expect(STRATEGY_FRAMEWORK).toMatch(/No budget allocated/);
    expect(STRATEGY_FRAMEWORK).toMatch(/Word for offerings/);
    expect(STRATEGY_FRAMEWORK).toMatch(/do not queue or execute/i);
  });
});
