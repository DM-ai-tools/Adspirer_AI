import type { CategoryAttribution, CategoryPerformance } from "./category-attribution";
import {
  ga4MatchedPct,
  ga4RevenueBasis,
  observedCategoryFigures,
  type CategoryChannels,
  type ChannelPerformance,
  type ObservedFigures,
} from "./channels";
import { detectGoogleCapabilities } from "./google-capabilities";
import type { AllocationTier, CategoryAllocation, PlanProjection, StrategyPlan } from "./plan";

type CategoryWord = "category" | "service";
type Money = (cents: number) => string;

/** Above this many categories the tables collapse to the biggest ones plus a count. */
const MAX_FULL_ROWS = 40;
const TRUNCATED_ROWS = 25;
/** Below this share of account spend in the loaded ads, per-category figures are partial. */
const MIN_AD_COVERAGE_PCT = 80;
/** Search demand lists only the categories with the most impressions. */
const MAX_SEARCH_ROWS = 10;

const GOOGLE_LABEL = "Google budget is a recommendation for the Google Ads account — this tool doesn't change Google.";
const GA4_METHOD: Record<ChannelPerformance["ga4Method"], string> = {
  item: "GA4 product categories",
  landing_page: "GA4 landing pages — an estimate, not exact product sales",
  none: "none — GA4 revenue isn't available, so revenue is what Meta and Google Ads report",
};
const GOOGLE_TYPE_LABEL = new Map(detectGoogleCapabilities(null).map((c) => [c.id, c.label]));

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

function moneyIn(currency: string): Money {
  return (cents: number) => {
    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: 2,
      }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
  };
}

function projectionLine(p: PlanProjection, money: Money): string {
  return p.blendedRoas === null
    ? `${money(p.dailySpendCents)}/day spend, no projected return`
    : `${money(p.dailySpendCents)}/day spend → ${money(p.dailyRevenueCents)}/day projected revenue, blended ROAS ${p.blendedRoas}×`;
}

/**
 * How much of the account's spend the loaded ads account for, the snapshot's
 * load warnings, and whether the per-category figures are therefore partial.
 */
function adCoverage(
  attribution: CategoryAttribution,
  accountSpendCents: number | null,
  warnings: string[],
  word: CategoryWord,
  money: Money,
): { lines: string[]; partial: boolean } {
  const adSpend =
    attribution.byCategory.reduce((sum, p) => sum + p.spendCents, 0) + attribution.unmatched.spendCents;
  const pct =
    accountSpendCents !== null && accountSpendCents > 0
      ? Math.round((adSpend / accountSpendCents) * 1000) / 10
      : null;
  const adsFailed = warnings.some((w) => /^Ads\b/.test(w));
  const partial = adsFailed || (pct !== null && pct < MIN_AD_COVERAGE_PCT);
  const lines = [
    pct === null
      ? `- Ad-level spend covered: ${money(adSpend)} of account spend (account spend not available)`
      : `- Ad-level spend covered: ${money(adSpend)} of account spend ${money(accountSpendCents ?? 0)} (${pct}%)`,
    ...warnings.map((w) => `- Snapshot warning: ${w}`),
  ];
  if (partial) {
    const reason = adsFailed ? "the ads did not load in full" : `the loaded ads cover only ${pct}% of account spend`;
    lines.push(
      `- Per-${word} figures are partial: ${reason}. A ${word} with no spend here was not seen in the loaded ads; that does not mean it had no spend.`,
    );
  }
  return { lines, partial };
}

/** The Level 1 table: spend, revenue, ROAS and match per category, plus the tier when there is a plan. */
function spendTable(
  rows: Array<{ categoryId: string; name: string; tier?: AllocationTier }>,
  perfById: Map<string, CategoryPerformance>,
  ctx: { word: CategoryWord; days: number; money: Money },
): string[] {
  const { word, days, money } = ctx;
  const withTier = rows.some((r) => r.tier !== undefined);
  const spendOf = (id: string) => perfById.get(id)?.spendCents ?? 0;
  const shown =
    rows.length > MAX_FULL_ROWS
      ? [...rows].sort((a, b) => spendOf(b.categoryId) - spendOf(a.categoryId)).slice(0, TRUNCATED_ROWS)
      : rows;
  const body = shown.map((r) => {
    const p = perfById.get(r.categoryId);
    const spend = p?.spendCents ?? 0;
    const revenue = spend > 0 && p?.roas === null ? "unknown" : money(p?.purchaseValueCents ?? 0);
    const match = p && p.adIds.length > 0 ? p.matchedBy : "none";
    return `| ${r.name} | ${money(spend)} | ${revenue} | ${roas(p?.roas ?? null)} |${withTier ? ` ${r.tier} |` : ""} ${match} |`;
  });
  const hidden = rows.length - shown.length;
  return [
    `| ${capitalize(word)} | Spend (${days}d) | Revenue | ROAS |${withTier ? " Tier |" : ""} Match |`,
    `| --- | --- | --- | --- |${withTier ? " --- |" : ""} --- |`,
    ...body,
    ...(hidden > 0 ? [`…and ${hidden} more ${plural(word)} (top ${TRUNCATED_ROWS} by spend shown).`] : []),
  ];
}

