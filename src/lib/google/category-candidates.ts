import { logger } from "@/lib/observability/logger";
import { categoryPageOf, discoverCategoryCandidates, type CategoryCandidate } from "@/lib/scraping/site-map";
import { GENERIC_COLLECTIONS, isRankingPhrase, sameCategoryName } from "@/lib/strategy/requested-category";
import type { ClientService } from "@/types";
import { clientGoogleAssets } from "./assets";
import { GoogleReconnectRequired } from "./oauth";
import { getGoogleDataProvider } from "./provider";
import type { DateRange } from "./types";

/**
 * Category candidates from a client's mapped GA4 property and Search Console
 * site: GA4 item categories joined by name to the category pages GA4 landing
 * pages and Search Console pages point at, with revenue, clicks and an order
 * value for each. Read-only; never throws.
 */

export type GoogleCategoryCandidate = CategoryCandidate & {
  /** GA4 item revenue for the category; the page's purchase revenue when it has no item category. */
  revenueCents: number;
  purchases: number;
  gscClicks: number;
  /** Up to 3 Search Console queries by clicks. */
  topQueries: string[];
  average_order_value_cents: number | null;
  /** true when the order value comes from item revenue / items, not the page's own orders. */
  aovEstimated: boolean;
  /** Higher is more important: the top candidate gets the highest number. */
  priority: number;
  /** Ticked by default: it earned revenue and isn't added yet. */
  preselect: boolean;
};

export type GoogleCandidatesUnavailableReason = "not_mapped" | "reconnect" | "failed";

export type GoogleCandidatesResult =
  | {
      source: "google";
      /** GA4's currency; null when only Search Console is mapped. */
      currency: string | null;
      candidates: GoogleCategoryCandidate[];
      warnings: string[];
      reason?: undefined;
    }
  | { source: "unavailable"; reason: GoogleCandidatesUnavailableReason; candidates: [] };

