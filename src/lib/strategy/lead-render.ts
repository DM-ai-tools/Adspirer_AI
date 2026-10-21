import { leadMoney, type LeadPlan, type LeadScenarioId } from "./lead-plan";
import type { AllocationTier } from "./plan";

const SCENARIO_LABEL: Record<LeadScenarioId, string> = {
  best: "Best case",
  expected: "Expected",
  conservative: "Cautious",
};
const TIER_LABEL: Record<AllocationTier, string> = { proven: "Proven", promising: "Promising", test: "Test", hold: "Hold" };
const TIER_ORDER: AllocationTier[] = ["proven", "promising", "test", "hold"];
const REFERENCE_SOURCE = {
  observed: "this account's cost per lead",
  client_target: "the client's target CPA from settings",
  stated: "the cost per lead you stated",
} as const;

const num = (n: number) => new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(n);

/**
 * The lead-gen plan as the evidence the strategy writer works from. It keeps
 * the "### Strategy inputs" heading so the rest of the pipeline treats it like
 * any built strategy.
 */
export function renderLeadStrategyEvidence(
  plan: LeadPlan,
  opts: {
    score: { score: number; grade: string };
    defaultsUsed?: string[];
    periodAssumed?: boolean;
    warnings?: string[];
  },
): string {
  const money = leadMoney(plan.currency);
  const { brief, baseline, reference } = plan;
  const cpl = (c: number | null) => (c === null ? "not available" : money(c));
  const out: string[] = [];

  out.push(
    [
      "### Strategy inputs",
      "- Goal type: lead generation — plan on leads and cost per lead, never ROAS or revenue",
      brief.targetLeads != null
        ? `- Lead goal: ${num(brief.targetLeads)} leads over ${brief.periodDays} days (${num(brief.targetLeads / brief.periodDays)}/day)${opts.periodAssumed ? ` (period not stated: ${brief.periodDays} days assumed)` : ""}`
        : "- Lead goal: none stated — the plan projects the leads the budget should bring",
      brief.dailyBudgetCents != null
        ? `- Daily budget stated: ${money(brief.dailyBudgetCents)}/day`
        : "- Daily budget stated: none — the plan works it out from the lead goal",
      brief.targetCplCents != null ? `- Target cost per lead: ${money(brief.targetCplCents)}` : "- Target cost per lead: not stated",
      `- Period analysed: last ${baseline.periodDays} days`,
      `- Account audit score: ${opts.score.score}/100 (grade ${opts.score.grade})`,
      `- Spend in period: ${money(baseline.spendCents)} · ${baseline.resultLabel}: ${baseline.leads ?? "not available"} · cost per lead ${cpl(baseline.cplCents)}`,
      "- Word for offerings: service",
      `- Currency: ${plan.currency}`,
      ...(opts.defaultsUsed ?? []).map((d) => `- Default used: ${d}`),
    ].join("\n"),
  );

  const campaignRows = plan.campaigns.filter((c) => c.spendCents > 0 || c.status === "ACTIVE");
  const partial = (opts.warnings ?? []).length > 0;
  out.push(
    [
      "### Level 1: where you are",
      `- Last ${baseline.periodDays} days: ${money(baseline.spendCents)} spent, ${baseline.leads ?? "no"} ${baseline.resultLabel.toLowerCase()}, cost per lead ${cpl(baseline.cplCents)}; ${money(baseline.dailySpendCents)}/day and ${baseline.dailyLeads ?? "no"} leads/day on average.`,
      ...(baseline.previous
        ? [
            `- Previous ${baseline.periodDays} days: ${money(baseline.previous.spendCents)} spent, ${baseline.previous.leads ?? "no"} ${baseline.resultLabel.toLowerCase()}, cost per lead ${cpl(baseline.previous.cplCents)}.`,
          ]
        : []),
      ...(baseline.leads !== null && !baseline.enoughLeads ? [`- Only ${baseline.leads} results in the window: the cost per lead is a weak guide.`] : []),
      ...(partial ? [`- Some data did not load (${opts.warnings!.join("; ")}): say the figures may be partial.`] : []),
      "",
      ...(campaignRows.length
        ? [
            "| Campaign | Status | Spend | Leads | Cost per lead | Tier |",
            "| --- | --- | --- | --- | --- | --- |",
            ...campaignRows.map(
              (c) =>
                `| ${c.name} | ${c.status} | ${money(c.spendCents)} | ${c.leads ?? "n/a"} | ${cpl(c.cplCents)} | ${TIER_LABEL[c.tier]} |`,
            ),
          ]
        : ["- No campaigns with spend or an active status were loaded."]),
    ].join("\n"),
  );

  const caps = plan.capabilities;
  const notUsed = caps.filter((c) => c.state === "not_used");
  const inUse = caps.filter((c) => c.state === "in_use");
  const unknown = caps.filter((c) => c.state === "unknown");
  const verdictLine =
    reference.cplCents === null
      ? "- Reference cost per lead: not available (no leads in the window and no target CPA set). Say the budget cannot be sized and ask for a target cost per lead; give no estimate."
      : `- Reference cost per lead: ${money(reference.cplCents)} (${REFERENCE_SOURCE[reference.source!]})`;
  out.push(
    [
      "### Level 2: how it compares",
      verdictLine,
      ...(brief.targetCplCents != null && baseline.cplCents !== null
        ? [
            baseline.cplCents <= brief.targetCplCents
              ? `- The account's ${money(baseline.cplCents)} cost per lead is already within the ${money(brief.targetCplCents)} target.`
              : `- The account's ${money(baseline.cplCents)} cost per lead is ${num(baseline.cplCents / brief.targetCplCents)}× the ${money(brief.targetCplCents)} target.`,
          ]
        : []),
      ...plan.checks.map((c) => `- Check: ${c}`),
      "- Competitor routes: take what competitors run from the competitor brief highlights in the client context; if there are none, say so.",
      `- Meta capabilities in use: ${inUse.length ? inUse.map((c) => c.label).join(", ") : "none detected"}`,
      ...(notUsed.length ? ["- Not used:", ...notUsed.map((c) => `  - ${c.label}: ${c.why}`)] : ["- Not used: none"]),
      ...(unknown.length ? [`- Not enough data to tell: ${unknown.map((c) => c.label).join(", ")}`] : []),
    ].join("\n"),
  );

  const level3: string[] = ["### Level 3: budget & plan"];
  if (plan.scenarios.length && brief.targetLeads != null) {
    level3.push(
      `- Budget for ${num(brief.targetLeads)} leads over ${brief.periodDays} days:`,
      "",
      "| Case | Cost per lead at this budget | Daily budget | Budget over the period |",
      "| --- | --- | --- | --- |",
      ...plan.scenarios.map(
        (s) =>
          `| ${SCENARIO_LABEL[s.id]} (${Math.round(s.efficiency * 100)}% efficiency on extra spend) | ${money(s.cplCents)} | ${money(s.dailyBudgetCents)} | ${money(s.periodBudgetCents)} |`,
      ),
      "",
    );
    const expected = plan.scenarios.find((s) => s.id === "expected")!;
    level3.push(
      `- Recommended budget: ${money(expected.dailyBudgetCents)}/day (${money(expected.periodBudgetCents)} over ${brief.periodDays} days), the Expected case.`,
    );
    if (plan.atTargetCpl) {
      level3.push(
        `- At your ${money(plan.atTargetCpl.cplCents)} target cost per lead it would be ${money(plan.atTargetCpl.dailyBudgetCents)}/day (${money(plan.atTargetCpl.periodBudgetCents)} over ${brief.periodDays} days) — only if the cost per lead falls to that.`,
      );
    }
  } else if (brief.targetLeads != null) {
    level3.push("- No budget could be sized: there is no cost per lead to size from. Say so and ask for a target cost per lead; do not invent one.");
  }
  if (plan.projections.length && brief.dailyBudgetCents != null) {
    level3.push(
      `- What ${money(brief.dailyBudgetCents)}/day should bring over ${brief.periodDays} days:`,
      "",
      "| Case | Leads per day | Leads over the period |",
      "| --- | --- | --- |",
      ...plan.projections.map((p) => `| ${SCENARIO_LABEL[p.id]} | ${num(p.dailyLeads)} | ${num(p.periodLeads)} |`),
      "",
    );
    if (plan.budgetVerdict && brief.targetLeads != null) {
      level3.push(
        `- Verdict on the stated budget: ${
          plan.budgetVerdict === "meets"
            ? "meets the lead goal in the Expected case"
            : plan.budgetVerdict === "stretch"
              ? "reaches the goal only in the Best case"
              : "falls short of the goal even in the Best case"
        }.`,
      );
    }
  }
  if (plan.plannedDailyCents !== null) {
    const funded = TIER_ORDER.flatMap((t) => plan.campaigns.filter((c) => c.tier === t));
    level3.push(
      `- Allocation of ${money(plan.plannedDailyCents)}/day by campaign:`,
      "",
      ...(funded.length
        ? [
            "| Campaign | Tier | Cost per lead | Now per day | Planned per day |",
            "| --- | --- | --- | --- | --- |",
            ...funded.map(
              (c) => `| ${c.name} | ${TIER_LABEL[c.tier]} | ${cpl(c.cplCents)} | ${money(c.dailySpendCents)} | ${money(c.dailyBudgetCents)} |`,
            ),
          ]
        : ["- No allocation: no campaigns with spend or an active status were loaded. Say so; do not invent campaigns."]),
      "",
    );
  }
  if (plan.ramp) {
    level3.push(
      `- Ramp: go from ${money(plan.ramp.fromCents)} to ${money(plan.ramp.toCents)}/day in about ${plan.ramp.steps} steps of ${plan.ramp.stepPct}%, holding each step at least ${plan.ramp.minDaysPerStep} days so cost per lead can settle.`,
    );
  }
  out.push(level3.join("\n"));

  out.push(["### Assumptions", ...plan.assumptions.map((a) => `- ${a}`)].join("\n"));

  const top = plan.campaigns.find((c) => c.tier === "proven" && c.dailyBudgetCents > 0) ?? plan.campaigns.find((c) => c.dailyBudgetCents > 0);
  out.push(
    [
      "### Next step",
      top
        ? `- Start with ${top.name}: planned ${money(top.dailyBudgetCents)}/day (now ${money(top.dailySpendCents)}/day), reviewed after ${plan.ramp?.minDaysPerStep ?? 7} days against the reference cost per lead.`
        : "- There is no campaign to start from: say what has to change first (a live lead campaign, or a target cost per lead).",
    ].join("\n"),
  );

  return out.join("\n\n");
}