/** `meta` names the lines as Meta's, for evidence that has Google figures too. */
function unmatchedLines(attribution: CategoryAttribution, word: CategoryWord, money: Money, meta = false): string[] {
  return [
    `- ${meta ? "Meta unmatched" : "Unmatched"} spend: ${money(attribution.unmatched.spendCents)} across ${attribution.unmatched.adIds.length} ads (not attributed to any ${word})`,
    `- Coverage: ${attribution.coveragePct}% of ${meta ? "Meta " : ""}ad spend matched to a ${word}`,
  ];
}

/** Google Ads is mapped but its data didn't load, so the figures leave Google out. */
function googleMissing(channels: ChannelPerformance): boolean {
  return channels.googleAdsMapped && !channels.googleAdsLoaded;
}

/** Channel figures for a category the channel data left out: its Meta attribution, no Google. */
function metaOnlyRow(categoryId: string, perf: CategoryPerformance | undefined): CategoryChannels {
  const none = { spendCents: 0, platformRevenueCents: 0, ga4RevenueCents: null, roas: null, basis: "none" as const };
  return {
    categoryId,
    meta: { ...none, spendCents: perf?.spendCents ?? 0, platformRevenueCents: perf?.purchaseValueCents ?? 0 },
    google: none,
    ga4TotalRevenueCents: null,
    searchImpressions: 0,
    searchClicks: 0,
    topQueries: [],
  };
}

/**
 * The Level 1 table with channels: Meta and Google spend, GA4 and platform revenue, the ROAS
 * and its basis. A row's `roas` (the plan's observed ROAS) wins over the one derived here.
 * `ranked` puts the best revenue first (GA4's when there is GA4).
 */
function channelTable(
  rows: Array<{ categoryId: string; name: string; tier?: AllocationTier; roas?: number | null }>,
  perfById: Map<string, CategoryPerformance>,
  channels: ChannelPerformance,
  ctx: { word: CategoryWord; days: number; money: Money; ranked: boolean },
): string[] {
  const { word, days, money, ranked } = ctx;
  const missing = googleMissing(channels);
  const withTier = rows.some((r) => r.tier !== undefined);
  const chById = new Map(channels.byCategory.map((c) => [c.categoryId, c]));
  const all = rows.map((r) => {
    const perf = perfById.get(r.categoryId);
    const ch = chById.get(r.categoryId) ?? metaOnlyRow(r.categoryId, perf);
    const f = observedCategoryFigures(ch, perf?.roas ?? null, {
      ga4Available: ga4RevenueBasis(channels),
      googleLoaded: !missing,
    });
    // GA4's paid revenue is shown even when GA4 isn't the basis (it matched too little).
    const paid = observedCategoryFigures(ch, perf?.roas ?? null, {
      ga4Available: channels.ga4Available,
      googleLoaded: !missing,
    }).ga4RevenueCents;
    return { ...r, ch, f, paid };
  });
  const revenueOf = (f: ObservedFigures) => f.ga4RevenueCents ?? f.platformRevenueCents ?? -1;
  const ordered = ranked ? [...all].sort((a, b) => revenueOf(b.f) - revenueOf(a.f)) : all;
  const shown =
    ordered.length <= MAX_FULL_ROWS
      ? ordered
      : ranked
        ? ordered.slice(0, TRUNCATED_ROWS)
        : [...ordered].sort((a, b) => b.f.spendCents - a.f.spendCents).slice(0, TRUNCATED_ROWS);
  const basis = { ga4: "GA4", platform: "platform", none: "—" } as const;
  const body = shown.map((r) => {
    const p = perfById.get(r.categoryId);
    const match = p && p.adIds.length > 0 ? p.matchedBy : "none";
    const google = missing ? "not loaded" : money(r.ch.google.spendCents);
    const ga4 = r.paid === null ? "—" : money(r.paid);
    const ga4All = r.ch.ga4TotalRevenueCents === null ? "—" : money(r.ch.ga4TotalRevenueCents);
    const platform = r.f.platformRevenueCents === null ? "unknown" : money(r.f.platformRevenueCents);
    const value = r.roas !== undefined ? r.roas : r.f.roas;
    return `| ${r.name} | ${money(r.ch.meta.spendCents)} | ${google} | ${ga4} | ${ga4All} | ${platform} | ${roas(value)} | ${basis[r.f.basis]} |${withTier ? ` ${r.tier} |` : ""} ${match} |`;
  });
  const hidden = rows.length - shown.length;
  const headings = missing
    ? "GA4 paid-social revenue | GA4 revenue (all channels) | Meta-reported revenue | ROAS (Meta only)"
    : "GA4 paid revenue | GA4 revenue (all channels) | Platform revenue | Combined ROAS";
  return [
    `| ${capitalize(word)} | Meta spend (${days}d) | Google spend (${days}d) | ${headings} | Basis |${withTier ? " Tier |" : ""} Match |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |${withTier ? " --- |" : ""} --- |`,
    ...body,
    ...(hidden > 0
      ? [`…and ${hidden} more ${plural(word)} (top ${TRUNCATED_ROWS} by ${ranked ? "revenue" : "spend"} shown).`]
      : []),
  ];
}

