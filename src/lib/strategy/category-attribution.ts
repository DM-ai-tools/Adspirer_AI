import type { AuditAd, MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { StrategyCategory } from "./categories";
import { matchCategoryByLabel, matchCategoryByName, matchCategoryByUrl } from "./category-match";

export type CategoryPerformance = {
  categoryId: string;
  spendCents: number;
  purchaseValueCents: number;
  /** null when nothing spent, or no matched ad with spend reported ROAS. */
  roas: number | null;
  results: number;
  adIds: string[];
  /** "catalog": from a product ad's spend per product, via the product's GA4 item category. */
  matchedBy: "url" | "name" | "catalog" | "mixed";
};

export type CategoryAttribution = {
  /** Every category, zero-spend ones included. */
  byCategory: CategoryPerformance[];
  unmatched: { spendCents: number; adIds: string[] };
  /** Matched spend / total ad spend x 100, 0 when no spend. */
  coveragePct: number;
};

type Via = "url" | "name" | "catalog";
type Match = { category: StrategyCategory; via: Exclude<Via, "catalog"> };

function matchAd(
  ad: AuditAd,
  categories: StrategyCategory[],
  adSetName: string,
  campaignName: string,
): Match | null {
  if (ad.linkUrl) {
    const byUrl = matchCategoryByUrl(ad.linkUrl, categories);
    if (byUrl) return { category: byUrl, via: "url" };
  }
  // Ad name first, then ad set, then campaign: the first level with a hit decides.
  const byName = matchCategoryByName([ad.name, adSetName, campaignName], categories);
  return byName ? { category: byName, via: "name" } : null;
}

/**
 * Spend and return per category. An ad is matched by its link, then its name. A catalog
 * ad (one with spend per product) is split by product instead: each product goes to the
 * category of its GA4 item category, and only the spend the products don't cover (if any)
 * goes through the link / name match, so no spend is counted twice.
 */
export function attributeSpendToCategories(
  snapshot: MetaAuditSnapshot,
  categories: StrategyCategory[],
): CategoryAttribution {
  const adSetNames = new Map(snapshot.adSets.map((s) => [s.id, s.name]));
  const campaignNames = new Map(snapshot.campaigns.map((c) => [c.id, c.name]));
  const productsByAd = new Map<string, NonNullable<MetaAuditSnapshot["catalogProducts"]>>();
  for (const product of snapshot.catalogProducts ?? []) {
    const list = productsByAd.get(product.adId) ?? [];
    list.push(product);
    productsByAd.set(product.adId, list);
  }
  // Products of one item category resolve to one category; look each label up once.
  const labelCategory = new Map<string, StrategyCategory | null>();
  const categoryOfLabel = (label: string) => {
    if (!labelCategory.has(label)) labelCategory.set(label, matchCategoryByLabel(label, categories));
    return labelCategory.get(label) ?? null;
  };

  const acc = new Map(
    categories.map((c) => [
      c.id,
      { spend: 0, value: 0, results: 0, adIds: [] as string[], url: false, name: false, catalog: false, roasReported: false },
    ]),
  );
  const unmatched = { spendCents: 0, adIds: [] as string[] };
  let totalSpend = 0;
  let matchedSpend = 0;

  const credit = (
    category: StrategyCategory,
    adId: string,
    via: Via,
    spend: number,
    value: number,
    results: number,
    roasReported: boolean,
  ) => {
    const slot = acc.get(category.id)!;
    slot.spend += spend;
    slot.value += value;
    slot.results += results;
    if (roasReported) slot.roasReported = true;
    if (!slot.adIds.includes(adId)) slot.adIds.push(adId);
    slot[via] = true;
    matchedSpend += spend;
  };

  for (const ad of snapshot.ads) {
    let spend = ad.performance?.spendCents ?? 0;
    let results = ad.performance?.results ?? 0;
    const products = productsByAd.get(ad.id);
    if (products) {
      let covered = 0;
      let coveredResults = 0;
      let adUnmatched = 0;
      for (const p of products) {
        covered += p.spendCents;
        coveredResults += p.results;
        const category = p.itemCategory ? categoryOfLabel(p.itemCategory) : null;
        if (category) credit(category, ad.id, "catalog", p.spendCents, p.purchaseValueCents, p.results, true);
        else adUnmatched += p.spendCents;
      }
      totalSpend += covered;
      if (adUnmatched > 0) {
        unmatched.spendCents += adUnmatched;
        if (!unmatched.adIds.includes(ad.id)) unmatched.adIds.push(ad.id);
      }
      // Spend the product rows don't account for still belongs to the ad's own match.
      spend = Math.max(0, spend - covered);
      results = Math.max(0, results - coveredResults);
      if (spend === 0) continue;
    }
    totalSpend += spend;
    const match = matchAd(
      ad,
      categories,
      adSetNames.get(ad.adSetId) ?? "",
      campaignNames.get(ad.campaignId) ?? "",
    );
    if (!match) {
      unmatched.spendCents += spend;
      if (!unmatched.adIds.includes(ad.id)) unmatched.adIds.push(ad.id);
      continue;
    }
    credit(
      match.category,
      ad.id,
      match.via,
      spend,
      Math.round((ad.performance?.roas ?? 0) * spend),
      results,
      spend > 0 && ad.performance?.roas != null,
    );
  }

  return {
    byCategory: categories.map((c) => {
      const s = acc.get(c.id)!;
      const kinds = [s.url, s.name, s.catalog].filter(Boolean).length;
      return {
        categoryId: c.id,
        spendCents: s.spend,
        purchaseValueCents: s.value,
        // Unknown, not 0, when no spending ad reported ROAS (e.g. lead-gen accounts).
        roas: s.spend > 0 && s.roasReported ? Math.round((s.value / s.spend) * 100) / 100 : null,
        results: s.results,
        adIds: s.adIds,
        matchedBy: kinds > 1 ? "mixed" : s.catalog ? "catalog" : s.name ? "name" : "url",
      };
    }),
    unmatched,
    coveragePct: totalSpend > 0 ? Math.round((matchedSpend / totalSpend) * 1000) / 10 : 0,
  };
}
