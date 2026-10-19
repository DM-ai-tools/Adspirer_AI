import type { AuditAd, MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { StrategyCategory } from "./categories";

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

/** Lowercase host + path, with port, leading "www.", query, hash and trailing slash removed. */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./i, "")}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Length of the best url match for a category, or 0 for none. */
function urlScore(adUrl: string, category: StrategyCategory): number {
  let best = 0;
  if (category.landingPageUrl) {
    const target = normalizeUrl(category.landingPageUrl);
    // A bare host would swallow every ad on the site, so only paths count.
    if (target && target.includes("/") && (adUrl === target || adUrl.startsWith(`${target}/`))) {
      best = target.length;
    }
  }
  for (const pattern of category.urlPatterns) {
    const p = pattern.trim().toLowerCase();
    if (p && adUrl.includes(p)) best = Math.max(best, p.length);
  }
  return best;
}

function escapeRegExp(s: string): string {
  const backslash = String.fromCharCode(92);
  return [...s].map((ch) => (".*+?^${}()|[]".includes(ch) || ch === backslash ? backslash + ch : ch)).join("");
}

/** Length of the longest whole-word, case-insensitive term found in the text. */
function nameScore(text: string, category: StrategyCategory): number {
  let best = 0;
  for (const raw of [category.name, ...category.keywords]) {
    const term = raw.trim();
    if (!term) continue;
    const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`, "i");
    if (re.test(text)) best = Math.max(best, term.length);
  }
  return best;
}

type Match = { category: StrategyCategory; via: "url" | "name" };

function matchAd(
  ad: AuditAd,
  categories: StrategyCategory[],
  adSetName: string,
  campaignName: string,
): Match | null {
  const adUrl = ad.linkUrl ? normalizeUrl(ad.linkUrl) : null;
  if (adUrl) {
    let best: Match | null = null;
    let bestScore = 0;
    for (const category of categories) {
      const score = urlScore(adUrl, category);
      if (score > bestScore) {
        best = { category, via: "url" };
        bestScore = score;
      }
    }
    if (best) return best;
  }
  // Ad name first, then ad set, then campaign: the first level with a hit decides.
  for (const text of [ad.name, adSetName, campaignName]) {
    if (!text) continue;
    let best: Match | null = null;
    let bestScore = 0;
    for (const category of categories) {
      const score = nameScore(text, category);
      if (score > bestScore) {
        best = { category, via: "name" };
        bestScore = score;
      }
    }
    if (best) return best;
  }
  return null;
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
