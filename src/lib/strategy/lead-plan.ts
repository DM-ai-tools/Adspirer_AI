import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { ResolvedGoals } from "@/lib/clients/goals";
import { detectCapabilityGaps, type CapabilityStatus } from "./meta-capabilities";
import { PLAN_CONSTANTS, splitCents, type AllocationTier } from "./plan";

/**
 * The strategy plan for lead-generation clients. The goal is leads at a cost
 * per lead, not revenue at a ROAS: the plan works out the budget a lead goal
 * needs (or the leads a budget should bring) from the account's own cost per
 * lead, allowing for it rising as spend scales.
 */

export type LeadBrief = {
  /** Leads wanted over `periodDays`; null when only a budget was given. */
  targetLeads: number | null;
  periodDays: number;
  dailyBudgetCents: number | null;
  /** The cost per lead the operator wants to stay under. */
  targetCplCents: number | null;
};

export const LEAD_PLAN_CONSTANTS = {
  /** Share of the current cost-per-lead efficiency kept on each extra dollar: best case, expected, cautious. */
  efficiency: { best: 1, expected: PLAN_CONSTANTS.scaleDecay, conservative: 0.7 },
  /** Fewer results than this make the account cost per lead a weak guide. */
  minLeadsForCpl: 10,
  /** A campaign up to this × the reference cost per lead is "promising"; above it, "hold". */
  promisingCplMultiple: 1.5,
} as const;

export type LeadScenarioId = "best" | "expected" | "conservative";
export type LeadScenario = {
  id: LeadScenarioId;
  efficiency: number;
  /** What the lead goal costs per lead at this budget. */
  cplCents: number;
  dailyBudgetCents: number;
  periodBudgetCents: number;
};
export type LeadProjection = { id: LeadScenarioId; dailyLeads: number; periodLeads: number };

export type LeadCampaignRow = {
  id: string;
  name: string;
  status: string;
  spendCents: number;
  leads: number | null;
  cplCents: number | null;
  dailySpendCents: number;
  tier: AllocationTier;
  dailyBudgetCents: number;
};