/**
 * Under the channel table: how GA4 revenue was matched, GA4 revenue no category took (and
 * whether that left too little to use), and Google spend no category took.
 */
function channelLevel1Lines(channels: ChannelPerformance, word: CategoryWord, money: Money): string[] {
  const ga4: string[] = [];
  const matchedPct = ga4MatchedPct(channels);
  if (matchedPct !== null && channels.ga4UnmatchedRevenueCents > 0) {
    const total = channels.ga4UnmatchedRevenueCents + channels.byCategory.reduce((s, c) => s + (c.ga4TotalRevenueCents ?? 0), 0);
    const pct = Math.round((channels.ga4UnmatchedRevenueCents / total) * 1000) / 10;
    ga4.push(`- GA4 revenue not matched to any ${word}: ${money(channels.ga4UnmatchedRevenueCents)} (${pct}% of GA4 revenue)`);
  }
  if (matchedPct !== null && !ga4RevenueBasis(channels)) {
    ga4.push(`- GA4 matched only ${matchedPct}% of revenue to ${plural(word)}, so the figures use platform-reported revenue.`);
  }
  return [
    `- GA4 method: ${GA4_METHOD[channels.ga4Method]}`,
    ...ga4,
    channels.ads
      ? `- Google Ads unmatched spend: ${money(channels.googleUnmatchedSpendCents)} (not attributed to any ${word})`
      : channels.googleAdsMapped
        ? "- Google Ads spend didn't load (see Channel data), so it isn't included."
        : "- Google Ads: no account mapped, so Google spend isn't included.",
  ];
}

/** Channel notes, then every Google load warning. */
function channelDataLines(note: string | null, channels: ChannelPerformance | undefined, extra: string[]): string[] {
  const lines = [
    ...(note ? [`- Note: ${note}`] : []),
    ...[...(channels?.warnings ?? []), ...extra].map((w) => `- Warning: ${w}`),
  ];
  return lines.length ? lines : ["- Meta and Google figures loaded with no warnings."];
}

/**
 * Spend and return per category for a question about them, with no plan: the
 * Level 1 table, unmatched spend and how much of the account the ads cover.
 */
