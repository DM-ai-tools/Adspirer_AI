import { BENCHMARKS, type AuditScorecard } from "@/lib/audit/checkpoints";
import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { ResolvedGoals } from "@/lib/clients/goals";
import type { StrategyCategory } from "./categories";
import { attributeSpendToCategories, type CategoryPerformance } from "./category-attribution";
import { detectCapabilityGaps, type CapabilityStatus, type MetaCapabilityId } from "./meta-capabilities";
import { categoryTargetRoas, referenceMarginPct } from "./targets";

export type StrategyBrief = { dailyBudgetCents: number; targetRoas: number; stretchTargets: number[] };
export type AllocationTier = "proven" | "promising" | "test" | "hold";
export type CategoryAllocation = {
  categoryId: string;
  name: string;
  tier: AllocationTier;
  targetRoas: number;
  targetBasis: "margin_adjusted" | "account_target";
  observedRoas: number | null;
  observedSpendCents: number;
  dailyBudgetCents: number;
  projectedDailyRevenueCents: number;
  structure: MetaCapabilityId[];
};
export type PlanProjection = { dailySpendCents: number; dailyRevenueCents: number; blendedRoas: number | null; meetsTarget: boolean };
export type StrategyPlan = {
  brief: StrategyBrief;
  baseline: {
    score: number;
    grade: string;
    periodDays: number;
    spendCents: number;
    roas: number | null;
    categoriesTotal: number;
    categoriesWithSpend: number;
    coveragePct: number;
  };
  benchmark: {
    references: Array<{ metric: string; value: string; source: string }>;
    realityCheck: { targetRoas: number; referenceRoas: number; multiple: number; verdict: "within" | "stretch" | "unrealistic" };
  };
  allocations: CategoryAllocation[];
  gaps: { capabilities: CapabilityStatus[]; untouchedCategoryIds: string[] };
  projection: PlanProjection;
  scenarios: Array<{ targetRoas: number; projection: PlanProjection; tierCounts: Record<AllocationTier, number> }>;
  assumptions: string[];
};

export const PLAN_CONSTANTS = {
  split: { proven: 0.7, promising: 0.2, test: 0.1 },
  minTestDailyCents: 2000,
  scaleDecay: 0.85,
  testDiscount: 0.7,
  minSpendForVerdictCents: 5000,
} as const;

/** Target ÷ reference ROAS at or below these is "within" / "stretch"; above is "unrealistic". */
const REALITY = { within: 1.2, stretch: 2.5 } as const;
const PLAYBOOK_SOURCE = "Internal paid-social playbook (generic, not industry-specific)";

/** Meta setup recommended per tier, before filtering to the business model. */
const STRUCTURE: Record<AllocationTier, MetaCapabilityId[]> = {
  proven: ["advantage_plus_sales", "catalog_ads", "website_retargeting", "cost_or_roas_controls"],
  promising: ["cost_or_roas_controls", "video_creative", "website_retargeting"],
  test: ["broad_advantage_audience", "automatic_placements", "dynamic_creative"],
  hold: [],
};

const FUNDED_TIERS = ["proven", "promising", "test"] as const;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Splits whole cents in proportion to the weights (equally when they sum to 0),
 * handing leftover cents to the largest remainders so the parts sum exactly.
 */
