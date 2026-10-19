import type { AdsPerformance, ChannelSnapshot } from "@/lib/google/types";
import type { StrategyCategory } from "./categories";
import type { CategoryAttribution } from "./category-attribution";
import { matchCategoryByLabel, matchCategoryByName, matchCategoryByUrl } from "./category-match";

export type ChannelFigures = {
  spendCents: number;
  platformRevenueCents: number;
  ga4RevenueCents: number | null;
  roas: number | null;
  basis: "ga4" | "platform" | "none";
};
export type CategoryChannels = {
  categoryId: string;
  meta: ChannelFigures;
  google: ChannelFigures;
  /** GA4 revenue for the category across all channels (item or landing-page method), null when GA4 is unavailable. */
  ga4TotalRevenueCents: number | null;
  searchImpressions: number;
  searchClicks: number;
  topQueries: string[];
};
export type ChannelPerformance = {
  byCategory: CategoryChannels[];
  ga4Method: "item" | "landing_page" | "none";
  ga4Available: boolean;
  googleAdsMapped: boolean;
  /** The Google Ads data loaded this time; false when it is unmapped or its load failed. */
  googleAdsLoaded: boolean;
  /** Set when currencies differ: no combined figures may be used. */
  currencyMismatch: string | null;
  googleUnmatchedSpendCents: number;
  /**
   * Paid-social check: what Meta reports vs what GA4 credits to paid social, over the categories
   * GA4 has a paid-social estimate for. ga4PaidSocialCents is the sum of those per-category
   * estimates on matched pages, not GA4's raw paid-social total.
   */
  metaVsGa4: { metaReportedCents: number; ga4PaidSocialCents: number } | null;
  /** The snapshot's Google Ads data, passed through for campaign-type detection (Task 11). */
  ads: AdsPerformance | null;
  warnings: string[];
};

const OVERLAP_WARNING =
  "Google figures from different sources overlap; the category split of Google spend is approximate.";
const MAX_TOP_QUERIES = 5;
/** Host for GA4 paths when no category landing page or Search Console site gives one. */
const FALLBACK_HOST = "site.invalid";

/** Campaign types whose spend shows up in shopping_performance_view. */
function isShoppingType(type: string): boolean {
  return type === "SHOPPING" || type === "PERFORMANCE_MAX";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** What a category is judged on: Meta + Google spend and revenue, on one basis. */
export type ObservedFigures = {
  spendCents: number;
  /** The GA4 revenue used; null when GA4 isn't used or has no figure for the category. */
  ga4RevenueCents: number | null;
  /** What Meta and Google Ads report; null when Meta spend has no Meta ROAS. */
  platformRevenueCents: number | null;
  /** The revenue the ROAS is on: GA4's when there is a figure, else Meta + Google Ads reported. */
  revenueCents: number;
  roas: number | null;
  basis: "ga4" | "platform" | "none";
  /** Google Ads is left out (its data didn't load), so these are Meta's figures alone. */
  metaOnly: boolean;
};

/**
 * One category's observed figures, shared by the plan and the evidence. With GA4, revenue is
 * the category's GA4 total; when Google Ads is left out it is Meta's GA4 paid-social share, so
 * Meta spend is never set against revenue Google also earned.
 */
export function observedCategoryFigures(
  ch: CategoryChannels,
  metaRoas: number | null,
  opts: { ga4Available: boolean; googleLoaded: boolean },
): ObservedFigures {
  const metaOnly = !opts.googleLoaded;
  const google = metaOnly ? null : ch.google;
  const spendCents = ch.meta.spendCents + (google?.spendCents ?? 0);
  const ga4 = !opts.ga4Available ? null : metaOnly ? ch.meta.ga4RevenueCents : ch.ga4TotalRevenueCents;
  // Meta spend without a Meta ROAS leaves platform revenue unknown, whatever Google reports.
  const platformKnown = !(ch.meta.spendCents > 0 && metaRoas === null);
  const platformSum = ch.meta.platformRevenueCents + (google?.platformRevenueCents ?? 0);
  const known = ga4 !== null || (spendCents > 0 && platformKnown);
  const revenueCents = ga4 ?? platformSum;
  return {
    spendCents,
    ga4RevenueCents: ga4,
    platformRevenueCents: platformKnown ? platformSum : null,
    revenueCents,
    roas: spendCents > 0 && known ? round2(revenueCents / spendCents) : null,
    basis: ga4 !== null ? "ga4" : spendCents > 0 && platformKnown ? "platform" : "none",
    metaOnly,
  };
}

/**
 * Splits an integer total by weight; largest remainders take the leftover units, so parts
 * sum exactly. BigInt keeps w × total exact however large the amounts are.
 */
function apportion(weights: number[], total: number): number[] {
  const ws = weights.map((w) => BigInt(Math.max(0, Math.round(w))));
  const whole = ws.reduce((a, b) => a + b, BigInt(0));
  const t = BigInt(Math.max(0, Math.round(total)));
  if (whole === BigInt(0) || t === BigInt(0)) return weights.map(() => 0);
  const shares = ws.map((w, i) => ({ i, part: (w * t) / whole, rem: (w * t) % whole }));
  let left = t - shares.reduce((a, s) => a + s.part, BigInt(0));
  const order = [...shares].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; left > BigInt(0) && k < order.length; k++, left--) order[k].part++;
  return shares.map((s) => Number(s.part));
}

