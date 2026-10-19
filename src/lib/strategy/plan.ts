import { BENCHMARKS, type AuditScorecard } from "@/lib/audit/checkpoints";
import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { ResolvedGoals } from "@/lib/clients/goals";
import type { StrategyCategory } from "./categories";
import { attributeSpendToCategories, type CategoryPerformance } from "./category-attribution";
import type { CategoryChannels, ChannelFigures, ChannelPerformance } from "./channels";
import {
  detectGoogleCapabilities,
  recommendGoogleCampaignTypes,
  type GoogleCapabilityId,
  type GoogleCapabilityStatus,
} from "./google-capabilities";
import { detectCapabilityGaps, type CapabilityStatus, type MetaCapabilityId } from "./meta-capabilities";
import { categoryTargetRoas, referenceMarginPct } from "./targets";

export type StrategyBrief = {
  dailyBudgetCents: number;
  targetRoas: number;
  stretchTargets: number[];
  /** The brief's total budget and period, when it was given that way; dailyBudgetCents is what the engine uses. */
  totalBudgetCents?: number | null;
  periodDays?: number | null;
};
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
  /** Meta / Google share of the daily budget; null when unfunded or when the plan makes no split. */
  channelSplit: {
    metaCents: number;
    googleCents: number;
    metaProjectedCents: number;
    googleProjectedCents: number;
    basis: "ga4" | "platform";
  } | null;
  /** Campaign types to recommend for the Google Ads account; empty without a Google share. */
  googleCampaignTypes: GoogleCapabilityId[];
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
  /** The one category to test next: the top funded test, else the top funded promising one. */
  nextTest: { categoryId: string; name: string; dailyBudgetCents: number; durationDays: number } | null;
  assumptions: string[];
  /** Where category revenue came from: GA4 when available, else what the ad platforms report. */
  revenueBasis: "ga4" | "platform";
  /** Daily budget by channel across the plan; null when the plan makes no split. */
  channelTotals: { metaCents: number; googleCents: number } | null;
  /** Why there is no split or Google wasn't considered; null when Meta and Google were both planned. */
  channelNote: string | null;
  /** The categories the plan was asked for; null for a whole-account plan. */
  scope: { categoryIds: string[]; names: string[] } | null;
  googleCapabilities: GoogleCapabilityStatus[] | null;
};

