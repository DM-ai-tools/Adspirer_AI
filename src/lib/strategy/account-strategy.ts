/**
 * The numbers behind an account strategy: what the account is for (sales, leads or another
 * result), where it stands, where its money is wasted or working, and — when the operator gave
 * no target — three targets the account's own figures support. Every figure is worked out here
 * from Meta's rows; the writer only explains them.
 */
import type { AuditAdSet, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import type { BUSINESS_MODELS } from "@/lib/clients/goals";

export type GoalKind = "sales" | "leads" | "other";

const LEAD_MODELS = new Set<string>(["lead_gen", "local_service", "b2b"]);
const SALES_OBJECTIVES = /^(OUTCOME_SALES|CONVERSIONS|PRODUCT_CATALOG_SALES)$/;
const LEAD_OBJECTIVES = /^(OUTCOME_LEADS|LEAD_GENERATION)$/;

/** What the account is run for, and why we think so. */
export type AccountGoal = {
  kind: GoalKind;
  /** "purchase", "lead", or Meta's own result label for anything else. */
  unit: string;
  /** "the client's business type (ecommerce)" / "82% of spend is on Sales campaigns". */
  basis: string;
};

/**
 * Sales, leads or another result. The client's business type decides when it says sales or leads;
 * otherwise (unset or "other") the account's own spend does: the objective most of the money runs
 * on, then whichever of purchases or leads it actually got. A lead-gen account is never asked for a ROAS.
 */
export function accountGoal(
  snapshot: MetaAuditSnapshot,
  businessModel: (typeof BUSINESS_MODELS)[number] | undefined,
): AccountGoal {
  if (businessModel === "ecommerce") return { kind: "sales", unit: "purchase", basis: "the client's business type (ecommerce)" };
  if (businessModel && LEAD_MODELS.has(businessModel)) {
    return { kind: "leads", unit: "lead", basis: `the client's business type (${businessModel.replace(/_/g, " ")})` };
  }
  let sales = 0;
  let leads = 0;
  let total = 0;
  for (const c of snapshot.campaigns) {
    const spend = c.performance?.spendCents ?? 0;
    total += spend;
    if (SALES_OBJECTIVES.test(c.objective)) sales += spend;
    else if (LEAD_OBJECTIVES.test(c.objective)) leads += spend;
  }
  const pct = (n: number) => Math.round((n / total) * 100);
  if (total > 0 && sales / total >= 0.5) return { kind: "sales", unit: "purchase", basis: `${pct(sales)}% of spend is on Sales campaigns` };
  if (total > 0 && leads / total >= 0.5) return { kind: "leads", unit: "lead", basis: `${pct(leads)}% of spend is on Leads campaigns` };
  const purchases = snapshot.totals?.purchases ?? 0;
  const leadCount = snapshot.totals?.leads ?? 0;
  if (purchases > 0 && purchases >= leadCount) return { kind: "sales", unit: "purchase", basis: "the account records purchases" };
  if (leadCount > 0) return { kind: "leads", unit: "lead", basis: "the account records leads" };
  const label = snapshot.totals?.resultLabel?.trim() || "result";
  return { kind: "other", unit: label.toLowerCase(), basis: `Meta's result for this account is "${label}"` };
}

/** The conversions that count for this goal in one row: purchases, leads, or Meta's results. */
export function conversionsOf(p: PeriodPerformance | null | undefined, kind: GoalKind): number | null {
  if (!p) return null;
  if (kind === "sales") return p.purchases ?? (/purchase/i.test(p.resultLabel) ? p.results : null);
  if (kind === "leads") return p.leads ?? (/lead|registration|contact|submit|enquir|book|appointment/i.test(p.resultLabel) ? p.results : null);
  return p.results;
}

// ---------------------------------------------------------------------------
// Where the account stands, and where its money goes

export type Baseline = {
  days: number;
  spendPerDayCents: number;
  conversions: number;
  conversionsPerDay: number;
  /** Null when there were no conversions. */
  costPerCents: number | null;
  /** Sales only. */
  roas: number | null;
  revenuePerDayCents: number | null;
};

export type AdSetRead = {
  id: string;
  name: string;
  status: string;
  /** Meta's optimisation goal, e.g. OFFSITE_CONVERSIONS, CONVERSATIONS. */
  optimizationGoal: string | null;
  /** Its own result as Meta reports it ("Messaging conversations started"), for ad sets judged on something else. */
  ownResults: number | null;
  ownResultLabel: string;
  spendCents: number;
  conversions: number;
  costPerCents: number | null;
  roas: number | null;
  learningLimited: boolean;
  frequency7d: number | null;
};

export type Levers = {
  /**
   * Ad sets optimised for a different result (engagement, clicks, conversations that brought none of
   * the account's conversions): judging them on purchases or leads would call them waste unfairly.
   */
  otherGoal: AdSetRead[];
  /** Ad sets that cost at least twice the account's cost per conversion (or spent that much for none). */
  waste: AdSetRead[];
  wasteSpendCents: number;
  /** Ad sets that wasted money in the period but are already off: no saving left to make. */
  stoppedWaste: AdSetRead[];
  /** Ad sets beating the account by 20%+ on enough conversions to trust it. */
  winners: AdSetRead[];
  /** Cost per conversion of everything that isn't waste: what the account costs once the waste stops. */
  costWithoutWasteCents: number | null;
  roasWithoutWaste: number | null;
  /** Cost per conversion if the waste spend moved to the winners (at a 30% worse cost, since scaling costs more). */
  costWithShiftCents: number | null;
  roasWithShift: number | null;
  /** Under ~15 conversions in the period: every projection is directional. */
  thinData: boolean;
};

/** Delivering or able to deliver: not paused, archived or deleted at any level. */
function isRunning(status: string): boolean {
  return /^(ACTIVE|WITH_ISSUES|IN_PROCESS|PENDING_REVIEW|PREAPPROVED)$/.test(status);
}

/** Goals that never aim at a purchase or a lead: engagement, traffic, awareness, video. */
const NON_CONVERSION_GOALS = /^(POST_ENGAGEMENT|PAGE_LIKES|EVENT_RESPONSES|LINK_CLICKS|LANDING_PAGE_VIEWS|REACH|IMPRESSIONS|AD_RECALL_LIFT|THRUPLAY|VIDEO_VIEWS|TWO_SECOND_CONTINUOUS_VIDEO_VIEWS|PROFILE_VISIT|VISIT_INSTAGRAM_PROFILE)$/;

/**
 * Whether an ad set is trying to get this account's conversions. Engagement, traffic and awareness
 * goals never are; a conversations goal is when it brought any (for a local business a chat is often
 * the lead), otherwise it is judged on its own result. "other" accounts judge every ad set.
 */
function aimsAtGoal(r: AdSetRead, kind: GoalKind): boolean {
  if (kind === "other" || !r.optimizationGoal) return true;
  if (NON_CONVERSION_GOALS.test(r.optimizationGoal)) return false;
  if (r.optimizationGoal === "CONVERSATIONS") return r.conversions > 0;
  return true;
}

/** A winner must have at least this many conversions; fewer is noise. */
const MIN_WINNER_CONVERSIONS = 5;
const THIN_DATA_CONVERSIONS = 15;
/** Moving money to a winner rarely buys at its old cost: allow 30% worse. */
export const SCALE_PENALTY = 1.3;

export function baselineOf(snapshot: MetaAuditSnapshot, kind: GoalKind): Baseline | null {
  const t = snapshot.totals;
  if (!t) return null;
  const days = Math.max(1, snapshot.period.days);
  const conversions = conversionsOf(t, kind) ?? 0;
  const revenue = kind === "sales" ? (t.purchaseValueCents ?? null) : null;
  return {
    days,
    spendPerDayCents: Math.round(t.spendCents / days),
    conversions,
    conversionsPerDay: conversions / days,
    costPerCents: conversions > 0 ? Math.round(t.spendCents / conversions) : null,
    roas: revenue != null && t.spendCents > 0 ? revenue / t.spendCents : null,
    revenuePerDayCents: revenue != null ? Math.round(revenue / days) : null,
  };
}

function readAdSet(a: AuditAdSet, kind: GoalKind): AdSetRead | null {
  const p = a.performance;
  if (!p || p.spendCents <= 0) return null;
  const conversions = conversionsOf(p, kind) ?? 0;
  return {
    id: a.id,
    name: a.name,
    status: a.status,
    optimizationGoal: a.optimizationGoal,
    ownResults: p.results,
    ownResultLabel: p.resultLabel,
    spendCents: p.spendCents,
    conversions,
    costPerCents: conversions > 0 ? Math.round(p.spendCents / conversions) : null,
    roas: kind === "sales" && p.purchaseValueCents != null && p.spendCents > 0 ? p.purchaseValueCents / p.spendCents : null,
    learningLimited: a.learningStatus === "FAIL",
    frequency7d: a.frequency7d,
  };
}

export function leversOf(snapshot: MetaAuditSnapshot, kind: GoalKind, baseline: Baseline): Levers {
  const rows = snapshot.adSets.map((a) => readAdSet(a, kind)).filter((r): r is AdSetRead => r != null);
  const cost = baseline.costPerCents;
  const empty: Levers = {
    otherGoal: [],
    waste: [],
    wasteSpendCents: 0,
    stoppedWaste: [],
    winners: [],
    costWithoutWasteCents: cost,
    roasWithoutWaste: baseline.roas,
    costWithShiftCents: cost,
    roasWithShift: baseline.roas,
    thinData: baseline.conversions < THIN_DATA_CONVERSIONS,
  };
  if (cost == null) {
    // No conversions at all: nothing to compare against. Anything that spent is unproven, not "waste".
    return empty;
  }
  // Only ad sets trying to get this account's conversions are judged on them.
  const otherGoal = rows.filter((r) => !aimsAtGoal(r, kind));
  const judged = rows.filter((r) => aimsAtGoal(r, kind));
  const wasting = judged
    .filter((r) => r.spendCents >= 2 * cost && (r.costPerCents == null || r.costPerCents >= 2 * cost))
    .sort((a, b) => b.spendCents - a.spendCents);
  // Only what is still running is a saving to make; an ad set already off stays in "the rest" (conservative).
  const waste = wasting.filter((r) => isRunning(r.status));
  const stoppedWaste = wasting.filter((r) => !isRunning(r.status));
  const winners = judged
    .filter((r) => r.conversions >= MIN_WINNER_CONVERSIONS && r.costPerCents != null && r.costPerCents <= cost * 0.8)
    .sort((a, b) => (a.costPerCents ?? 0) - (b.costPerCents ?? 0));
  const wasteIds = new Set(waste.map((w) => w.id));
  const totalSpend = snapshot.totals!.spendCents;
  const wasteSpend = waste.reduce((s, r) => s + r.spendCents, 0);
  const wasteConv = waste.reduce((s, r) => s + r.conversions, 0);
  const restSpend = totalSpend - wasteSpend;
  const restConv = baseline.conversions - wasteConv;
  const totalRevenue = snapshot.totals!.purchaseValueCents ?? null;
  const wasteRevenue = rows.filter((r) => wasteIds.has(r.id)).reduce((s, r) => s + (r.roas ?? 0) * r.spendCents, 0);

  const costWithoutWasteCents = restConv > 0 && restSpend > 0 ? Math.round(restSpend / restConv) : cost;
  const roasWithoutWaste = kind === "sales" && totalRevenue != null && restSpend > 0 ? (totalRevenue - wasteRevenue) / restSpend : baseline.roas;

  // The waste spend, moved to the winners at their spend-weighted cost, made 30% worse for scaling.
  const winSpend = winners.reduce((s, r) => s + r.spendCents, 0);
  const winConv = winners.reduce((s, r) => s + r.conversions, 0);
  let costWithShiftCents = costWithoutWasteCents;
  let roasWithShift = roasWithoutWaste;
  if (wasteSpend > 0 && winConv > 0) {
    const winCost = (winSpend / winConv) * SCALE_PENALTY;
    const conv = restConv + wasteSpend / winCost;
    costWithShiftCents = conv > 0 ? Math.round(totalSpend / conv) : costWithoutWasteCents;
    if (kind === "sales" && totalRevenue != null) {
      const winRoas = winners.reduce((s, r) => s + (r.roas ?? 0) * r.spendCents, 0) / winSpend / SCALE_PENALTY;
      roasWithShift = (totalRevenue - wasteRevenue + wasteSpend * winRoas) / totalSpend;
    }
  }
  return {
    otherGoal,
    waste,
    wasteSpendCents: wasteSpend,
    stoppedWaste,
    winners,
    costWithoutWasteCents,
    roasWithoutWaste,
    costWithShiftCents,
    roasWithShift,
    thinData: baseline.conversions < THIN_DATA_CONVERSIONS,
  };
}

// ---------------------------------------------------------------------------
// Targets

export type StatedTarget = {
  roas?: number;
  costPerCents?: number;
  /** A number of conversions over `windowDays` ("100 leads a month"). */
  volume?: number;
  windowDays?: number;
  /**
   * A scale target: `costPerCents` and `roas` are limits to stay within while volume grows (not a
   * cost to reach), and `dailyBudgetCents` is the budget the volume takes.
   */
  scale?: { dailyBudgetCents: number };
};

export type TargetOption = {
  key: "safe" | "recommended" | "bold";
  /**
   * "efficiency": a better cost per conversion at today's spend. "scale": more conversions on a
   * bigger budget while the cost stays under a ceiling (the account already makes money, so volume
   * is the limit).
   */
  mode: "efficiency" | "scale";
  /** Efficiency: the cost per conversion to reach. Scale: the most a conversion may cost while scaling. */
  costPerCents: number | null;
  /** Sales only. Efficiency: the ROAS to reach. Scale: the lowest ROAS to accept while scaling. */
  roas: number | null;
  /** Scale only: conversions a day to reach, and the daily budget that takes. */
  conversionsPerDay?: number;
  dailyBudgetCents?: number;
  windowDays: number;
  /** What the number rests on, in plain words. */
  basis: string;
};

/** What the client told us about profit, from their goals. */
export type ProfitContext = {
  /** 1 ÷ margin: the ROAS at which sales stop making money. */
  breakEvenRoas?: number | null;
  /** The most a result may cost before it loses money. */
  breakEvenCostCents?: number | null;
  targetRoas?: number | null;
  targetCostCents?: number | null;
};

/** The gross margin a sales account needs to break even at its ROAS (1 ÷ ROAS). */
export function marginNeeded(roas: number): number {
  return 1 / roas;
}

/**
 * Whether the account already makes money comfortably, so the limit is volume, not cost. Sales:
 * ROAS at least 1.5× break-even (or 1.3× the client's target); with no margin given, when it would
 * be profitable at any margin of 25% or more (ROAS 4× and up), worked out from its own ROAS. Leads:
 * cost per lead at most 80% of the client's target or break-even. Leads with neither can't tell.
 */
export function scaleRoom(kind: GoalKind, baseline: Baseline, profit: ProfitContext = {}): { scale: boolean; why: string | null } {
  if (kind === "sales" && baseline.roas != null && baseline.roas > 0) {
    if (profit.breakEvenRoas) {
      return baseline.roas >= profit.breakEvenRoas * 1.5
        ? { scale: true, why: `ROAS ${baseline.roas.toFixed(2)}× is ${(baseline.roas / profit.breakEvenRoas).toFixed(1)}× the client's break-even ${profit.breakEvenRoas.toFixed(2)}×` }
        : { scale: false, why: null };
    }
    if (profit.targetRoas) {
      return baseline.roas >= profit.targetRoas * 1.3
        ? { scale: true, why: `ROAS ${baseline.roas.toFixed(2)}× is well above the client's ${profit.targetRoas}× target` }
        : { scale: false, why: null };
    }
    const margin = marginNeeded(baseline.roas);
    return margin <= 0.25
      ? { scale: true, why: `at ${baseline.roas.toFixed(2)}× ROAS the ads make money at any gross margin above ${Math.ceil(margin * 100)}% (1 ÷ ROAS); no margin is set for this client, so confirm it` }
      : { scale: false, why: null };
  }
  const ceiling = profit.targetCostCents ?? profit.breakEvenCostCents ?? null;
  if (baseline.costPerCents != null && ceiling != null && baseline.costPerCents <= ceiling * 0.8) {
    return { scale: true, why: `cost per result is ${Math.round((1 - baseline.costPerCents / ceiling) * 100)}% under the client's ${profit.targetCostCents ? "target" : "break-even"}` };
  }
  return { scale: false, why: null };
}

/** Budget multiple, the cost rise allowed for it, and the days it takes, per scale option. */
const SCALE_STEPS: Record<TargetOption["key"], { budget: number; costRise: number; days: number }> = {
  safe: { budget: 1.5, costRise: 0.1, days: 30 },
  recommended: { budget: 2, costRise: 0.2, days: 45 },
  bold: { budget: 3, costRise: 0.35, days: 60 },
};

function scaleTargets(kind: GoalKind, baseline: Baseline, profit: ProfitContext, why: string): TargetOption[] {
  const cost = baseline.costPerCents!;
  return (Object.keys(SCALE_STEPS) as Array<TargetOption["key"]>).map((key) => {
    const step = SCALE_STEPS[key];
    let rise = step.costRise;
    // Never let the ceiling cross the client's own limit.
    const limit = profit.targetCostCents ?? profit.breakEvenCostCents ?? null;
    if (limit != null) rise = Math.min(rise, Math.max(0, limit / cost - 1));
    if (kind === "sales" && baseline.roas != null && profit.breakEvenRoas) rise = Math.min(rise, Math.max(0, baseline.roas / (profit.breakEvenRoas * 1.2) - 1));
    const budget = Math.round(baseline.spendPerDayCents * step.budget);
    const ceiling = Math.round(cost * (1 + rise));
    return {
      key,
      mode: "scale" as const,
      costPerCents: ceiling,
      roas: kind === "sales" && baseline.roas != null ? round2(baseline.roas / (1 + rise)) : null,
      conversionsPerDay: Math.round((budget / ceiling) * 10) / 10,
      dailyBudgetCents: budget,
      windowDays: step.days,
      basis: `budget ×${step.budget} in 20–30% steps, allowing cost per result to rise ${Math.round(rise * 100)}% as it grows; ${why}`,
    };
  });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Three targets the account's own figures support. When the account already makes money comfortably
 * (see scaleRoom), they are scale targets: more conversions on a bigger budget under a cost ceiling.
 * Otherwise efficiency targets, cost per conversion and (sales) ROAS:
 * safe = halfway to the waste-free figure in 30 days; recommended = the waste-free figure in
 * 30 days; bold = waste moved to the winners in 60 days. With no waste to cut, the targets are
 * small judgement calls on the current figure and say so. None with no conversions.
 */
export function proposeTargets(kind: GoalKind, baseline: Baseline, levers: Levers, profit: ProfitContext = {}): TargetOption[] {
  const cost = baseline.costPerCents;
  if (cost == null) return [];
  // An account that already makes money comfortably is limited by volume: target more results, not cheaper ones.
  // Waste still gets cut in the plan; it just isn't the headline.
  const room = scaleRoom(kind, baseline, profit);
  if (room.scale && room.why) return scaleTargets(kind, baseline, profit, room.why);
  const roas = baseline.roas;
  const hasWaste = levers.wasteSpendCents > 0 && levers.costWithoutWasteCents != null && levers.costWithoutWasteCents < cost * 0.97;
  if (!hasWaste) {
    const judgement = "no ad set is wasting money against the account's own average, so this is a judgement call: the gain has to come from new creative and the fixes in the plan, not from moving budget";
    return [
      { key: "safe", mode: "efficiency", costPerCents: cost, roas: roas != null ? round2(roas) : null, windowDays: 30, basis: "hold today's figure while volume grows" },
      { key: "recommended", mode: "efficiency", costPerCents: Math.round(cost * 0.9), roas: roas != null ? round2(roas / 0.9) : null, windowDays: 45, basis: `10% better than today; ${judgement}` },
      {
        key: "bold",
        mode: "efficiency",
        costPerCents: levers.winners.length ? Math.round(Math.max(levers.costWithShiftCents ?? cost * 0.8, cost * 0.75)) : Math.round(cost * 0.8),
        roas: roas != null ? round2(roas / 0.8) : null,
        windowDays: 60,
        basis: levers.winners.length ? "the best ad sets' cost, if new creative lets them take more budget" : `20% better than today; ${judgement}`,
      },
    ];
  }
  const free = levers.costWithoutWasteCents!;
  const shift = Math.min(levers.costWithShiftCents ?? free, free);
  const half = Math.round((cost + free) / 2);
  const roasFree = levers.roasWithoutWaste;
  const roasShift = levers.roasWithShift;
  return [
    {
      key: "safe",
      mode: "efficiency",
      costPerCents: half,
      roas: roas != null && roasFree != null ? round2((roas + roasFree) / 2) : null,
      windowDays: 30,
      basis: "half of the waste stopped",
    },
    {
      key: "recommended",
      mode: "efficiency",
      costPerCents: free,
      roas: roasFree != null ? round2(roasFree) : null,
      windowDays: 30,
      basis: "what the rest of the account already costs once the wasting ad sets stop",
    },
    {
      key: "bold",
      mode: "efficiency",
      costPerCents: shift < free ? shift : Math.round(free * 0.9),
      roas: roasShift != null && roasFree != null && roasShift > roasFree ? round2(roasShift) : roasFree != null ? round2(roasFree / 0.9) : null,
      windowDays: 60,
      basis:
        shift < free
          ? `the waste spend moved to the winning ad sets, allowing their cost to rise ${Math.round((SCALE_PENALTY - 1) * 100)}% as they scale`
          : "10% past the waste-free figure, from new creative",
    },
  ];
}

export type TargetVerdict = "already_met" | "reachable" | "stretch" | "beyond_the_data" | "unknown";

/**
 * How the operator's target compares with what the levers support. ROAS is compared when the
 * target is a ROAS; otherwise cost per conversion. "beyond_the_data" means even moving the waste to
 * the winners doesn't get there: it needs changes whose effect can't be projected (offer, page, creative).
 */
export function judgeTarget(target: StatedTarget, baseline: Baseline, levers: Levers): TargetVerdict {
  if (target.roas != null) {
    if (baseline.roas == null) return "unknown";
    if (baseline.roas >= target.roas) return "already_met";
    if ((levers.roasWithoutWaste ?? 0) >= target.roas) return "reachable";
    if ((levers.roasWithShift ?? 0) >= target.roas) return "stretch";
    return "beyond_the_data";
  }
  // A volume goal alone is a budget question (see budgetForVolume), not a cost one.
  const cost = target.costPerCents;
  if (cost == null || baseline.costPerCents == null) return "unknown";
  if (baseline.costPerCents <= cost) return "already_met";
  if ((levers.costWithoutWasteCents ?? Infinity) <= cost) return "reachable";
  if ((levers.costWithShiftCents ?? Infinity) <= cost) return "stretch";
  return "beyond_the_data";
}

/** The daily budget a volume goal needs at a cost per conversion. */
export function budgetForVolume(volume: number, windowDays: number, costPerCents: number): number {
  return Math.round((volume / windowDays) * costPerCents);
}