export type LeadPlan = {
  brief: LeadBrief;
  currency: string;
  baseline: {
    periodDays: number;
    spendCents: number;
    leads: number | null;
    resultLabel: string;
    cplCents: number | null;
    dailySpendCents: number;
    dailyLeads: number | null;
    previous: { spendCents: number; leads: number | null; cplCents: number | null } | null;
    enoughLeads: boolean;
  };
  reference: { cplCents: number | null; source: "observed" | "client_target" | "stated" | null };
  /** "size": a lead goal, so the budget is worked out; "project": only a budget, so the leads are. */
  mode: "size" | "project";
  /** Budget a lead goal needs; empty when there is no cost per lead to size from. */
  scenarios: LeadScenario[];
  /** The budget at the operator's own target cost per lead, when they gave one. */
  atTargetCpl: { cplCents: number; dailyBudgetCents: number; periodBudgetCents: number } | null;
  /** Leads the stated budget should bring; empty without a budget or a reference. */
  projections: LeadProjection[];
  /** For a goal and a budget together: does the budget reach the goal. */
  budgetVerdict: "meets" | "stretch" | "short" | null;
  /** The daily budget the plan allocates: the expected budget for a goal, else the stated one. */
  plannedDailyCents: number | null;
  campaigns: LeadCampaignRow[];
  capabilities: CapabilityStatus[];
  checks: string[];
  assumptions: string[];
  /** Daily steps from the current spend to the planned budget at the client's scale step. */
  ramp: { fromCents: number; toCents: number; steps: number; stepPct: number; minDaysPerStep: number } | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function leadMoney(currency: string): (cents: number) => string {
  return (cents) => {
    try {
      return new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 2 }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
  };
}
const FUNDED = ["proven", "promising", "test"] as const;

type Base = { spendCents: number; leads: number };

/** Daily budget that brings `dailyLeads`: current cost per lead up to today's volume, then dearer by `efficiency`. */
function budgetFor(dailyLeads: number, refCpl: number, base: Base | null, efficiency: number): number {
  if (base && base.leads > 0 && base.spendCents > 0) {
    const cpl = base.spendCents / base.leads;
    return dailyLeads <= base.leads ? dailyLeads * cpl : base.spendCents + ((dailyLeads - base.leads) * cpl) / efficiency;
  }
  return (dailyLeads * refCpl) / efficiency;
}

/** Leads per day a daily budget brings; the inverse of `budgetFor`. */
function leadsFor(dailyBudgetCents: number, refCpl: number, base: Base | null, efficiency: number): number {
  if (base && base.leads > 0 && base.spendCents > 0) {
    const cpl = base.spendCents / base.leads;
    return dailyBudgetCents <= base.spendCents
      ? dailyBudgetCents / cpl
      : base.leads + ((dailyBudgetCents - base.spendCents) * efficiency) / cpl;
  }
  return (dailyBudgetCents * efficiency) / refCpl;
}

export function buildLeadPlan(input: {
  snapshot: MetaAuditSnapshot;
  goals: ResolvedGoals;
  brief: LeadBrief;
}): LeadPlan {
  const { snapshot, goals, brief } = input;
  const C = LEAD_PLAN_CONSTANTS;
  const days = snapshot.period.days;
  const totals = snapshot.totals;
  const spend = totals?.spendCents ?? 0;
  const leads = totals?.results ?? null;
  const observedCpl = leads && leads > 0 && spend > 0 ? Math.round(spend / leads) : null;
  const dailySpend = spend / days;
  const dailyLeads = leads != null ? leads / days : null;
  const base: Base | null = observedCpl !== null && dailyLeads !== null ? { spendCents: dailySpend, leads: dailyLeads } : null;

  const prev = snapshot.previousTotals ?? null;
  const previous = prev
    ? {
        spendCents: prev.spendCents,
        leads: prev.results,
        cplCents: prev.results && prev.results > 0 && prev.spendCents > 0 ? Math.round(prev.spendCents / prev.results) : null,
      }
    : null;

  const reference: LeadPlan["reference"] =
    observedCpl !== null
      ? { cplCents: observedCpl, source: "observed" }
      : goals.target_cpa_cents != null
        ? { cplCents: goals.target_cpa_cents, source: "client_target" }
        : brief.targetCplCents != null
          ? { cplCents: brief.targetCplCents, source: "stated" }
          : { cplCents: null, source: null };
  const refCpl = reference.cplCents;
  const mode: LeadPlan["mode"] = brief.targetLeads != null ? "size" : "project";

  const scenarioIds: LeadScenarioId[] = ["best", "expected", "conservative"];
  const needDaily = brief.targetLeads != null ? brief.targetLeads / brief.periodDays : null;
  const scenarios: LeadScenario[] =
    needDaily !== null && refCpl !== null
      ? scenarioIds.map((id) => {
          const efficiency = C.efficiency[id];
          const daily = Math.round(budgetFor(needDaily, refCpl, base, efficiency));
          return {
            id,
            efficiency,
            cplCents: Math.round(daily / needDaily),
            dailyBudgetCents: daily,
            periodBudgetCents: daily * brief.periodDays,
          };
        })
      : [];
  const atTargetCpl =
    brief.targetLeads != null && brief.targetCplCents != null
      ? {
          cplCents: brief.targetCplCents,
          dailyBudgetCents: Math.round(needDaily! * brief.targetCplCents),
          periodBudgetCents: Math.round(brief.targetLeads * brief.targetCplCents),
        }
      : null;

  const projections: LeadProjection[] =
    brief.dailyBudgetCents != null && refCpl !== null
      ? scenarioIds.map((id) => {
          const perDay = leadsFor(brief.dailyBudgetCents!, refCpl, base, C.efficiency[id]);
          return { id, dailyLeads: round2(perDay), periodLeads: Math.round(perDay * brief.periodDays) };
        })
      : [];
  let budgetVerdict: LeadPlan["budgetVerdict"] = null;
  if (brief.targetLeads != null && projections.length) {
    const at = (id: LeadScenarioId) => projections.find((p) => p.id === id)!.periodLeads;
    budgetVerdict = at("expected") >= brief.targetLeads ? "meets" : at("best") >= brief.targetLeads ? "stretch" : "short";
  }

  const expected = scenarios.find((s) => s.id === "expected");
  const plannedDailyCents = expected?.dailyBudgetCents ?? brief.dailyBudgetCents ?? null;

  // Campaign tiers against the reference cost per lead.
  const rows = snapshot.campaigns
    .filter((c) => (c.performance?.spendCents ?? 0) > 0 || c.status === "ACTIVE")
    .map((c): LeadCampaignRow => {
      const p = c.performance;
      const spendC = p?.spendCents ?? 0;
      const res = p?.results ?? null;
      const cpl = res && res > 0 && spendC > 0 ? Math.round(spendC / res) : null;
      let tier: AllocationTier;
      if (refCpl === null || spendC < PLAN_CONSTANTS.minSpendForVerdictCents || (cpl === null && spendC < refCpl * goals.policy.kill_multiple)) {
        tier = "test";
      } else if (cpl === null) tier = "hold";
      else if (cpl <= refCpl) tier = "proven";
      else if (cpl <= refCpl * C.promisingCplMultiple) tier = "promising";
      else tier = "hold";
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        spendCents: spendC,
        leads: res,
        cplCents: cpl,
        dailySpendCents: Math.round(spendC / days),
        tier,
        dailyBudgetCents: 0,
      };
    })
    .sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));

  if (plannedDailyCents !== null && rows.length) {
    const members = (t: AllocationTier) => rows.filter((r) => r.tier === t);
    const filled = FUNDED.filter((t) => members(t).length > 0);
    const shares: Record<(typeof FUNDED)[number], number> = { proven: 0, promising: 0, test: 0 };
    FUNDED.forEach((tier, i) => {
      if (filled.length === 0) return;
      const to = filled.includes(tier) ? tier : (FUNDED.slice(i + 1).find((t) => filled.includes(t)) ?? filled[0]);
      shares[to] += PLAN_CONSTANTS.split[tier];
    });
    const bucket = splitCents(filled.length ? plannedDailyCents : 0, FUNDED.map((t) => shares[t]));
    FUNDED.forEach((tier, i) => {
      const group = members(tier);
      if (!group.length) return;
      if (tier !== "test") {
        splitCents(bucket[i], group.map((r) => r.leads ?? 0)).forEach((cents, j) => (group[j].dailyBudgetCents = cents));
        return;
      }
      const funded = Math.min(group.length, Math.max(1, Math.floor(bucket[i] / PLAN_CONSTANTS.minTestDailyCents)));
      splitCents(bucket[i], Array<number>(funded).fill(1)).forEach((cents, j) => (group[j].dailyBudgetCents = cents));
    });
  }

  const capabilities = detectCapabilityGaps(
    snapshot,
    goals.business_model && goals.business_model !== "ecommerce" && goals.business_model !== "other" ? goals.business_model : "lead_gen",
  );

  const money = leadMoney(snapshot.account.currency);
  const checks: string[] = [];
  if (plannedDailyCents !== null && goals.daily_account_cap_cents != null && plannedDailyCents > goals.daily_account_cap_cents) {
    checks.push(`Planned daily budget exceeds the client's daily account cap of ${money(goals.daily_account_cap_cents)}: raise the cap in client settings or lower the goal.`);
  }
  if (plannedDailyCents !== null && goals.monthly_cap_cents != null && plannedDailyCents * 30.4 > goals.monthly_cap_cents) {
    checks.push(`Planned budget over a month (${money(Math.round(plannedDailyCents * 30.4))}) exceeds the client's monthly cap of ${money(goals.monthly_cap_cents)}.`);
  }
  const effectiveCpl = expected?.cplCents ?? refCpl;
  if (effectiveCpl != null && goals.break_even_cpa_cents != null && effectiveCpl > goals.break_even_cpa_cents) {
    checks.push(`Expected cost per lead (${money(effectiveCpl)}) is above the client's break-even CPA (${money(goals.break_even_cpa_cents)}): each lead would cost more than it earns.`);
  }

  const step = goals.policy.scale_step_pct;
  const ramp =
    plannedDailyCents !== null && dailySpend > 0 && plannedDailyCents > dailySpend
      ? {
          fromCents: Math.round(dailySpend),
          toCents: plannedDailyCents,
          steps: Math.ceil(Math.log(plannedDailyCents / dailySpend) / Math.log(1 + step / 100)),
          stepPct: step,
          minDaysPerStep: goals.policy.min_days_of_data,
        }
      : null;

  const assumptions: string[] = [
    `Cost per lead is the account's own over the last ${days} days${observedCpl === null ? "; the account has no leads in that window" : ""}.`,
    `Volume up to today's daily leads costs today's cost per lead; every extra lead is assumed to cost more, keeping ${Math.round(C.efficiency.expected * 100)}% of today's efficiency (${Math.round(C.efficiency.conservative * 100)}% cautious, ${Math.round(C.efficiency.best * 100)}% best case).`,
    `Budget split ${Math.round(PLAN_CONSTANTS.split.proven * 100)}% proven, ${Math.round(PLAN_CONSTANTS.split.promising * 100)}% promising, ${Math.round(PLAN_CONSTANTS.split.test * 100)}% test campaigns; an empty tier's share moves to the next; holds get no budget.`,
    `A campaign needs ${money(PLAN_CONSTANTS.minSpendForVerdictCents)} of spend in the window before it is judged; proven is at or below the reference cost per lead, promising up to ${C.promisingCplMultiple}× it, hold above that.`,
    "Leads are Meta's reported results for each campaign's optimisation goal; lead quality and what the leads become are not measured here.",
  ];
  if (!(leads !== null && leads >= C.minLeadsForCpl) && observedCpl !== null) {
    assumptions.push(`Only ${leads} results in the window: the cost per lead is a weak guide until there are ${C.minLeadsForCpl} or more.`);
  }
  if (reference.source === "client_target") assumptions.push("The account has no leads in the window, so the client's target CPA from settings is the reference cost per lead.");
  if (reference.source === "stated") assumptions.push("The account has no leads in the window, so the cost per lead you stated is the reference.");

  return {
    brief,
    currency: snapshot.account.currency,
    baseline: {
      periodDays: days,
      spendCents: spend,
      leads,
      resultLabel: totals?.resultLabel ?? "Results",
      cplCents: observedCpl,
      dailySpendCents: Math.round(dailySpend),
      dailyLeads: dailyLeads === null ? null : round2(dailyLeads),
      previous,
      enoughLeads: leads !== null && leads >= C.minLeadsForCpl,
    },
    reference,
    mode,
    scenarios,
    atTargetCpl,
    projections,
    budgetVerdict,
    plannedDailyCents,
    campaigns: rows,
    capabilities,
    checks,
    assumptions,
    ramp,
  };
}