/** round(a × b ÷ c) for non-negative integers, exact. */
function mulDivRound(a: number, b: number, c: number): number {
  const [x, y, z] = [a, b, c].map((n) => BigInt(Math.max(0, Math.round(n))));
  return z === BigInt(0) ? 0 : Number((BigInt(2) * x * y + z) / (BigInt(2) * z));
}

function hostOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim().replace(/^sc-domain:/i, "");
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname || null;
  } catch {
    return null;
  }
}

type Row = { category: StrategyCategory | null; costCents: number; valueCents: number };
type Slot = { cost: number; value: number };

export function buildChannelPerformance(input: {
  categories: StrategyCategory[];
  metaAttribution: CategoryAttribution;
  metaCurrency: string;
  snapshot: ChannelSnapshot;
}): ChannelPerformance {
  const { categories, metaAttribution, metaCurrency, snapshot } = input;
  const warnings = [...snapshot.warnings];
  const ads = snapshot.ads;
  const ga4 = snapshot.ga4;
  const ga4Available = ga4 != null && ga4.method !== "none";

  // Currencies: compare only the ones we know; no conversion is ever done.
  const currencies = (
    [
      ["Meta", metaCurrency],
      ["GA4", ga4?.currency],
      ["Google Ads", ads?.currency],
    ] as const
  )
    .map(([label, code]) => ({ label, code: (code ?? "").trim().toUpperCase() }))
    .filter((c) => c.code !== "");
  const currencyMismatch =
    new Set(currencies.map((c) => c.code)).size > 1
      ? `${currencies.map((c, i) => `${c.label}${i === 0 ? " reports" : ""} in ${c.code}`).join(", ")}: figures are shown per channel and not combined.`
      : null;

  // --- Google spend ---------------------------------------------------------
  // Each layer's matched rows are capped at the spend still unassigned in its pool, so a
  // campaign's cost can't land in two categories and the total never exceeds campaign cost.
  // Landing-page and product-type rows carry no campaign id, so a pool's remainder is mostly
  // other spend: a name tier never credits a category an earlier tier of the same pool did.
  const google = new Map<string, Slot>(categories.map((c) => [c.id, { cost: 0, value: 0 }]));
  let scaled = false;
  const take = (rows: Row[], cap: number, credited: Set<string>, byName: boolean): number => {
    const matched = rows.filter(
      (r) => r.category && r.costCents > 0 && !(byName && credited.has(r.category.id)),
    );
    const cost = sum(matched.map((r) => r.costCents));
    let costs = matched.map((r) => r.costCents);
    let values = matched.map((r) => Math.max(0, r.valueCents));
    if (cost > cap) {
      scaled = true;
      values = apportion(values, mulDivRound(sum(values), cap, cost));
      costs = apportion(costs, cap);
    }
    matched.forEach((r, i) => {
      const slot = google.get(r.category!.id)!;
      slot.cost += costs[i];
      slot.value += values[i];
      if (costs[i] > 0) credited.add(r.category!.id);
    });
    return sum(costs);
  };

  let googleLeft = 0;
  if (ads) {
    const campaignById = new Map(ads.campaigns.map((c) => [c.id, c]));
    const shoppingCampaigns = ads.campaigns.filter((c) => isShoppingType(c.type));
    const otherCampaigns = ads.campaigns.filter((c) => !isShoppingType(c.type));
    const shoppingTotal = sum(shoppingCampaigns.map((c) => Math.max(0, c.costCents)));
    const otherTotal = sum(otherCampaigns.map((c) => Math.max(0, c.costCents)));

    // 1. Shopping and Performance Max: product types, then asset groups, then campaign names.
    let shoppingLeft = shoppingTotal;
    const shoppingCredited = new Set<string>();
    shoppingLeft -= take(
      ads.shoppingCategories.map((r) => ({
        category: matchCategoryByLabel(r.productType, categories),
        costCents: r.costCents,
        valueCents: r.conversionValueCents,
      })),
      shoppingLeft,
      shoppingCredited,
      false,
    );
    shoppingLeft -= take(
      ads.assetGroups.map((g) => ({
        category: matchCategoryByName([g.name, campaignById.get(g.campaignId)?.name], categories),
        costCents: g.costCents,
        valueCents: g.conversionValueCents,
      })),
      shoppingLeft,
      shoppingCredited,
      true,
    );
    // A Performance Max campaign's asset groups stand in for it; only cost they don't cover is left.
    const groupCost = new Map<string, Slot>();
    for (const g of ads.assetGroups) {
      const slot = groupCost.get(g.campaignId) ?? { cost: 0, value: 0 };
      slot.cost += g.costCents;
      slot.value += g.conversionValueCents;
      groupCost.set(g.campaignId, slot);
    }
    shoppingLeft -= take(
      shoppingCampaigns.map((c) => ({
        category: matchCategoryByName([c.name], categories),
        costCents: Math.max(0, c.costCents - (groupCost.get(c.id)?.cost ?? 0)),
        valueCents: Math.max(0, c.conversionValueCents - (groupCost.get(c.id)?.value ?? 0)),
      })),
      shoppingLeft,
      shoppingCredited,
      true,
    );

    // 2. Every other campaign type: landing pages, then campaign names.
    let otherLeft = otherTotal;
    const otherCredited = new Set<string>();
    otherLeft -= take(
      ads.landingPages.map((p) => ({
        category: matchCategoryByUrl(p.url, categories),
        costCents: p.costCents,
        valueCents: p.conversionValueCents,
      })),
      otherLeft,
      otherCredited,
      false,
    );
    otherLeft -= take(
      otherCampaigns.map((c) => ({
        category: matchCategoryByName([c.name], categories),
        costCents: c.costCents,
        valueCents: c.conversionValueCents,
      })),
      otherLeft,
      otherCredited,
      true,
    );
    googleLeft = shoppingLeft + otherLeft;
  }
  if (scaled) warnings.push(OVERLAP_WARNING);

  // --- GA4 -------------------------------------------------------------------
  // GA4 landing pages are paths. Resolve them against the categories' own landing-page
  // hosts (then the Search Console site) so matchCategoryByUrl compares like with like.
  const hosts = [
    ...new Set(
      [...categories.map((c) => hostOf(c.landingPageUrl)), hostOf(snapshot.gsc?.siteUrl)].filter(
        (h): h is string => !!h,
      ),
    ),
  ];
  const matchPath = (page: string): StrategyCategory | null => {
    if (/^https?:\/\//i.test(page.trim())) return matchCategoryByUrl(page, categories);
    const path = page.trim().startsWith("/") ? page.trim() : `/${page.trim()}`;
    for (const host of hosts.length > 0 ? hosts : [FALLBACK_HOST]) {
      const hit = matchCategoryByUrl(`https://${host}${path}`, categories);
      if (hit) return hit;
    }
    return null;
  };

  const ga4Totals = new Map<string, number>(categories.map((c) => [c.id, 0]));
  const channels = new Map(categories.map((c) => [c.id, { social: 0, search: 0, all: 0 }]));
  if (ga4 && ga4Available) {
    for (const row of ga4.rows) {
      const hit = ga4.method === "item" ? matchCategoryByLabel(row.key, categories) : matchPath(row.key);
      if (hit) ga4Totals.set(hit.id, ga4Totals.get(hit.id)! + row.revenueCents);
    }
    for (const row of ga4.byChannel) {
      const hit = matchPath(row.landingPage);
      if (!hit) continue;
      const c = channels.get(hit.id)!;
      c.all += row.revenueCents;
      if (row.channel === "paid_social") c.social += row.revenueCents;
      if (row.channel === "paid_search") c.search += row.revenueCents;
    }
  }
  // Splitting GA4 revenue across channels mixes its currency with the platforms', so not when they differ.
  const splitGa4 = ga4Available && !currencyMismatch;

  // --- Search Console --------------------------------------------------------
  const search = new Map(categories.map((c) => [c.id, { clicks: 0, impressions: 0, queries: [] as string[] }]));
  const gscRows = [...(snapshot.gsc?.rows ?? [])].sort((a, b) => b.clicks - a.clicks);
  for (const row of gscRows) {
    const hit = matchCategoryByUrl(row.page, categories);
    if (!hit) continue;
    const s = search.get(hit.id)!;
    s.clicks += row.clicks;
    s.impressions += row.impressions;
    for (const q of row.topQueries) {
      if (s.queries.length < MAX_TOP_QUERIES && !s.queries.includes(q)) s.queries.push(q);
    }
  }

  // --- Per category ----------------------------------------------------------
  const figures = (
    spendCents: number,
    platformRevenueCents: number,
    platformKnown: boolean,
    ga4RevenueCents: number | null,
  ): ChannelFigures => {
    const basis = ga4RevenueCents != null ? "ga4" : platformKnown ? "platform" : "none";
    const revenue = basis === "ga4" ? ga4RevenueCents! : platformRevenueCents;
    return {
      spendCents,
      platformRevenueCents,
      ga4RevenueCents,
      roas: spendCents > 0 && basis !== "none" ? round2(revenue / spendCents) : null,
      basis,
    };
  };
  const metaById = new Map(metaAttribution.byCategory.map((p) => [p.categoryId, p]));

  const byCategory = categories.map((category): CategoryChannels => {
    const total = ga4Available ? ga4Totals.get(category.id)! : null;
    const ch = channels.get(category.id)!;
    const share = (part: number) =>
      splitGa4 && total != null && ch.all > 0 ? Math.round((total * part) / ch.all) : null;
    const m = metaById.get(category.id);
    const g = google.get(category.id)!;
    const s = search.get(category.id)!;
    return {
      categoryId: category.id,
      meta: figures(m?.spendCents ?? 0, m?.purchaseValueCents ?? 0, m?.roas != null, share(ch.social)),
      google: figures(g.cost, g.value, ads != null && g.cost > 0, share(ch.search)),
      ga4TotalRevenueCents: total,
      searchImpressions: s.impressions,
      searchClicks: s.clicks,
      topQueries: s.queries,
    };
  });

  // Only the categories GA4 has a paid-social estimate for, on both sides.
  const compared = byCategory.filter((c) => c.meta.ga4RevenueCents !== null);
  const metaVsGa4 =
    splitGa4 && compared.length > 0
      ? {
          metaReportedCents: sum(compared.map((c) => c.meta.platformRevenueCents)),
          ga4PaidSocialCents: sum(compared.map((c) => c.meta.ga4RevenueCents!)),
        }
      : null;

  return {
    byCategory,
    ga4Method: ga4?.method ?? "none",
    ga4Available,
    googleAdsMapped: snapshot.mapped.ads,
    googleAdsLoaded: ads != null,
    currencyMismatch,
    googleUnmatchedSpendCents: googleLeft,
    metaVsGa4,
    ads,
    warnings,
  };
}
