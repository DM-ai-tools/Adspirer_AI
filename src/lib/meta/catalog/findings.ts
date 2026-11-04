import type {
  CatalogDiagnostic,
  CatalogEventMatch,
  CatalogFeed,
  CatalogProductSet,
  CatalogSnapshot,
} from "./types";

/**
 * Thresholds for the catalogue checks. Every value is a judgement call, not a Meta rule.
 */
export const CATALOG_THRESHOLDS = {
  /**
   * Fewest in-stock items a used product set should have. Meta needs a pool of items to
   * rotate through; a handful of products starves delivery and keeps ad sets in learning.
   */
  minDeliverableItems: 20,
  /**
   * Out-of-stock share (0-1) above which a used set is worth flagging. Retail catalogues
   * always carry some sold-out stock, so 20% is where wasted delivery becomes material.
   */
  outOfStockShareHigh: 0.2,
  /**
   * Hours since the last scheduled upload after which a feed counts as stale. Daily feeds
   * legitimately run up to ~24h late, so 48h means at least one scheduled run was missed.
   */
  feedStaleHours: 48,
  /**
   * Matched / (matched + unmatched) below which pixel events are not mapping to catalogue
   * items. Healthy shops sit near 99%; under 90% dynamic ads lose their product signal.
   */
  matchRateLow: 0.9,
  /**
   * Share of an event's matches (this catalogue + others) that went to other catalogues
   * at which the cross-match is rated medium instead of low. Below it the shared pixel
   * is mostly attributing correctly; at or above it a visible slice of signal is misrouted.
   */
  matchedOtherShareMedium: 0.1,
} as const;

export type CatalogThresholds = { -readonly [K in keyof typeof CATALOG_THRESHOLDS]: number };

export type CatalogAdSetUse = {
  adSetId: string;
  adSetName: string;
  campaignId: string;
  accountId: string;
  productSetId: string;
  learningStatus: "LEARNING" | "SUCCESS" | "FAIL" | null;
  effectiveStatus: string;
  spendCents?: number;
};

export type CatalogFix =
  | { toolName: "update_product_set_filter"; args: { product_set_id: string; filter: string } }
  | { toolName: "request_feed_refresh"; args: { feed_id: string } }
  | { toolName: "pause_adset"; args: { account_id: string; adset_id: string } };

export type CatalogFinding = {
  /**
   * Check id. Checks that produce one finding per product set, feed or event append
   * `:<entity id>` (for example `feed_stale:123`) so ids stay unique.
   */
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  evidence: string[];
  productSetIds: string[];
  adSetIds: string[];
  howToFix: string;
  fix: CatalogFix | null;
};

export type LearningLink = {
  adSetId: string;
  productSetId: string;
  verdict: "likely_contributor" | "healthy";
  reasons: string[];
};

/** Finding plus the bookkeeping the engine needs for sorting and learning links. */
type Internal = {
  finding: CatalogFinding;
  affected: number;
  /** True when the problem applies to every ad set on the catalogue (feeds, events). */
  catalogWide: boolean;
  /** Short reason shown against a learning-limited ad set. */
  reason: string | null;
};

const SEVERITY_RANK: Record<CatalogFinding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const IN_STOCK_CONDITION = '{"availability":{"eq":"in stock"}}';
const IN_STOCK_PATTERN = /"availability"\s*:\s*\{\s*"eq"\s*:\s*"in stock"\s*\}/;

const n = (value: number): string => value.toLocaleString("en-US");
const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

function hasInStockFilter(filter: string | null): boolean {
  return filter !== null && IN_STOCK_PATTERN.test(filter);
}

function inStockFilter(existing: string | null): string {
  const trimmed = existing?.trim() ?? "";
  if (!trimmed || trimmed === "{}") return IN_STOCK_CONDITION;
  return `{"and":[${trimmed},${IN_STOCK_CONDITION}]}`;
}