export function renderCategorySpendEvidence(
  attribution: CategoryAttribution,
  categories: Array<{ id: string; name: string }>,
  opts: {
    currency: string;
    categoryWord: CategoryWord;
    periodDays: number;
    accountSpendCents: number | null;
    warnings?: string[];
    /** Meta and Google figures per category; without them the evidence is Meta only. */
    channels?: ChannelPerformance;
    /** Google load warnings from outside the channel data, e.g. a load that failed outright. */
    channelWarnings?: string[];
  },
): string {
  const word = opts.categoryWord;
  const money = moneyIn(opts.currency);
  const perfById = new Map(attribution.byCategory.map((p) => [p.categoryId, p]));
  const coverage = adCoverage(attribution, opts.accountSpendCents, opts.warnings ?? [], word, money);
  const { channels } = opts;
  const extra = opts.channelWarnings ?? [];
  // Currencies that differ are never combined: the table stays Meta's own.
  const combined = channels && !channels.currencyMismatch ? channels : null;
  const rows = categories.map((c) => ({ categoryId: c.id, name: c.name }));
  const days = opts.periodDays;

  const top: string[] = [];
  if (channels) {
    top.push(
      `- Ranked by: ${
        !combined
          ? "Meta-reported revenue"
          : googleMissing(combined)
            ? ga4RevenueBasis(combined)
              ? "GA4 paid-social revenue"
              : "Meta-reported revenue"
            : ga4RevenueBasis(combined)
              ? "GA4 revenue"
              : "combined platform revenue"
      }`,
    );
  }
  if (channels || extra.length) {
    const note = !channels
      ? "Google data wasn't loaded: the figures are Meta only."
      : (channels.currencyMismatch ??
        (!channels.googleAdsMapped
          ? "No Google Ads account mapped: Google spend isn't included."
          : googleMissing(channels)
            ? "Google Ads is mapped but its data didn't load this time; Google spend isn't included."
            : null));
    top.push(...channelDataLines(note, channels, extra));
  }

  let table: string[];
  if (combined) table = channelTable(rows, perfById, combined, { word, days, money, ranked: true });
  else if (channels) {
    const revenue = (id: string) => {
      const p = perfById.get(id);
      return p && !(p.spendCents > 0 && p.roas === null) ? p.purchaseValueCents : -1;
    };
    const ranked = [...rows].sort((a, b) => revenue(b.categoryId) - revenue(a.categoryId));
    table = spendTable(ranked, perfById, { word, days, money });
  } else table = spendTable(rows, perfById, { word, days, money });

  return [
    `### Spend & return by ${word}`,
    `- Period: last ${days} days. Figures only: no plan, no budget allocation.`,
    ...top,
    ...table,
    "",
    ...(combined ? channelLevel1Lines(combined, word, money) : []),
    ...unmatchedLines(attribution, word, money, !!combined),
    ...coverage.lines,
  ].join("\n");
}

/**
 * The plan engine's output as writer evidence: every number the strategy
 * report may quote, under fixed headings, with the engine's assumptions.
 */
