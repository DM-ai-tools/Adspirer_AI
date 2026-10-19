import type { CategoryAttribution, CategoryPerformance } from "./category-attribution";
import type { AllocationTier, CategoryAllocation, PlanProjection, StrategyPlan } from "./plan";

type CategoryWord = "category" | "service";

/** Above this many categories the tables collapse to the biggest ones plus a count. */
const MAX_FULL_ROWS = 40;
const TRUNCATED_ROWS = 25;

const TIER_ORDER: AllocationTier[] = ["proven", "promising", "test", "hold"];

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function plural(word: CategoryWord): string {
  return word === "category" ? "categories" : "services";
}

function roas(value: number | null): string {
  return value === null ? "unknown" : `${value}×`;
}

function projectionLine(p: PlanProjection, money: (cents: number) => string): string {
  return p.blendedRoas === null
    ? `${money(p.dailySpendCents)}/day spend, no projected return`
    : `${money(p.dailySpendCents)}/day spend → ${money(p.dailyRevenueCents)}/day projected revenue, blended ROAS ${p.blendedRoas}×`;
}

/**
 * The plan engine's output as writer evidence: every number the strategy
 * report may quote, under fixed headings, with the engine's assumptions.
 */
export function renderStrategyEvidence(
  plan: StrategyPlan,
  attribution: CategoryAttribution,
  opts: { currency: string; categoryWord: CategoryWord; defaultsUsed?: string[] },
): string {
  const word = opts.categoryWord;
  const words = plural(word);
  const Word = capitalize(word);
  const money = (cents: number) => {
    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency: opts.currency,
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: 2,
      }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${opts.currency}`;
    }
  };
  const perfById = new Map<string, CategoryPerformance>(attribution.byCategory.map((p) => [p.categoryId, p]));
  const { baseline, brief, allocations } = plan;
  const days = baseline.periodDays;
  const none = allocations.length === 0;
  const out: string[] = [];

  out.push(
    [
      "### Strategy inputs",
      `- Daily budget: ${money(brief.dailyBudgetCents)}/day`,
      `- Target ROAS: ${brief.targetRoas}×`,
      `- Stretch targets: ${brief.stretchTargets.length ? brief.stretchTargets.map((t) => `${t}×`).join(", ") : "none"}`,
      `- Period analysed: last ${days} days`,
      `- Account audit score: ${baseline.score}/100 (grade ${baseline.grade})`,
      `- Spend in period: ${money(baseline.spendCents)} · account ROAS ${roas(baseline.roas)}`,
      `- ${capitalize(words)} loaded: ${baseline.categoriesTotal} (${baseline.categoriesWithSpend} with spend)`,
      `- Word for offerings: ${word}`,
      `- Currency: ${opts.currency}`,
      ...(opts.defaultsUsed ?? []).map((d) => `- Default used: ${d}`),
    ].join("\n"),
  );

  const unmatchedLines = [
    `- Unmatched spend: ${money(attribution.unmatched.spendCents)} across ${attribution.unmatched.adIds.length} ads (not attributed to any ${word})`,
    `- Coverage: ${attribution.coveragePct}% of ad spend matched to a ${word}`,
  ];
  if (none) {
    out.push(
      [
        `### Level 1: spend & return by ${word}`,
        `- No ${words} loaded yet. Add them (name, landing page URL, keywords) to see spend and return by ${word}.`,
        ...unmatchedLines,
      ].join("\n"),
    );
  } else {
    const bySpend = [...allocations].sort((a, b) => b.observedSpendCents - a.observedSpendCents);
    const shown = allocations.length > MAX_FULL_ROWS ? bySpend.slice(0, TRUNCATED_ROWS) : allocations;
    const rows = shown.map((a) => {
      const p = perfById.get(a.categoryId);
      const spend = p?.spendCents ?? 0;
      const revenue = spend > 0 && p?.roas === null ? "unknown" : money(p?.purchaseValueCents ?? 0);
      const match = p && p.adIds.length > 0 ? p.matchedBy : "none";
      return `| ${a.name} | ${money(spend)} | ${revenue} | ${roas(p?.roas ?? null)} | ${a.tier} | ${match} |`;
    });
    const hidden = allocations.length - shown.length;
    out.push(
      [
        `### Level 1: spend & return by ${word}`,
        `| ${Word} | Spend (${days}d) | Revenue | ROAS | Tier | Match |`,
        "| --- | --- | --- | --- | --- | --- |",
        ...rows,
        ...(hidden > 0 ? [`…and ${hidden} more ${words} (top ${TRUNCATED_ROWS} by spend shown).`] : []),
        "",
        ...unmatchedLines,
      ].join("\n"),
    );
  }

  const untouched = allocations.filter((a) => plan.gaps.untouchedCategoryIds.includes(a.categoryId));
  out.push(
    [
      `### Untouched ${words}`,
      none
        ? `- No ${words} loaded yet.`
        : untouched.length
          ? `- ${untouched.length} with no ad spend in the last ${days} days: ${untouched.map((a) => a.name).join(", ")}`
          : `- None: every ${word} had spend in the last ${days} days.`,
    ].join("\n"),
  );

  const caps = plan.gaps.capabilities;
  const inUse = caps.filter((c) => c.state === "in_use");
  const notUsed = caps.filter((c) => c.state === "not_used");
  const unknown = caps.filter((c) => c.state === "unknown");
  out.push(
    [
      "### Meta capabilities: in use / not used / unknown",
      `- In use: ${inUse.length ? inUse.map((c) => c.label).join(", ") : "none"}`,
      `- Not used:${notUsed.length ? "" : " none"}`,
      ...notUsed.map((c) => `  - ${c.label}: ${c.why}`),
      `- Unknown (not enough data to tell): ${unknown.length ? unknown.map((c) => c.label).join(", ") : "none"}`,
    ].join("\n"),
  );

  const reality = plan.benchmark.realityCheck;
  out.push(
    [
      "### Level 2: reality check",
      `- Target ${reality.targetRoas}× vs reference ${reality.referenceRoas}× (the higher of the retargeting benchmark and the account ROAS): ${reality.multiple}× the reference, verdict **${reality.verdict}**.`,
      "",
      "| Metric | Value | Source |",
      "| --- | --- | --- |",
      ...plan.benchmark.references.map((r) => `| ${r.metric} | ${r.value} | ${r.source} |`),
    ].join("\n"),
  );

  const level3 = ["### Level 3: allocation"];
  const allocated = plan.projection.dailySpendCents;
  if (allocated === 0) {
    const reason = none
      ? `no ${words} are loaded yet, so there is nothing to fund. Add ${words} first.`
      : allocations.every((a) => a.tier === "hold")
        ? `every ${word} returned below break-even ROAS (or below half its target when the margin is unknown), so all are held at no budget.`
        : `no ${word} qualified for budget.`;
    level3.push(`- No budget allocated: ${reason}`);
  }
  if (!none) {
    const big = allocations.length > MAX_FULL_ROWS;
    const shown = big ? allocations.filter((a) => a.dailyBudgetCents > 0) : allocations;
    const row = (a: CategoryAllocation) =>
      `| ${a.name} | ${a.tier} | ${a.targetRoas}×${a.targetBasis === "margin_adjusted" ? " (margin-adjusted)" : ""} | ${roas(a.observedRoas)} | ${money(a.dailyBudgetCents)} | ${money(a.projectedDailyRevenueCents)} |`;
    level3.push(
      `| ${Word} | Tier | Target ROAS | Observed ROAS | Daily budget | Projected daily revenue |`,
      "| --- | --- | --- | --- | --- | --- |",
      ...shown.map(row),
      ...(big && shown.length < allocations.length
        ? [`…and ${allocations.length - shown.length} more ${words} with no budget.`]
        : []),
      "",
      `- Plan total: ${projectionLine(plan.projection, money)} (${plan.projection.meetsTarget ? "meets" : "misses"} the ${brief.targetRoas}× target).`,
      "",
      "Structure per tier:",
    );
    const label = new Map(plan.gaps.capabilities.map((c) => [c.id, c.label]));
    for (const tier of TIER_ORDER) {
      const members = allocations.filter((a) => a.tier === tier);
      if (!members.length) continue;
      const names = members.map((a) => a.name);
      const listed = names.length > 10 ? `${names.slice(0, 10).join(", ")} and ${names.length - 10} more` : names.join(", ");
      const setup =
        tier === "hold"
          ? "no budget until it returns at least break-even"
          : members[0].structure.map((id) => label.get(id) ?? id).join(", ") || "no specific Meta setup";
      level3.push(`- ${capitalize(tier)} (${listed}): ${setup}`);
    }
  }
  out.push(level3.join("\n"));

  out.push(
    [
      "### Stretch scenarios",
      ...(plan.scenarios.length
        ? plan.scenarios.map((s) => {
            const side = s.targetRoas < brief.targetRoas ? "below" : "above";
            const t = s.tierCounts;
            return `- ${s.targetRoas}× target (${side} the main ${brief.targetRoas}× target): ${projectionLine(s.projection, money)}, ${s.projection.meetsTarget ? "meets" : "misses"} this target; tiers: ${t.proven} proven, ${t.promising} promising, ${t.test} test, ${t.hold} held.`;
          })
        : ["- None requested (e.g. \"stretch 12x and 15x\" adds them)."]),
    ].join("\n"),
  );

  out.push(["### Assumptions", ...plan.assumptions.map((a) => `- ${a}`)].join("\n"));

  return out.join("\n\n");
}