const unavailable = (reason: GoogleCandidatesUnavailableReason): GoogleCandidatesResult => ({
  source: "unavailable",
  reason,
  candidates: [],
});

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS = 90;
/** Purchases a page needs before its own order value is trusted. */
const MIN_PAGE_PURCHASES = 3;
const TOP_QUERIES = 3;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The 90 full days up to yesterday (UTC), as YYYY-MM-DD. */
export function last90Days(now: Date = new Date()): DateRange {
  const until = Date.parse(day(now.getTime())) - DAY_MS;
  return { since: day(until - (RANGE_DAYS - 1) * DAY_MS), until: day(until) };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const GIFT_CARD = /^(?:e-?)?gift[\s-]*cards?$/i;

/** Placeholders, gift cards, catch-all collections and rankings ("Best Selling Products") are never a category. */
function isJunk(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return !lower || lower === "(not set)" || lower === "(other)" || GIFT_CARD.test(lower) || GENERIC_COLLECTIONS.has(lower) || isRankingPhrase(lower);
}

/** The site's origin: the client's website, else the Search Console site ("sc-domain:x.com" is https://x.com). */
function siteBase(websiteUrl: string | null | undefined, gscSite: string | null | undefined): string | null {
  const origin = (raw: string) => {
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const site = websiteUrl?.trim();
  if (site) {
    const fromSite = origin(site);
    if (fromSite) return fromSite;
  }
  const gsc = gscSite?.trim();
  if (!gsc) return null;
  return origin(gsc.replace(/^sc-domain:/i, ""));
}

type PageStats = { revenueCents: number; purchases: number; clicks: number; queries: Array<{ clicks: number; list: string[] }> };

function labelSegments(label: string): string[] {
  return label.split(/[>/]/).map((s) => s.trim()).filter(Boolean);
}

/** The label itself, then for a "A > B" or "A/B" path each segment from the last to the first. */
function labelNames(label: string): string[] {
  const segments = labelSegments(label);
  return segments.length > 1 ? [label, ...segments.reverse()] : [label];
}

/** What a category with no page is called: the last segment of a "A > B" path ("B"), else the label. */
function labelName(label: string): string {
  return labelSegments(label).at(-1) ?? label;
}

export async function googleCategoryCandidates(input: {
  clientId: string;
  existing: ClientService[];
  websiteUrl: string | null | undefined;
  now?: Date;
}): Promise<GoogleCandidatesResult> {
  const { clientId, existing } = input;
  try {
    const assets = await clientGoogleAssets(clientId);
    if (!assets.ga4 && !assets.gsc) return unavailable("not_mapped");
    const provider = getGoogleDataProvider();
    const range = last90Days(input.now);

    const failures = new Set<string>();
    let attempted = 0;
    const part = async <T>(label: string, call: () => Promise<T>): Promise<T | null> => {
      attempted += 1;
      try {
        return await call();
      } catch (error) {
        if (error instanceof GoogleReconnectRequired) throw error;
        failures.add(`${label}: ${message(error)}`);
        return null;
      }
    };
    const ga4Id = assets.ga4?.external_id;
    const gscId = assets.gsc?.external_id;
    const [items, landing, gsc] = await Promise.all([
      ga4Id ? part("GA4", () => provider.ga4CategoryRevenue(ga4Id, range, { byItemChannel: false })) : null,
      ga4Id ? part("GA4", () => provider.ga4LandingPages(ga4Id, range)) : null,
      gscId ? part("Search Console", () => provider.searchDemand(gscId, range)) : null,
    ]);
    const succeeded = [items, landing, gsc].filter((x) => x != null).length;
    if (attempted > 0 && succeeded === 0) {
      logger.warn("Google category candidates: couldn't read Google", { clientId, error: [...failures].join("; ") });
      return unavailable("failed");
    }
    const warnings = [...new Set([...failures, ...(items?.warnings ?? []), ...(landing?.warnings ?? [])])];

    // Category pages: GA4 landing paths and Search Console pages, read like the website scan.
    const base = siteBase(input.websiteUrl, gscId);
    const stats = new Map<string, PageStats>();
    const statsOf = (path: string) => {
      const entry = stats.get(path) ?? { revenueCents: 0, purchases: 0, clicks: 0, queries: [] };
      stats.set(path, entry);
      return entry;
    };
    const urls: string[] = [];
    if (base) {
      for (const row of landing?.rows ?? []) {
        let url: string;
        try {
          url = new URL(row.path, base).href;
        } catch {
          continue;
        }
        const page = categoryPageOf(url, base);
        if (!page) continue;
        urls.push(url);
        const entry = statsOf(page.path);
        entry.revenueCents += row.revenueCents;
        entry.purchases += row.purchases;
      }
      for (const row of gsc?.rows ?? []) {
        const page = categoryPageOf(row.page, base);
        if (!page) continue;
        urls.push(row.page);
        const entry = statsOf(page.path);
        entry.clicks += row.clicks;
        entry.queries.push({ clicks: row.clicks, list: row.topQueries });
      }
    }
    const pages = base
      ? discoverCategoryCandidates(urls, base, existing).map((candidate) => ({
          candidate,
          stats: stats.get(categoryPageOf(candidate.landing_page_url ?? "", base)?.path ?? "") ?? {
            revenueCents: 0, purchases: 0, clicks: 0, queries: [],
          },
        }))
      : [];

    // GA4 item categories joined to their page by name (plural-tolerant).
    type Entry = {
      name: string;
      page: (typeof pages)[number] | null;
      itemRevenueCents: number;
      itemPurchases: number;
      hasItem: boolean;
    };
    const entries = new Map<string, Entry>();
    const itemRows = items?.method === "item" ? items.rows : [];
    for (const row of itemRows) {
      const label = row.key.trim();
      if (isJunk(label)) continue;
      let name = labelName(label);
      let page: Entry["page"] = null;
      for (const candidateName of labelNames(label)) {
        const hits = pages.filter((p) => sameCategoryName(candidateName, p.candidate.name));
        if (!hits.length) continue;
        page = hits.sort((a, b) => b.stats.revenueCents - a.stats.revenueCents || b.stats.clicks - a.stats.clicks)[0]!;
        name = candidateName;
        break;
      }
      if (isJunk(name)) continue;
      const key = page ? `page:${page.candidate.landing_page_url}` : `name:${name.toLowerCase()}`;
      const entry = entries.get(key) ?? { name, page, itemRevenueCents: 0, itemPurchases: 0, hasItem: true };
      entry.itemRevenueCents += row.revenueCents;
      entry.itemPurchases += row.purchases;
      entries.set(key, entry);
    }
    // Pages no item category named: named from the slug.
    for (const page of pages) {
      const key = `page:${page.candidate.landing_page_url}`;
      if (!entries.has(key)) {
        entries.set(key, { name: page.candidate.name, page, itemRevenueCents: 0, itemPurchases: 0, hasItem: false });
      }
    }

    const built = [...entries.values()].flatMap((entry) => {
      const pageStats = entry.page?.stats ?? null;
      const revenueCents = entry.hasItem ? entry.itemRevenueCents : (pageStats?.revenueCents ?? 0);
      const purchases = entry.hasItem ? entry.itemPurchases : (pageStats?.purchases ?? 0);
      const gscClicks = pageStats?.clicks ?? 0;
      if (isJunk(entry.name) || (revenueCents <= 0 && gscClicks <= 0)) return [];
      let aov: number | null = null;
      let aovEstimated = false;
      if (pageStats && pageStats.purchases >= MIN_PAGE_PURCHASES && pageStats.revenueCents > 0) {
        aov = Math.round(pageStats.revenueCents / pageStats.purchases);
      } else if (entry.itemPurchases > 0 && entry.itemRevenueCents > 0) {
        aov = Math.round(entry.itemRevenueCents / entry.itemPurchases);
        aovEstimated = true;
      }
      const topQueries = [
        ...new Set(
          [...(pageStats?.queries ?? [])].sort((a, b) => b.clicks - a.clicks).flatMap((q) => q.list),
        ),
      ].slice(0, TOP_QUERIES);
      const alreadyAdded =
        (entry.page?.candidate.alreadyAdded ?? false) || existing.some((s) => sameCategoryName(entry.name, s.name));
      return [{
        name: entry.name,
        landing_page_url: entry.page?.candidate.landing_page_url ?? null,
        alreadyAdded,
        revenueCents,
        purchases,
        gscClicks,
        topQueries,
        average_order_value_cents: aov,
        aovEstimated,
      }];
    });

    built.sort((a, b) => b.revenueCents - a.revenueCents || b.gscClicks - a.gscClicks || a.name.localeCompare(b.name));
    const seen = new Set<string>();
    const unique = built.filter((c) => {
      const key = c.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const candidates: GoogleCategoryCandidate[] = unique.map((c, i) => ({
      ...c,
      priority: unique.length - i,
      preselect: c.revenueCents > 0 && !c.alreadyAdded,
    }));

    const currency = items?.currency || landing?.currency || assets.ga4?.currency || null;
    return { source: "google", currency, candidates, warnings };
  } catch (error) {
    if (error instanceof GoogleReconnectRequired) return unavailable("reconnect");
    logger.warn("Google category candidates: couldn't read Google", { clientId, error: message(error) });
    return unavailable("failed");
  }
}