export const PLAN_CONSTANTS = {
  split: { proven: 0.7, promising: 0.2, test: 0.1 },
  minTestDailyCents: 2000,
  scaleDecay: 0.85,
  testDiscount: 0.7,
  minSpendForVerdictCents: 5000,
  testDurationDays: 14,
  /** Share of a funded category's budget a channel with no spend gets when it shows demand. */
  minChannelTestShare: 0.2,
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

/** What the plan judges a category on: Meta alone, or Meta + Google on the plan's revenue basis. */
type Observed = {
  spendCents: number;
  revenueCents: number;
  roas: number | null;
  /** The category's channel figures; null when the plan makes no channel split. */
  channel: CategoryChannels | null;
  /** A GA4-basis plan had no GA4 figure for the category, so it uses platform revenue. */
  ga4Fallback: boolean;
};

/** Channel figures for a category the channel data left out: its Meta attribution, no Google. */
function metaOnlyChannels(perf: CategoryPerformance): CategoryChannels {
  const none: ChannelFigures = { spendCents: 0, platformRevenueCents: 0, ga4RevenueCents: null, roas: null, basis: "none" };
  return {
    categoryId: perf.categoryId,
    meta: {
      spendCents: perf.spendCents,
      platformRevenueCents: perf.purchaseValueCents,
      ga4RevenueCents: null,
      roas: perf.roas,
      basis: perf.roas === null ? "none" : "platform",
    },
    google: none,
    ga4TotalRevenueCents: null,
    searchImpressions: 0,
    searchClicks: 0,
    topQueries: [],
  };
}

export function buildStrategyPlan(input: {
  snapshot: MetaAuditSnapshot;
  scorecard: Pick<AuditScorecard, "score" | "grade">;
  categories: StrategyCategory[];
  goals: ResolvedGoals;
  brief: StrategyBrief;
  /** Word the assumptions use: "service" for non-ecommerce clients. */
  categoryWord?: "category" | "service";
  /** Meta and Google figures per category. Without them, or when currencies differ, the plan is Meta-only. */
  channels?: ChannelPerformance;
  /** Plan only these categories, splitting the whole budget across them. */
  scopeCategoryIds?: string[];
}): StrategyPlan {
  const { snapshot, scorecard, categories, goals, brief } = input;
  const C = PLAN_CONSTANTS;
  const word = input.categoryWord ?? "category";
  const words = word === "category" ? "categories" : "services";
  const Word = word === "category" ? "Category" : "Service";
  const Words = word === "category" ? "Categories" : "Services";
  const days = snapshot.period.days;
  const accountMarginPct = referenceMarginPct(goals.gross_margin_pct, categories);
  const attribution = attributeSpendToCategories(snapshot, categories);
  const perfById = new Map(attribution.byCategory.map((p) => [p.categoryId, p]));
  const capabilities = detectCapabilityGaps(snapshot, goals.business_model);
  const relevant = new Set(capabilities.map((c) => c.id));

  // A currency mismatch rules out every combined figure, so it is checked before any is read.
  const channels = input.channels && !input.channels.currencyMismatch ? input.channels : null;
  const revenueBasis: StrategyPlan["revenueBasis"] = channels?.ga4Available ? "ga4" : "platform";
  const googleMapped = channels?.googleAdsMapped ?? false;
  const channelById = new Map((channels?.byCategory ?? []).map((c) => [c.categoryId, c]));

  const observedById = new Map(
    categories.map((category): [string, Observed] => {
      const perf = perfById.get(category.id) as CategoryPerformance;
      if (!channels) {
        const meta = { spendCents: perf.spendCents, revenueCents: perf.purchaseValueCents, roas: perf.roas };
        return [category.id, { ...meta, channel: null, ga4Fallback: false }];
      }
      const ch = channelById.get(category.id) ?? metaOnlyChannels(perf);
      const spendCents = ch.meta.spendCents + ch.google.spendCents;
      const ga4Total = revenueBasis === "ga4" ? ch.ga4TotalRevenueCents : null;
      // Meta spend without a Meta ROAS leaves platform revenue unknown, whatever Google reports.
      const platformKnown = spendCents > 0 && !(ch.meta.spendCents > 0 && perf.roas === null);
      const revenueCents = ga4Total ?? ch.meta.platformRevenueCents + ch.google.platformRevenueCents;
      const known = ga4Total !== null || platformKnown;
      return [
        category.id,
        {
          spendCents,
          revenueCents,
          roas: spendCents > 0 && known ? round2(revenueCents / spendCents) : null,
          channel: ch,
          ga4Fallback: revenueBasis === "ga4" && ga4Total === null,
        },
      ];
    }),
  );

  // With channels, the account ROAS is over all Meta + Google spend, matched to a category or not.
  // GA4 revenue only exists per matched category; platform revenue is each account's whole total.
  // When no category has a ROAS it stays the Meta account's own.
  const metaAccountRoas = snapshot.totals?.roas ?? null;
  let accountRoas = metaAccountRoas;
  let combinedAccountRoas = false;
  const allObserved = [...observedById.values()];
  if (channels && allObserved.some((o) => o.roas !== null)) {
    const attributedMeta = attribution.byCategory.reduce((s, p) => s + p.spendCents, 0);
    const spend =
      allObserved.reduce((s, o) => s + o.spendCents, 0) +
      channels.googleUnmatchedSpendCents +
      Math.max(0, (snapshot.totals?.spendCents ?? 0) - attributedMeta);
    let revenue: number;
    if (revenueBasis === "ga4") revenue = allObserved.reduce((s, o) => s + o.revenueCents, 0);
    else {
      const metaRevenue =
        snapshot.totals && snapshot.totals.roas !== null
          ? snapshot.totals.spendCents * snapshot.totals.roas
          : allObserved.reduce((s, o) => s + (o.channel?.meta.platformRevenueCents ?? 0), 0);
      const googleRevenue = (channels.ads?.campaigns ?? []).reduce((s, c) => s + Math.max(0, c.conversionValueCents), 0);
      revenue = metaRevenue + googleRevenue;
    }
    if (spend > 0) {
      accountRoas = round2(revenue / spend);
      combinedAccountRoas = true;
    }
  }
  const testRoas = accountRoas ?? BENCHMARKS.prospectingRoas;

  const scopeIds = new Set(input.scopeCategoryIds ?? []);
  const scoped = categories.filter((c) => scopeIds.has(c.id));
  const planned = scoped.length > 0 ? scoped : categories;

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

  /**
   * Projected revenue per budget cent on one channel: its ROAS scaled, else a discounted test
   * return. A test category's channels are all unproven, so they all take the test return.
   */
  const channelRate = (f: ChannelFigures, tier: AllocationTier) =>
    tier !== "test" && f.spendCents > 0 && f.roas !== null ? f.roas * C.scaleDecay : testRoas * C.testDiscount;

  /**
   * Splits a funded category's budget by each channel's ROAS. A channel with no spend gets the
   * test share when it shows demand (Google: search impressions; Meta: a landing page); with no
   * Google Ads account mapped, or no data on either channel, it all stays on Meta.
   */
  function splitChannels(
    category: StrategyCategory,
    tier: AllocationTier,
    budget: number,
    ch: CategoryChannels,
  ): CategoryAllocation["channelSplit"] {
    const { meta, google } = ch;
    const share = C.minChannelTestShare;
    const metaSpends = meta.spendCents > 0;
    const googleSpends = googleMapped && google.spendCents > 0;
    const weight = (f: ChannelFigures) => f.roas ?? testRoas * C.testDiscount;
    let weights: [number, number];
    if (metaSpends && googleSpends) weights = [weight(meta), weight(google)];
    else if (googleSpends) weights = category.landingPageUrl?.trim() ? [share, 1 - share] : [0, 1];
    else weights = googleMapped && ch.searchImpressions > 0 ? [1 - share, share] : [1, 0];
    const [metaCents, googleCents] = splitCents(budget, weights);

    // The basis is GA4 only when every channel ROAS behind the funded shares came from GA4.
    const used = [meta, google].filter((f, i) => [metaCents, googleCents][i] > 0 && f.spendCents > 0 && f.roas !== null);
    const basis = used.length === 0 ? revenueBasis : used.every((f) => f.basis === "ga4") ? "ga4" : "platform";
    return {
      metaCents,
      googleCents,
      metaProjectedCents: Math.round(metaCents * channelRate(meta, tier)),
      googleProjectedCents: Math.round(googleCents * channelRate(google, tier)),
      basis,
    };
  }

  function run(accountTargetRoas: number): Run {
    const rows = planned.map((category) => {
      const observed = observedById.get(category.id) as Observed;
      const target = categoryTargetRoas({
        accountTargetRoas,
        accountMarginPct,
        categoryMarginPct: category.grossMarginPct,
      });
      let tier: AllocationTier;
      if (observed.spendCents < C.minSpendForVerdictCents || observed.roas === null) tier = "test";
      else if (observed.roas >= target.targetRoas) tier = "proven";
      else if (observed.roas >= (target.breakEvenRoas ?? 0.5 * target.targetRoas)) tier = "promising";
      else tier = "hold";
      return { category, observed, target, tier, budget: 0 };
    });

    if (scoped.length > 0) {
      // A scoped plan was asked for these categories: the whole budget, by revenue, whatever the tier.
      splitCents(brief.dailyBudgetCents, rows.map((r) => r.observed.revenueCents)).forEach((cents, j) => {
        rows[j].budget = cents;
      });
    } else {
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
          splitCents(bucketCents[i], bucket.map((r) => r.observed.revenueCents)).forEach((cents, j) => {
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
    }

    const allocations = rows.map(({ category, observed, target, tier, budget }): CategoryAllocation => {
      const channelSplit = observed.channel && budget > 0 ? splitChannels(category, tier, budget, observed.channel) : null;
      // A hold funded by a scoped plan gets a test's setup, so its budget has somewhere to go.
      const setupTier: AllocationTier = tier === "hold" && budget > 0 ? "test" : tier;
      // Holds only have budget in a scoped plan; they then project like a scaled category.
      let revenue: number;
      if (channelSplit) revenue = channelSplit.metaProjectedCents + channelSplit.googleProjectedCents;
      else if (tier === "test") revenue = budget * testRoas * C.testDiscount;
      else revenue = budget * (observed.roas ?? 0) * C.scaleDecay;
      return {
        categoryId: category.id,
        name: category.name,
        tier,
        targetRoas: target.targetRoas,
        targetBasis: target.basis,
        observedRoas: observed.roas,
        observedSpendCents: observed.spendCents,
        dailyBudgetCents: budget,
        projectedDailyRevenueCents: Math.round(revenue),
        structure: STRUCTURE[setupTier].filter((id) => relevant.has(id)),
        channelSplit,
        googleCampaignTypes:
          channelSplit && channelSplit.googleCents > 0
            ? recommendGoogleCampaignTypes({
                tier: setupTier,
                merchantCenterLinked: channels?.ads?.merchantCenterLinked ?? false,
                searchImpressions: observed.channel?.searchImpressions ?? 0,
              })
            : [],
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
    const covers = revenueBasis === "ga4" ? "GA4 revenue on matched categories" : "platform-reported revenue";
    const source = !channels
      ? `This account, last ${days} days`
      : combinedAccountRoas
        ? `Meta + Google spend, ${covers}, last ${days} days`
        : `Meta only, last ${days} days`;
    references.push({ metric: "Account ROAS", value: `${round2(accountRoas)}×`, source });
  }

  const channelNote = !input.channels
    ? "No Google data was loaded: the plan uses Meta figures only."
    : input.channels.currencyMismatch
      ? `${input.channels.currencyMismatch} The plan uses Meta figures only, with no Meta and Google split.`
      : !input.channels.googleAdsMapped
        ? "No Google Ads account mapped: Google wasn't considered."
        : null;
  const scope = scoped.length > 0 ? { categoryIds: scoped.map((c) => c.id), names: scoped.map((c) => c.name) } : null;

  const assumptions: string[] = [];
  if (scope) {
    assumptions.push(
      scope.names.length === 1
        ? `Planned only for ${scope.names[0]}: the whole budget goes to it; its tier is shown but doesn't split the budget.`
        : `Planned only for ${scope.names.join(", ")}: the whole budget is split across them by revenue (equally when none has any); tiers are shown but don't split the budget.`,
    );
    const missing = scopeIds.size - scoped.length;
    if (missing > 0) {
      assumptions.push(
        `${missing} named ${missing === 1 ? `${word} wasn't` : `${words} weren't`} found; the plan covers only the ones that were.`,
      );
    }
  } else {
    if (scopeIds.size > 0) assumptions.push(`None of the named ${words} are loaded; planned the whole account.`);
    assumptions.push(
      `Budget split ${pct(C.split.proven)} proven, ${pct(C.split.promising)} promising, ${pct(C.split.test)} test; an empty tier's share moves to the next tier.`,
      `Within the proven and promising tiers, budget follows each ${word}'s ${channels ? "revenue" : "purchase value"}.`,
      `Test ${words} are funded at ${money(C.minTestDailyCents)}/day each, highest priority first, as far as the test budget allows; a test budget under ${money(C.minTestDailyCents)} goes entirely to the top test ${word}.`,
    );
  }
  assumptions.push(
    `A ${word} needs ${money(C.minSpendForVerdictCents)} of spend in the last ${days} days before it is judged; below that it is a test.`,
    `Scaled budgets assumed to return ${pct(C.scaleDecay)} of current ROAS.`,
    accountRoas !== null
      ? `Test budgets assumed to return ${pct(C.testDiscount)} of the account ROAS (${round2(accountRoas)}×).`
      : `Test budgets assumed to return ${pct(C.testDiscount)} of the ${BENCHMARKS.prospectingRoas}× prospecting benchmark, since the account has no ROAS.`,
    accountMarginPct !== null
      ? `${Word} targets keep the account's profit per ad dollar: target × ${accountMarginPct}% account margin ÷ ${word} margin; ${words} without a margin use the account target.`
      : `No margin is known, so every ${word} uses the account target ROAS.`,
  );
  if (!scope) {
    assumptions.push(`${Words} below break-even ROAS, or below half their target when the margin is unknown, are held at no budget.`);
  }
  assumptions.push(
    `The target is compared with the higher of the ${BENCHMARKS.retargetingRoas}× retargeting benchmark and the account ROAS: up to ${REALITY.within}× that is within reach, up to ${REALITY.stretch}× a stretch, beyond that unrealistic.`,
    `Benchmarks (${BENCHMARKS.prospectingRoas}× prospecting, ${BENCHMARKS.retargetingRoas}× retargeting ROAS) come from the internal paid-social playbook (generic, not industry-specific).`,
    `The next test is the highest-priority funded test ${word} (else the funded promising ${word} with the biggest budget), run for ${C.testDurationDays} days at its planned daily budget.`,
  );
  for (const category of planned) {
    const observed = observedById.get(category.id) as Observed;
    if (observed.spendCents >= C.minSpendForVerdictCents && observed.roas === null) {
      assumptions.push(`ROAS was unavailable for ${category.name}, so it is treated as a test.`);
    }
  }
  if (scope) {
    for (const a of main.allocations.filter((x) => x.tier === "hold" && x.dailyBudgetCents > 0)) {
      assumptions.push(`${a.name} is below break-even; funded because the plan was asked for it.`);
    }
  }
  // A plan built without channel data keeps exactly the Meta-only assumptions.
  if (input.channels && !channels) {
    assumptions.push(`Revenue is what Meta reports for each ${word}.`);
  } else if (channels && revenueBasis === "ga4") {
    const matchedBy = channels.ga4Method === "item" ? "item category" : "landing page";
    assumptions.push(`Revenue is GA4's for each ${word} (matched by ${matchedBy}), against its Meta + Google spend.`);
    const fallbacks = planned.filter((c) => observedById.get(c.id)?.ga4Fallback).length;
    if (fallbacks > 0) {
      assumptions.push(
        `${fallbacks} ${fallbacks === 1 ? `${word} has` : `${words} have`} no GA4 revenue figure, so ${fallbacks === 1 ? "it uses" : "they use"} the revenue Meta and Google Ads report.`,
      );
    }
  } else if (channels) {
    assumptions.push(`Revenue is what Meta and Google Ads report for each ${word}, since GA4 isn't available; spend is Meta + Google.`);
  }
  if (channels && googleMapped) {
    assumptions.push(
      `Within each funded ${word}, budget splits between Meta and Google by each channel's ROAS; a channel with no spend gets a ${pct(C.minChannelTestShare)} test share when it shows demand (Google: search impressions; Meta: a landing page) and is assumed to return ${pct(C.testDiscount)} of the account ROAS. The Google share is a recommendation for the Google Ads account — this tool doesn't change Google.`,
    );
  }
  if (input.channels && channelNote) assumptions.push(channelNote);

  const funded = (tier: AllocationTier) => main.allocations.filter((a) => a.tier === tier && a.dailyBudgetCents > 0);
  const priorityOf = new Map(categories.map((c) => [c.id, c.priority]));
  const pick =
    funded("test").sort(
      (a, b) => (priorityOf.get(b.categoryId) ?? 0) - (priorityOf.get(a.categoryId) ?? 0) || a.name.localeCompare(b.name),
    )[0] ?? funded("promising").sort((a, b) => b.dailyBudgetCents - a.dailyBudgetCents || a.name.localeCompare(b.name))[0];
  const nextTest = pick
    ? { categoryId: pick.categoryId, name: pick.name, dailyBudgetCents: pick.dailyBudgetCents, durationDays: C.testDurationDays }
    : null;

  return {
    brief,
    baseline: {
      score: scorecard.score,
      grade: scorecard.grade,
      periodDays: days,
      spendCents: snapshot.totals?.spendCents ?? 0,
      roas: metaAccountRoas,
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
    nextTest,
    assumptions,
    revenueBasis,
    channelTotals: channels
      ? {
          metaCents: main.allocations.reduce((s, a) => s + (a.channelSplit?.metaCents ?? 0), 0),
          googleCents: main.allocations.reduce((s, a) => s + (a.channelSplit?.googleCents ?? 0), 0),
        }
      : null,
    channelNote,
    scope,
    googleCapabilities: channels && googleMapped ? detectGoogleCapabilities(channels.ads) : null,
  };
}
