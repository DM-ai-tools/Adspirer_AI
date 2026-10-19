import type { AuditAd, MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { StrategyCategory } from "./categories";
import { matchCategoryByName, matchCategoryByUrl } from "./category-match";

export type CategoryPerformance = {
  categoryId: string;
  spendCents: number;
  purchaseValueCents: number;
  /** null when nothing spent, or no matched ad with spend reported ROAS. */
  roas: number | null;
  results: number;
  adIds: string[];
  matchedBy: "url" | "name" | "mixed";
};

export type CategoryAttribution = {
  /** Every category, zero-spend ones included. */
  byCategory: CategoryPerformance[];
  unmatched: { spendCents: number; adIds: string[] };
  /** Matched spend / total ad spend x 100, 0 when no spend. */
  coveragePct: number;
};

type Match = { category: StrategyCategory; via: "url" | "name" };

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

export function attributeSpendToCategories(
  snapshot: MetaAuditSnapshot,
  categories: StrategyCategory[],
): CategoryAttribution {
  const adSetNames = new Map(snapshot.adSets.map((s) => [s.id, s.name]));
  const campaignNames = new Map(snapshot.campaigns.map((c) => [c.id, c.name]));

  const acc = new Map(
    categories.map((c) => [
      c.id,
      { spend: 0, value: 0, results: 0, adIds: [] as string[], url: false, name: false, roasReported: false },
    ]),
  );
  const unmatched = { spendCents: 0, adIds: [] as string[] };
  let totalSpend = 0;
  let matchedSpend = 0;

  for (const ad of snapshot.ads) {
    const spend = ad.performance?.spendCents ?? 0;
    totalSpend += spend;
    const match = matchAd(
      ad,
      categories,
      adSetNames.get(ad.adSetId) ?? "",
      campaignNames.get(ad.campaignId) ?? "",
    );
    if (!match) {
      unmatched.spendCents += spend;
      unmatched.adIds.push(ad.id);
      continue;
    }
    const slot = acc.get(match.category.id)!;
    slot.spend += spend;
    slot.value += Math.round((ad.performance?.roas ?? 0) * spend);
    if (spend > 0 && ad.performance?.roas != null) slot.roasReported = true;
    slot.results += ad.performance?.results ?? 0;
    slot.adIds.push(ad.id);
    slot[match.via] = true;
    matchedSpend += spend;
  }

  return {
    byCategory: categories.map((c) => {
      const s = acc.get(c.id)!;
      return {
        categoryId: c.id,
        spendCents: s.spend,
        purchaseValueCents: s.value,
        // Unknown, not 0, when no spending ad reported ROAS (e.g. lead-gen accounts).
        roas: s.spend > 0 && s.roasReported ? Math.round((s.value / s.spend) * 100) / 100 : null,
        results: s.results,
        adIds: s.adIds,
        matchedBy: s.url && s.name ? "mixed" : s.name ? "name" : "url",
      };
    }),
    unmatched,
    coveragePct: totalSpend > 0 ? Math.round((matchedSpend / totalSpend) * 1000) / 10 : 0,
  };
}