function adSetsOn(uses: CatalogAdSetUse[], productSetId: string): string[] {
  return uses.filter((u) => u.productSetId === productSetId).map((u) => u.adSetId);
}

function checkDiagnostics(diagnostics: CatalogDiagnostic[]): Internal[] {
  const buckets: Array<{
    id: string;
    severity: CatalogFinding["severity"];
    title: string;
    howToFix: string;
    items: CatalogDiagnostic[];
  }> = [
    {
      id: "diagnostics_must_fix",
      severity: "high",
      title: "Catalogue items Meta says must be fixed",
      howToFix:
        "Open Commerce Manager > Catalog > Issues and work through each issue type; fixing the data in the source feed clears them on the next upload.",
      items: diagnostics.filter((d) => d.severity === "MUST_FIX"),
    },
    {
      id: "diagnostics_other",
      severity: "medium",
      title: "Catalogue diagnostics to review",
      howToFix: "Review these issue types in Commerce Manager > Catalog > Issues and fix them in the source feed.",
      items: diagnostics.filter((d) => d.severity !== "MUST_FIX" && d.severity !== "OPPORTUNITY"),
    },
    {
      id: "diagnostics_opportunity",
      severity: "low",
      title: "Catalogue improvement opportunities",
      howToFix: "Optional improvements; address them when the must-fix items are cleared.",
      items: diagnostics.filter((d) => d.severity === "OPPORTUNITY"),
    },
  ];

  const out: Internal[] = [];
  for (const bucket of buckets) {
    const items = bucket.items.filter((d) => d.affectedItems > 0);
    if (items.length === 0) continue;
    const evidence: string[] = [];
    let affected = 0;
    for (const d of items) {
      affected += d.affectedItems;
      evidence.push(`${d.title} (${d.type}): ${n(d.affectedItems)} items`);
      for (const c of d.children.filter((child) => child.affectedItems > 0)) {
        evidence.push(`  ${c.description || c.type} (${c.type}): ${n(c.affectedItems)} items`);
      }
    }
    out.push({
      finding: {
        id: bucket.id,
        severity: bucket.severity,
        title: bucket.title,
        evidence,
        productSetIds: [],
        adSetIds: [],
        howToFix: bucket.howToFix,
        fix: null,
      },
      affected,
      catalogWide: false,
      reason: null,
    });
  }
  return out;
}

function checkProductSets(sets: CatalogProductSet[], uses: CatalogAdSetUse[], t: CatalogThresholds): Internal[] {
  const out: Internal[] = [];
  for (const set of sets) {
    const adSetIds = adSetsOn(uses, set.id);
    if (set.inStockCount === null) continue;
    const inStock = set.inStockCount;
    const small = inStock < t.minDeliverableItems;

    if (small) {
      out.push({
        finding: {
          id: `small_product_set:${set.id}`,
          severity: inStock === 0 ? "critical" : "high",
          title: `Product set "${set.name}" has too few in-stock items`,
          evidence: [
            `${n(inStock)} in stock out of ${n(set.productCount)} items (minimum ${n(t.minDeliverableItems)})`,
          ],
          productSetIds: [set.id],
          adSetIds,
          howToFix:
            "Widen the product set's filter, or point the ad set at a broader set, so enough in-stock items are available to deliver.",
          fix: null,
        },
        affected: inStock,
        catalogWide: false,
        reason: `Its product set "${set.name}" has only ${n(inStock)} in-stock items (minimum ${n(t.minDeliverableItems)}).`,
      });
    }

    if (set.productCount > 0) {
      const outOfStock = set.productCount - inStock;
      const share = outOfStock / set.productCount;
      if (share > t.outOfStockShareHigh) {
        const alreadyFiltered = hasInStockFilter(set.filter);
        // A set already starved of deliverable items gains nothing from a narrower filter.
        const noFix = alreadyFiltered || small;
        out.push({
          finding: {
            id: `out_of_stock_in_used_set:${set.id}`,
            severity: share >= 0.5 ? "high" : "medium",
            title: `Product set "${set.name}" is ${pct(share)} out of stock`,
            evidence: [
              `${n(outOfStock)} of ${n(set.productCount)} items are out of stock (${pct(share)}); threshold ${pct(t.outOfStockShareHigh)}`,
            ],
            productSetIds: [set.id],
            adSetIds,
            howToFix: small
              ? "Narrowing this set to in-stock items would not help; widen its filter first (see the small product set finding)."
              : alreadyFiltered
              ? "The set already filters to in-stock items; check the feed's availability values, as the stock counts disagree with the filter."
              : "Add an availability = in stock condition to the product set's filter so ads only show items that can be bought.",
            fix: noFix
              ? null
              : {
                  toolName: "update_product_set_filter",
                  args: { product_set_id: set.id, filter: inStockFilter(set.filter) },
                },
          },
          affected: outOfStock,
          catalogWide: false,
          reason: `Its product set "${set.name}" is ${pct(share)} out of stock (${n(outOfStock)} of ${n(set.productCount)} items).`,
        });
      }
    }
  }
  return out;
}