export function renderStrategyEvidence(
  plan: StrategyPlan,
  attribution: CategoryAttribution,
  opts: {
    currency: string;
    categoryWord: CategoryWord;
    defaultsUsed?: string[];
    /** The snapshot's load warnings; an "Ads" failure makes the per-category figures partial. */
    warnings?: string[];
    /** The channel data the plan was built with; without it the evidence is Meta only. */
    channels?: ChannelPerformance;
    /** Google load warnings from outside the channel data, e.g. a load that failed outright. */
    channelWarnings?: string[];
  },
): string {
  const word = opts.categoryWord;
  const words = plural(word);
  const Word = capitalize(word);
  const money = moneyIn(opts.currency);
  const perfById = new Map<string, CategoryPerformance>(attribution.byCategory.map((p) => [p.categoryId, p]));
  const { baseline, brief, allocations } = plan;
  const days = baseline.periodDays;
  const none = allocations.length === 0;
  const { channels } = opts;
  const channelWarnings = opts.channelWarnings ?? [];
  // Currencies that differ are never combined: Level 1 stays Meta's own.
  const combined = channels && !channels.currencyMismatch ? channels : null;
  const out: string[] = [];

  out.push(
    [
      "### Strategy inputs",
      `- Daily budget: ${money(brief.dailyBudgetCents)}/day`,
      `- Target ROAS: ${brief.targetRoas}×`,
      `- Stretch targets: ${brief.stretchTargets.length ? brief.stretchTargets.map((t) => `${t}×`).join(", ") : "none"}`,
      `- Period analysed: last ${days} days`,
      `- Account audit score: ${baseline.score}/100 (grade ${baseline.grade})`,
      `- ${channels ? "Meta spend" : "Spend"} in period: ${money(baseline.spendCents)} · ${channels ? "Meta " : ""}account ROAS ${roas(baseline.roas)}`,
      `- ${capitalize(words)} loaded: ${baseline.categoriesTotal} (${baseline.categoriesWithSpend} with spend)`,
      `- Word for offerings: ${word}`,
      `- Currency: ${opts.currency}`,
      ...(opts.defaultsUsed ?? []).map((d) => `- Default used: ${d}`),
    ].join("\n"),
  );

  if (plan.scope) {
    out.push(["### Scope", `- Planned only for: ${plan.scope.names.join(", ")}`].join("\n"));
  }
  if (channels || channelWarnings.length) {
    out.push(["### Channel data", ...channelDataLines(plan.channelNote, channels, channelWarnings)].join("\n"));
  }

  const coverage = adCoverage(
    attribution,
    baseline.spendCents > 0 ? baseline.spendCents : null,
    opts.warnings ?? [],
    word,
    money,
  );
  out.push(
    [
      `### Level 1: spend & return by ${word}`,
      ...(none
        ? [`- No ${words} loaded yet. Add them (name, landing page URL, keywords) to see spend and return by ${word}.`]
        : combined
          ? [
              ...channelTable(
                allocations.map((a) => ({ categoryId: a.categoryId, name: a.name, tier: a.tier, roas: a.observedRoas })),
                perfById,
                combined,
                { word, days, money, ranked: false },
              ),
              "",
            ]
          : [...spendTable(allocations, perfById, { word, days, money }), ""]),
      ...(combined ? channelLevel1Lines(combined, word, money) : []),
      ...unmatchedLines(attribution, word, money, !!combined),
      ...coverage.lines,
    ].join("\n"),
  );

  // With Google figures, a category Google spent on is not untouched.
  const googleSpend = new Map((combined?.byCategory ?? []).map((c) => [c.categoryId, c.google.spendCents]));
  const untouched = allocations.filter(
    (a) => plan.gaps.untouchedCategoryIds.includes(a.categoryId) && !((googleSpend.get(a.categoryId) ?? 0) > 0),
  );
  out.push(
    [
      `### Untouched ${words}`,
      none
        ? `- No ${words} loaded yet.`
        : untouched.length
          ? coverage.partial
            ? `- ${untouched.length} not seen in the loaded ads: ${untouched.map((a) => a.name).join(", ")}`
            : `- ${untouched.length} with no ad spend in the last ${days} days: ${untouched.map((a) => a.name).join(", ")}`
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

  if (plan.googleCapabilities) {
    const google = plan.googleCapabilities;
    const labels = (state: (typeof google)[number]["state"]) =>
      google.filter((c) => c.state === state).map((c) => c.label).join(", ") || "none";
    const gNotUsed = google.filter((c) => c.state === "not_used");
    const gUnknown = google.filter((c) => c.state === "unknown");
    out.push(
      [
        "### Google campaign types: in use / not used / needs a product feed",
        `- In use: ${labels("in_use")}`,
        `- Not used:${gNotUsed.length ? "" : " none"}`,
        ...gNotUsed.map((c) => `  - ${c.label}: ${c.why}`),
        `- Needs a product feed (link Merchant Center to run them): ${labels("needs_feed")}`,
        ...(gUnknown.length ? [`- Unknown (Google Ads data didn't load): ${labels("unknown")}`] : []),
      ].join("\n"),
    );
  }

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

  if (channels) {
    const gap = channels.metaVsGa4;
    const level2 = ["### Level 2: GA4 vs platform-reported"];
    if (channels.currencyMismatch) level2.push(`- Not compared: ${channels.currencyMismatch}`);
    else if (!gap) {
      level2.push(
        channels.ga4Available
          ? `- Not available: GA4 has no revenue from Facebook/Instagram paid sessions on these ${words}' landing pages.`
          : "- Not available: GA4 revenue isn't available for this client.",
      );
    } else {
      const { metaReportedCents: meta, ga4PaidSocialCents: ga4 } = gap;
      level2.push(
        `- Meta-reported revenue: ${money(meta)} · GA4 revenue from Facebook/Instagram paid sessions on the same ${words} (matched by landing page, an estimate): ${money(ga4)}`,
      );
      if (ga4 === 0) {
        level2.push(`- GA4 credits no revenue from Facebook/Instagram paid sessions to these ${words}, so the gap can't be given as a %.`);
      } else {
        const pct = Math.round(((meta - ga4) / ga4) * 1000) / 10;
        level2.push(pct === 0 ? "- Meta and GA4 agree." : `- Meta reports ${Math.abs(pct)}% ${pct > 0 ? "more" : "less"} than GA4.`);
      }
    }
    out.push(level2.join("\n"));

    const nameById = new Map(allocations.map((a) => [a.categoryId, a.name]));
    const demand = channels.byCategory
      .filter((c) => c.searchImpressions > 0 && nameById.has(c.categoryId))
      .sort((a, b) => b.searchImpressions - a.searchImpressions);
    const shown = demand.slice(0, MAX_SEARCH_ROWS);
    const count = (n: number) => n.toLocaleString("en");
    out.push(
      [
        "### Search demand",
        ...(shown.length
          ? [
              `| ${Word} | Search impressions | Search clicks | Top queries |`,
              "| --- | --- | --- | --- |",
              ...shown.map(
                (c) =>
                  `| ${nameById.get(c.categoryId)} | ${count(c.searchImpressions)} | ${count(c.searchClicks)} | ${c.topQueries.join(", ") || "—"} |`,
              ),
              ...(demand.length > shown.length
                ? [`…and ${demand.length - shown.length} more ${words} with search demand (top ${MAX_SEARCH_ROWS} by impressions shown).`]
                : []),
            ]
          : [`- No Search Console demand matched to any ${word}.`]),
      ].join("\n"),
    );
  }

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
    const list = (members: CategoryAllocation[]) => {
      const names = members.map((a) => a.name);
      return names.length > 10 ? `${names.slice(0, 10).join(", ")} and ${names.length - 10} more` : names.join(", ");
    };
    const setupOf = (a: CategoryAllocation) => a.structure.map((id) => label.get(id) ?? id).join(", ") || "no specific Meta setup";
    for (const tier of TIER_ORDER) {
      const members = allocations.filter((a) => a.tier === tier);
      if (!members.length) continue;
      if (tier !== "hold") {
        level3.push(`- ${capitalize(tier)} (${list(members)}): ${setupOf(members[0])}`);
        continue;
      }
      // Only a scoped plan funds a held category: it was asked for, though below break-even.
      const unfunded = members.filter((a) => a.dailyBudgetCents === 0);
      const funded = members.filter((a) => a.dailyBudgetCents > 0);
      if (unfunded.length) level3.push(`- Hold (${list(unfunded)}): no budget until it returns at least break-even`);
      if (funded.length) {
        level3.push(
          `- Hold, funded on request (${list(funded)}): below break-even, funded because the plan was asked for it; set up like a test: ${setupOf(funded[0])}`,
        );
      }
    }
  }
  out.push(level3.join("\n"));

  if (channels) {
    const split = ["### Level 3: channel split"];
    const funded = allocations.filter((a) => a.channelSplit);
    if (!plan.channelTotals) split.push(`- ${plan.channelNote ?? "No Meta and Google split."}`);
    else if (!funded.length) split.push(`- No ${word} is funded, so there is no Meta and Google split.`);
    else {
      const totals = plan.channelTotals;
      const projected = (side: "metaProjectedCents" | "googleProjectedCents") =>
        funded.reduce((s, a) => s + a.channelSplit![side], 0);
      split.push(
        `| ${Word} | Daily budget | Meta budget | Google budget | Meta projected | Google projected | Basis | Google campaign types |`,
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
        ...funded.map((a) => {
          const s = a.channelSplit!;
          const types = a.googleCampaignTypes.map((id) => GOOGLE_TYPE_LABEL.get(id) ?? id).join(", ") || "—";
          return `| ${a.name} | ${money(a.dailyBudgetCents)} | ${money(s.metaCents)} | ${money(s.googleCents)} | ${money(s.metaProjectedCents)} | ${money(s.googleProjectedCents)} | ${s.basis === "ga4" ? "GA4" : "platform"} | ${types} |`;
        }),
        "",
        `- Totals: Meta ${money(totals.metaCents)}/day, Google ${money(totals.googleCents)}/day; projected revenue Meta ${money(projected("metaProjectedCents"))}/day, Google ${money(projected("googleProjectedCents"))}/day.`,
        `- ${GOOGLE_LABEL}`,
      );
    }
    out.push(split.join("\n"));
  }

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

  const next = plan.nextTest;
  out.push(
    [
      "### Next test",
      next
        ? `- ${next.name}: ${money(next.dailyBudgetCents)}/day for ${next.durationDays} days (from the Level 3 allocation).`
        : `- No ${word} is funded in this plan, so there is no test to run yet.`,
    ].join("\n"),
  );

  out.push(["### Assumptions", ...plan.assumptions.map((a) => `- ${a}`)].join("\n"));

  return out.join("\n\n");
}