function splitCents(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const shares = weights.map((w) => (weightSum > 0 ? (totalCents * w) / weightSum : totalCents / weights.length));
  const parts = shares.map(Math.floor);
  let left = totalCents - parts.reduce((s, p) => s + p, 0);
  const byRemainder = shares.map((s, i) => ({ i, r: s - Math.floor(s) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    parts[i] += 1;
    left -= 1;
  }
  return parts;
}

type Run = { allocations: CategoryAllocation[]; projection: PlanProjection; tierCounts: Record<AllocationTier, number> };

export function buildStrategyPlan(input: {
  snapshot: MetaAuditSnapshot;
  scorecard: Pick<AuditScorecard, "score" | "grade">;
  categories: StrategyCategory[];
  goals: ResolvedGoals;
  brief: StrategyBrief;
  /** Word the assumptions use: "service" for non-ecommerce clients. */
  categoryWord?: "category" | "service";
}): StrategyPlan {
  const { snapshot, scorecard, categories, goals, brief } = input;
  const C = PLAN_CONSTANTS;
  const word = input.categoryWord ?? "category";
  const words = word === "category" ? "categories" : "services";
  const Word = word === "category" ? "Category" : "Service";
  const Words = word === "category" ? "Categories" : "Services";
  const days = snapshot.period.days;
  const accountRoas = snapshot.totals?.roas ?? null;
  const accountMarginPct = referenceMarginPct(goals.gross_margin_pct, categories);
  const attribution = attributeSpendToCategories(snapshot, categories);
  const perfById = new Map(attribution.byCategory.map((p) => [p.categoryId, p]));
  const capabilities = detectCapabilityGaps(snapshot, goals.business_model);
  const relevant = new Set(capabilities.map((c) => c.id));
  const testRoas = accountRoas ?? BENCHMARKS.prospectingRoas;

  const money = (cents: number) => {
    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency: snapshot.account.currency,
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: 2,
      }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${snapshot.account.currency}`;
    }
  };
  const pct = (share: number) => `${Math.round(share * 100)}%`;

  function run(accountTargetRoas: number): Run {
    const rows = categories.map((category) => {
      const perf = perfById.get(category.id) as CategoryPerformance;
      const target = categoryTargetRoas({
        accountTargetRoas,
        accountMarginPct,
        categoryMarginPct: category.grossMarginPct,
      });
      let tier: AllocationTier;
      if (perf.spendCents < C.minSpendForVerdictCents || perf.roas === null) tier = "test";
      else if (perf.roas >= target.targetRoas) tier = "proven";
      else if (perf.roas >= (target.breakEvenRoas ?? 0.5 * target.targetRoas)) tier = "promising";
      else tier = "hold";
      return { category, perf, target, tier, budget: 0 };
    });

    // An empty bucket's share goes to the next non-empty one, else the first non-empty one.
    const members = (tier: AllocationTier) => rows.filter((r) => r.tier === tier);
    const filled = FUNDED_TIERS.filter((t) => members(t).length > 0);
    const shares: Record<(typeof FUNDED_TIERS)[number], number> = { proven: 0, promising: 0, test: 0 };
    FUNDED_TIERS.forEach((tier, i) => {
      if (filled.length === 0) return;
      const to = filled.includes(tier) ? tier : (FUNDED_TIERS.slice(i + 1).find((t) => filled.includes(t)) ?? filled[0]);
      shares[to] += C.split[tier];
    });
    const bucketCents = splitCents(
      filled.length > 0 ? brief.dailyBudgetCents : 0,
      FUNDED_TIERS.map((t) => shares[t]),
    );

    for (const [i, tier] of FUNDED_TIERS.entries()) {
      const bucket = members(tier);
      if (bucket.length === 0) continue;
      if (tier !== "test") {
        splitCents(bucketCents[i], bucket.map((r) => r.perf.purchaseValueCents)).forEach((cents, j) => {
          bucket[j].budget = cents;
        });
        continue;
      }
      // Tests: highest priority first, then name; fund as many as the minimum allows, at least one.
      const ranked = [...bucket].sort(
        (a, b) => b.category.priority - a.category.priority || a.category.name.localeCompare(b.category.name),
      );
      const funded = Math.min(ranked.length, Math.max(1, Math.floor(bucketCents[i] / C.minTestDailyCents)));
      splitCents(bucketCents[i], Array<number>(funded).fill(1)).forEach((cents, j) => {
        ranked[j].budget = cents;
      });
    }

    const allocations = rows.map(({ category, perf, target, tier, budget }): CategoryAllocation => {
      let revenue = 0;
      if (tier === "proven" || tier === "promising") revenue = budget * (perf.roas ?? 0) * C.scaleDecay;
      else if (tier === "test") revenue = budget * testRoas * C.testDiscount;
      return {
        categoryId: category.id,
        name: category.name,
        tier,
        targetRoas: target.targetRoas,
        targetBasis: target.basis,
        observedRoas: perf.roas,
        observedSpendCents: perf.spendCents,
        dailyBudgetCents: budget,
        projectedDailyRevenueCents: Math.round(revenue),
        structure: STRUCTURE[tier].filter((id) => relevant.has(id)),
      };
    });

    const spend = allocations.reduce((s, a) => s + a.dailyBudgetCents, 0);
    const revenue = allocations.reduce((s, a) => s + a.projectedDailyRevenueCents, 0);
    const blendedRoas = spend > 0 ? round2(revenue / spend) : null;
    const tierCounts: Record<AllocationTier, number> = { proven: 0, promising: 0, test: 0, hold: 0 };
    for (const a of allocations) tierCounts[a.tier] += 1;
    return {
      allocations,
      projection: {
        dailySpendCents: spend,
        dailyRevenueCents: revenue,
        blendedRoas,
        meetsTarget: blendedRoas !== null && blendedRoas >= accountTargetRoas,
      },
      tierCounts,
    };
  }

  const main = run(brief.targetRoas);
  const mainTarget = round2(brief.targetRoas);
  const scenarioTargets = [...new Set(brief.stretchTargets.map(round2))]
    .filter((t) => t !== mainTarget)
    .sort((a, b) => a - b);

  const referenceRoas = round2(Math.max(BENCHMARKS.retargetingRoas, accountRoas ?? 0));
  const multiple = round2(brief.targetRoas / referenceRoas);
  const references = [
    { metric: "Prospecting ROAS", value: `${BENCHMARKS.prospectingRoas}×`, source: PLAYBOOK_SOURCE },
    { metric: "Retargeting ROAS", value: `${BENCHMARKS.retargetingRoas}×`, source: PLAYBOOK_SOURCE },
  ];
  if (accountRoas !== null) {
    references.push({ metric: "Account ROAS", value: `${round2(accountRoas)}×`, source: `This account, last ${days} days` });
  }

  const assumptions = [
    `Budget split ${pct(C.split.proven)} proven, ${pct(C.split.promising)} promising, ${pct(C.split.test)} test; an empty tier's share moves to the next tier.`,
    `Within the proven and promising tiers, budget follows each ${word}'s purchase value.`,
    `Test ${words} are funded at ${money(C.minTestDailyCents)}/day each, highest priority first, as far as the test budget allows; a test budget under ${money(C.minTestDailyCents)} goes entirely to the top test ${word}.`,
    `A ${word} needs ${money(C.minSpendForVerdictCents)} of spend in the last ${days} days before it is judged; below that it is a test.`,
    `Scaled budgets assumed to return ${pct(C.scaleDecay)} of current ROAS.`,
    accountRoas !== null
      ? `Test budgets assumed to return ${pct(C.testDiscount)} of the account ROAS (${round2(accountRoas)}×).`
      : `Test budgets assumed to return ${pct(C.testDiscount)} of the ${BENCHMARKS.prospectingRoas}× prospecting benchmark, since the account has no ROAS.`,
    accountMarginPct !== null
      ? `${Word} targets keep the account's profit per ad dollar: target × ${accountMarginPct}% account margin ÷ ${word} margin; ${words} without a margin use the account target.`
      : `No margin is known, so every ${word} uses the account target ROAS.`,
    `${Words} below break-even ROAS, or below half their target when the margin is unknown, are held at no budget.`,
    `The target is compared with the higher of the ${BENCHMARKS.retargetingRoas}× retargeting benchmark and the account ROAS: up to ${REALITY.within}× that is within reach, up to ${REALITY.stretch}× a stretch, beyond that unrealistic.`,
    `Benchmarks (${BENCHMARKS.prospectingRoas}× prospecting, ${BENCHMARKS.retargetingRoas}× retargeting ROAS) come from the internal paid-social playbook (generic, not industry-specific).`,
  ];
  for (const category of categories) {
    const perf = perfById.get(category.id) as CategoryPerformance;
    if (perf.spendCents >= C.minSpendForVerdictCents && perf.roas === null) {
      assumptions.push(`ROAS was unavailable for ${category.name}, so it is treated as a test.`);
    }
  }

  return {
    brief,
    baseline: {
      score: scorecard.score,
      grade: scorecard.grade,
      periodDays: days,
      spendCents: snapshot.totals?.spendCents ?? 0,
      roas: accountRoas,
      categoriesTotal: categories.length,
      categoriesWithSpend: attribution.byCategory.filter((p) => p.spendCents > 0).length,
      coveragePct: attribution.coveragePct,
    },
    benchmark: {
      references,
      realityCheck: {
        targetRoas: mainTarget,
        referenceRoas,
        multiple,
        verdict: multiple <= REALITY.within ? "within" : multiple <= REALITY.stretch ? "stretch" : "unrealistic",
      },
    },
    allocations: main.allocations,
    gaps: {
      capabilities,
      untouchedCategoryIds: attribution.byCategory.filter((p) => p.spendCents === 0).map((p) => p.categoryId),
    },
    projection: main.projection,
    scenarios: scenarioTargets.map((targetRoas) => {
      const scenario = run(targetRoas);
      return { targetRoas, projection: scenario.projection, tierCounts: scenario.tierCounts };
    }),
    assumptions,
  };
}