function checkFeeds(feeds: CatalogFeed[], t: CatalogThresholds, nowMs: number): Internal[] {
  const out: Internal[] = [];
  for (const feed of feeds) {
    const upload = feed.lastUpload;
    if (!upload) continue;

    if (feed.scheduleUrl && upload.endTime) {
      const endMs = Date.parse(upload.endTime);
      if (Number.isFinite(endMs)) {
        const hours = Math.floor((nowMs - endMs) / 3600_000);
        if (hours > t.feedStaleHours) {
          out.push({
            finding: {
              id: `feed_stale:${feed.id}`,
              severity: "medium",
              title: `Feed "${feed.name}" has not updated in ${n(hours)} hours`,
              evidence: [
                `Last upload finished ${n(hours)} hours ago (threshold ${n(t.feedStaleHours)} hours)`,
                `Scheduled from ${feed.scheduleUrl}${feed.scheduleInterval ? ` (${feed.scheduleInterval})` : ""}`,
              ],
              productSetIds: [],
              adSetIds: [],
              howToFix:
                "Request a feed refresh. If it keeps going stale, check that the feed URL is reachable and the schedule is still active.",
              fix: { toolName: "request_feed_refresh", args: { feed_id: feed.id } },
            },
            affected: feed.productCount,
            catalogWide: true,
            reason: `Feed "${feed.name}" last updated ${n(hours)} hours ago, so prices and stock may be out of date.`,
          });
        }
      }
    }

    if (upload.errorCount > 0) {
      out.push({
        finding: {
          id: `feed_upload_errors:${feed.id}`,
          severity: "medium",
          title: `Feed "${feed.name}" last upload had errors`,
          evidence: [`${n(upload.errorCount)} errors and ${n(upload.warningCount)} warnings in the last upload`],
          productSetIds: [],
          adSetIds: [],
          howToFix: "Open the feed's upload history in Commerce Manager, fix the rows with errors in the source, and re-upload.",
          fix: null,
        },
        affected: upload.errorCount,
        catalogWide: true,
        reason: `Feed "${feed.name}" had ${n(upload.errorCount)} errors in its last upload.`,
      });
    }
  }
  return out;
}

function checkEvents(events: CatalogEventMatch[], t: CatalogThresholds): Internal[] {
  const out: Internal[] = [];
  for (const e of events) {
    const total = e.matched + e.unmatched;
    if (total > 0) {
      const rate = e.matched / total;
      if (rate < t.matchRateLow) {
        out.push({
          finding: {
            id: `low_match_rate:${e.event}`,
            severity: rate < 0.5 ? "high" : "medium",
            title: `${e.event} events match the catalogue only ${pct(rate)} of the time`,
            evidence: [
              `${e.event}: ${n(e.matched)} matched, ${n(e.unmatched)} unmatched (${pct(rate)}); threshold ${pct(t.matchRateLow)}`,
            ],
            productSetIds: [],
            adSetIds: [],
            howToFix:
              "Make the pixel's content_ids use the same values as the feed's id column (or the retailer_id), then re-check match rates after a day.",
            fix: null,
          },
          affected: e.unmatched,
          catalogWide: true,
          reason: `${e.event} events match this catalogue only ${pct(rate)} of the time.`,
        });
      }
    }

    if (e.matchedOtherCatalogs > 0) {
      const share = e.matchedOtherCatalogs / (e.matched + e.matchedOtherCatalogs);
      // A tiny share would otherwise print as "0.0%".
      const shareText = share < 0.001 ? "under 0.1%" : pct(share);
      out.push({
        finding: {
          id: `matched_other_catalog:${e.event}`,
          severity: share >= t.matchedOtherShareMedium ? "medium" : "low",
          title: `${e.event} events are also matching other catalogues`,
          evidence: [
            `${e.event}: ${n(e.matchedOtherCatalogs)} events matched other catalogues vs ${n(e.matched)} matched to this one (${shareText} of matches)`,
          ],
          productSetIds: [],
          adSetIds: [],
          howToFix:
            "The pixel is shared with another catalogue. Use a dedicated pixel, or make product ids unique per catalogue, so events attribute to the right items.",
          fix: null,
        },
        affected: e.matchedOtherCatalogs,
        catalogWide: true,
        // A low-share cross-match is reported but is too small to explain a learning failure.
        reason:
          share >= t.matchedOtherShareMedium
            ? `${n(e.matchedOtherCatalogs)} ${e.event} events matched other catalogues instead of this one.`
            : null,
      });
    }
  }
  return out;
}

export function evaluateCatalog(
  snapshot: CatalogSnapshot,
  uses: CatalogAdSetUse[],
  thresholds: Partial<CatalogThresholds> = {},
): { findings: CatalogFinding[]; learningLinks: LearningLink[] } {
  const t: CatalogThresholds = { ...CATALOG_THRESHOLDS, ...thresholds };
  const fetchedMs = Date.parse(snapshot.fetchedAt);
  const nowMs = Number.isFinite(fetchedMs) ? fetchedMs : Date.now();

  const internals = [
    ...checkDiagnostics(snapshot.diagnostics),
    ...checkProductSets(snapshot.productSets, uses, t),
    ...checkFeeds(snapshot.feeds, t, nowMs),
    ...checkEvents(snapshot.events, t),
  ].sort(
    (a, b) =>
      SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
      b.affected - a.affected ||
      a.finding.id.localeCompare(b.finding.id),
  );

  const learningLinks: LearningLink[] = [];
  for (const u of uses) {
    if (u.learningStatus !== "FAIL") continue;
    const reasons = internals
      .filter((i) => i.reason && (i.catalogWide || i.finding.productSetIds.includes(u.productSetId)))
      .map((i) => i.reason as string);
    const set = snapshot.productSets.find((s) => s.id === u.productSetId);
    const unchecked =
      set === undefined
        ? `Product set ${u.productSetId} could not be checked (not found in the catalogue snapshot)`
        : set.inStockCount === null
          ? `Product set ${u.productSetId} could not be checked (stock count unavailable)`
          : null;
    if (reasons.length > 0) {
      learningLinks.push({
        adSetId: u.adSetId,
        productSetId: u.productSetId,
        verdict: "likely_contributor",
        reasons: unchecked ? [...reasons, unchecked] : reasons,
      });
    } else {
      learningLinks.push({
        adSetId: u.adSetId,
        productSetId: u.productSetId,
        verdict: "healthy",
        reasons: [
          unchecked
            ? `${unchecked}; no catalogue-wide problem found`
            : "No catalogue problem found for this ad set's product set, feeds or event matching.",
        ],
      });
    }
  }

  return { findings: internals.map((i) => i.finding), learningLinks };
}
