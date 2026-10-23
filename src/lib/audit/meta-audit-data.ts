import type { MetaGraphClient } from "@/lib/meta/graph-client";
import { metaMinorToCents } from "@/lib/meta/currency";
import { resultLabelFor } from "@/lib/meta/account-dashboard";
import { extractCreativeDestination } from "@/lib/meta/extract-creative-destination";

/**
 * Everything the audit checkpoints need, pulled from Meta in one pass:
 * tracking (pixels, event volume, server events, customer-info share),
 * structure (campaigns, ad sets, ads), audiences and period performance.
 *
 * Money is in app cents (major × 100), like the rest of the app.
 */

export type PixelEventStats = {
  /** Event name → count over the window (e.g. { PageView: 986, Lead: 198 }). */
  events: Record<string, number>;
  /** Share of events sent server-side (Conversions API), 0–1; null if unknown. */
  serverShare: number | null;
  /** Event name → share of events carrying customer info (match-quality proxy). */
  piiShare: Record<string, number>;
};

export type AuditPixel = {
  id: string;
  name: string;
  lastFiredTime: string | null;
  automaticMatching: boolean;
  /** Last 7 days. */
  stats7d: PixelEventStats | null;
  /** Last 28 days. */
  stats28d: PixelEventStats | null;
};

export type AuditCustomConversion = {
  id: string;
  name: string;
  eventType: string;
  lastFiredTime: string | null;
  archived: boolean;
};

export type AuditAudience = {
  id: string;
  name: string;
  subtype: string;
  /** Lower bound of the size estimate; null when Meta hides it. */
  sizeLower: number | null;
  ready: boolean;
  problem: string | null;
};

export type PeriodPerformance = {
  spendCents: number;
  impressions: number;
  reach: number;
  frequency: number;
  linkCtr: number;
  cpmCents: number | null;
  results: number | null;
  resultLabel: string;
  costPerResultCents: number | null;
  roas: number | null;
  /** Inline link clicks and landing page views, when Meta returned them. */
  linkClicks?: number;
  landingPageViews?: number | null;
  /** Video: 3-second plays and ThruPlays, when the ad has video. */
  videoViews3s?: number | null;
  thruplays?: number | null;
  /**
   * Set on totals added up across campaigns: people overlap between
   * campaigns, so reach (and frequency) can't be summed — `reach` and
   * `frequency` are then not real figures and must not be shown.
   */
  reachSummed?: true;
};

export type AuditCampaign = {
  id: string;
  name: string;
  objective: string;
  status: string;
  bidStrategy: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  advantagePlus: boolean;
  specialAdCategories: string[];
  createdTime: string | null;
  performance: PeriodPerformance | null;
  /** Same-length period just before the audit window. */
  previousPerformance?: PeriodPerformance | null;
};

export type AuditAdSet = {
  id: string;
  name: string;
  campaignId: string;
  status: string;
  optimizationGoal: string | null;
  bidStrategy: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  /** LEARNING | SUCCESS | FAIL (learning limited) | null. */
  learningStatus: string | null;
  lastSignificantEdit: string | null;
  pixelId: string | null;
  customEventType: string | null;
  customConversionId: string | null;
  /** e.g. ["7d_click", "1d_view"]. */
  attributionWindows: string[];
  includedAudienceIds: string[];
  excludedAudienceIds: string[];
  advantageAudience: boolean | null;
  publisherPlatforms: string[];
  countries: string[];
  /** Frequency over the last 7 days (benchmarks are weekly). */
  frequency7d: number | null;
  performance: PeriodPerformance | null;
  /** Same-length period just before the audit window. */
  previousPerformance?: PeriodPerformance | null;
};

export type AuditAd = {
  id: string;
  name: string;
  adSetId: string;
  campaignId: string;
  status: string;
  createdTime: string | null;
  format: string | null;
  issue: string | null;
  performance: PeriodPerformance | null;
  /** The creative's url_tags (UTMs); undefined when not loaded. */
  urlTags?: string | null;
  /** The creative's destination link, when Meta returns it. */
  linkUrl?: string | null;
  /** Frequency over the last 7 days (fatigue is judged weekly). */
  frequency7d?: number | null;
  /** Meta's quality / engagement / conversion rankings, when reported. */
  rankings?: { quality: string | null; engagement: string | null; conversion: string | null } | null;
};

/** One catalog (product) ad's spend on one product, from Meta's product_id breakdown. */
export type AuditCatalogProduct = {
  adId: string;
  /** The catalog product's id: the Shopify variant id for Shopify catalogs. */
  productId: string;
  spendCents: number;
  purchaseValueCents: number;
  results: number;
  /** The product's GA4 item category; filled in once GA4 is read, unknown (null/absent) until then. */
  itemCategory?: string | null;
};

export type MetaAuditSnapshot = {
  account: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    statusCode: number;
    disableReason: string | null;
    amountSpentCents: number;
    spendCapCents: number | null;
  };
  period: { days: number; since: string; until: string };
  totals: PeriodPerformance | null;
  /**
   * The comparison window: the range the operator named, or the same-length
   * window just before `period`. Absent when no comparison part loaded.
   */
  previousPeriod?: { since: string; until: string };
  /** True when `previousPeriod` is a range the operator named (not the period just before). */
  comparisonNamed?: boolean;
  /** Comparison parts that failed to load (the rest still compare). */
  comparisonFailures?: Array<"totals" | "campaigns" | "ad sets">;
  previousTotals?: PeriodPerformance | null;
  /** Set when no comparison was asked for: nothing before the period was loaded, and nothing failed. */
  comparisonNotRequested?: true;
  pixels: AuditPixel[];
  customConversions: AuditCustomConversion[];
  audiences: AuditAudience[];
  campaigns: AuditCampaign[];
  adSets: AuditAdSet[];
  ads: AuditAd[];
  /** Catalog ads' spend per product; absent when the account has none or Meta wouldn't return it. */
  catalogProducts?: AuditCatalogProduct[];
  /** Spend by publisher platform (facebook, instagram, audience_network…). */
  placements: Array<{ platform: string; spendCents: number; results: number | null }>;
  /** Parts that failed to load — checkpoints that need them report "not checked". */
  warnings: string[];
  fetchedAt: string;
  demo?: boolean;
  /** Set when the audit covers selected campaigns, not the whole account. */
  scope?: { campaigns: Array<{ id: string; name: string }> };
};

// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Graph = Pick<MetaGraphClient, "get">;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const major = (v: unknown) => Math.round(num(v) * 100);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

async function settle<T>(label: string, warnings: string[], p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (error) {
    warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function paged(graph: Graph, path: string, params: Record<string, string | number>, maxPages = 5): Promise<Row[]> {
  const rows: Row[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await graph.get<{ data?: Row[]; paging?: { cursors?: { after?: string }; next?: string } }>(path, {
      ...params,
      ...(after ? { after } : {}),
    });
    rows.push(...(res.data ?? []));
    after = res.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return rows;
}

/** Meta "Results" for the row's optimisation goal (same as Ads Manager). */
function performanceFrom(row: Row | undefined): PeriodPerformance | null {
  if (!row) return null;
  const results = Array.isArray(row.results) ? (row.results as Array<{ indicator?: string; values?: Array<{ value?: string }> }>) : [];
  const indicator = results[0]?.indicator ?? null;
  const count = indicator && indicator !== "mixed" ? num(results[0]?.values?.[0]?.value) : null;
  const spendCents = major(row.spend);
  const roasRows = Array.isArray(row.purchase_roas) ? (row.purchase_roas as Array<{ value?: string }>) : [];
  const actions = Array.isArray(row.actions) ? (row.actions as Array<{ action_type?: string; value?: string }>) : [];
  const lpv = actions.find((a) => a.action_type === "landing_page_view");
  const videoView = actions.find((a) => a.action_type === "video_view");
  const thru = Array.isArray(row.video_thruplay_watched_actions)
    ? (row.video_thruplay_watched_actions as Array<{ value?: string }>)[0]
    : undefined;
  return {
    spendCents,
    impressions: num(row.impressions),
    reach: num(row.reach),
    frequency: num(row.frequency),
    linkCtr: num(row.inline_link_click_ctr),
    cpmCents: row.cpm != null ? major(row.cpm) : null,
    results: count,
    resultLabel: indicator === "mixed" ? "Mixed goals" : indicator ? resultLabelFor(indicator) : "Results",
    costPerResultCents: count && count > 0 ? Math.round(spendCents / count) : null,
    roas: roasRows[0]?.value != null ? num(roasRows[0].value) : null,
    ...(row.inline_link_clicks != null ? { linkClicks: num(row.inline_link_clicks) } : {}),
    ...(row.actions !== undefined ? { landingPageViews: lpv ? num(lpv.value) : 0 } : {}),
    ...(videoView ? { videoViews3s: num(videoView.value), thruplays: thru ? num(thru.value) : null } : {}),
  };
}

/** Sum hourly/daily stats buckets into totals. */
function summariseStats(rows: Row[] | null, key: "value" | "event" = "value"): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const bucket of rows ?? []) {
    for (const item of (bucket.data as Row[] | undefined) ?? []) {
      const k = String(item[key] ?? item.value ?? "");
      if (!k) continue;
      totals[k] = (totals[k] ?? 0) + num(item.count);
    }
  }
  return totals;
}

export async function pixelStats(graph: Graph, pixelId: string, days: number): Promise<PixelEventStats> {
  const start = Math.floor(Date.now() / 1000) - days * 86_400;
  const [events, sources, pii] = await Promise.all([
    graph.get<{ data?: Row[] }>(`${pixelId}/stats`, { aggregation: "event", start_time: start }),
    graph.get<{ data?: Row[] }>(`${pixelId}/stats`, { aggregation: "event_source", start_time: start }).catch(() => null),
    graph.get<{ data?: Row[] }>(`${pixelId}/stats`, { aggregation: "had_pii", start_time: start }).catch(() => null),
  ]);
  const sourceTotals = summariseStats(sources?.data ?? null);
  const server = sourceTotals.SERVER ?? 0;
  const all = Object.values(sourceTotals).reduce((a, b) => a + b, 0);
  const piiByEvent: Record<string, { yes: number; all: number }> = {};
  for (const bucket of pii?.data ?? []) {
    for (const item of (bucket.data as Row[] | undefined) ?? []) {
      const event = String(item.event ?? "");
      if (!event) continue;
      const entry = (piiByEvent[event] ??= { yes: 0, all: 0 });
      entry.all += num(item.count);
      if (item.value === "has_pii") entry.yes += num(item.count);
    }
  }
  return {
    events: summariseStats(events.data ?? null),
    serverShare: sources ? (all > 0 ? server / all : 0) : null,
    piiShare: Object.fromEntries(
      Object.entries(piiByEvent).map(([event, v]) => [event, v.all ? v.yes / v.all : 0]),
    ),
  };
}

/** Pages of 500 product rows read; a very large catalog is cut off and said so. */
const PRODUCT_PAGES = 12;

/** Meta's purchase count or value out of an actions / action_values list. */
function purchaseOf(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  const rows = list as Array<{ action_type?: string; value?: string }>;
  const pick = (type: string) => rows.find((r) => r.action_type === type);
  return num((pick("omni_purchase") ?? pick("purchase"))?.value);
}

/** The catalog product id: Meta may return it with a "name" after a comma or as a retailer id ending in the variant id. */
export function catalogProductId(raw: unknown): string {
  const text = String(raw ?? "").trim();
  const lead = text.split(",")[0]!.trim();
  return lead.match(/(\d+)$/)?.[1] ?? lead;
}

function catalogProductsFrom(rows: Row[] | null, warnings: string[]): AuditCatalogProduct[] | undefined {
  if (!rows) return undefined;
  const out: AuditCatalogProduct[] = [];
  for (const r of rows) {
    const productId = catalogProductId(r.product_id);
    const adId = String(r.ad_id ?? "");
    if (!productId || !adId) continue;
    const spendCents = major(r.spend);
    if (spendCents <= 0) continue;
    out.push({
      adId,
      productId,
      spendCents,
      purchaseValueCents: major(purchaseOf(r.action_values)),
      results: purchaseOf(r.actions),
    });
  }
  if (rows.length >= PRODUCT_PAGES * 500) {
    warnings.push("Catalog product spend: more products than were read; per-category catalog spend may be understated");
  }
  return out.length > 0 ? out : undefined;
}

function dayString(d: Date) {
  return d.toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/** The same number of days immediately before `since` → `until`. */
export function previousPeriodOf(since: string, until: string): { since: string; until: string } {
  const start = Date.parse(`${since}T00:00:00Z`);
  const days = Math.round((Date.parse(`${until}T00:00:00Z`) - start) / DAY_MS) + 1;
  return {
    since: dayString(new Date(start - days * DAY_MS)),
    until: dayString(new Date(start - DAY_MS)),
  };
}

export type AuditSnapshotOptions = {
  days?: number;
  since?: string;
  until?: string;
  /**
   * Load a comparison window at all. Default true (monitoring compares with
   * the period just before); false loads the audited period alone.
   */
  compare?: boolean;
  /** A comparison range the operator named; default is the same-length period just before. */
  compareSince?: string;
  compareUntil?: string;
};

/** The snapshot without any comparison data, marked as not requested. */
function withoutComparison(snap: MetaAuditSnapshot): MetaAuditSnapshot {
  const dropPrevious = <T extends { previousPerformance?: PeriodPerformance | null }>(row: T): T => {
    const copy = { ...row };
    delete copy.previousPerformance;
    return copy;
  };
  const out: MetaAuditSnapshot = {
    ...snap,
    comparisonNotRequested: true,
    campaigns: snap.campaigns.map(dropPrevious),
    adSets: snap.adSets.map(dropPrevious),
  };
  delete out.previousPeriod;
  delete out.comparisonNamed;
  delete out.comparisonFailures;
  delete out.previousTotals;
  return out;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The named comparison range when it's valid, else the period just before. */
export function comparisonPeriodOf(
  since: string,
  until: string,
  options: Pick<AuditSnapshotOptions, "compareSince" | "compareUntil"> = {},
): { since: string; until: string; named: boolean } {
  const { compareSince: a, compareUntil: b } = options;
  if (a && b && ISO_DAY.test(a) && ISO_DAY.test(b) && a <= b) return { since: a, until: b, named: true };
  return { ...previousPeriodOf(since, until), named: false };
}

export async function fetchMetaAuditSnapshot(
  graph: Graph,
  accountId: string,
  options: AuditSnapshotOptions = {},
): Promise<MetaAuditSnapshot> {
  const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  const warnings: string[] = [];
  const until = options.until ?? dayString(new Date(Date.now() - DAY_MS));
  const since = options.since ?? dayString(new Date(Date.parse(`${until}T00:00:00Z`) - ((options.days ?? 30) - 1) * DAY_MS));
  const days = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS) + 1;
  const timeRange = JSON.stringify({ since, until });
  // No comparison asked for: nothing before the period is fetched.
  const compare = options.compare !== false;
  const comparison = comparisonPeriodOf(since, until, options);
  const previousPeriod = { since: comparison.since, until: comparison.until };
  const previousRange = JSON.stringify(previousPeriod);
  const comparisonLabel = `Comparison period (${previousPeriod.since} → ${previousPeriod.until})`;

  const account = await graph.get<Row>(id, {
    fields: "name,currency,timezone_name,account_status,disable_reason,amount_spent,spend_cap",
  });
  const currency = String(account.currency ?? "USD");
  const toCents = (minor: unknown) => metaMinorToCents(num(minor), currency);
  const notDeleted = JSON.stringify(["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "WITH_ISSUES", "DISAPPROVED", "PENDING_REVIEW", "IN_PROCESS"]);
  const insightFields =
    "spend,impressions,reach,frequency,inline_link_click_ctr,inline_link_clicks,actions,cpm,results,cost_per_result,purchase_roas";

  const [
    pixels, customConversions, audiences, campaigns, adSets, ads, totals, campaignIns, adSetIns, adIns, placements, adSetWeek,
    previousTotals, previousCampaignIns, previousAdSetIns, adWeek, productIns,
  ] =
    await Promise.all([
      settle("Pixels", warnings, paged(graph, `${id}/adspixels`, {
        fields: "id,name,last_fired_time,enable_automatic_matching",
        limit: 50,
      }, 2)),
      settle("Custom conversions", warnings, paged(graph, `${id}/customconversions`, {
        fields: "id,name,custom_event_type,last_fired_time,is_archived",
        limit: 100,
      }, 2)),
      settle("Custom audiences", warnings, paged(graph, `${id}/customaudiences`, {
        fields: "id,name,subtype,approximate_count_lower_bound,delivery_status,operation_status",
        limit: 100,
      }, 3)),
      settle("Campaigns", warnings, paged(graph, `${id}/campaigns`, {
        fields: "id,name,objective,effective_status,bid_strategy,daily_budget,lifetime_budget,special_ad_categories,smart_promotion_type,created_time",
        effective_status: notDeleted,
        limit: 200,
      })),
      settle("Ad sets", warnings, paged(graph, `${id}/adsets`, {
        fields:
          "id,name,campaign_id,effective_status,optimization_goal,bid_strategy,daily_budget,lifetime_budget,learning_stage_info,promoted_object,attribution_spec,targeting{custom_audiences,excluded_custom_audiences,targeting_automation,publisher_platforms,geo_locations}",
        effective_status: notDeleted,
        limit: 200,
      })),
      settle("Ads", warnings, paged(graph, `${id}/ads`, {
        fields: "id,name,adset_id,campaign_id,effective_status,created_time,issues_info,creative{object_type,video_id,image_hash,asset_feed_spec,url_tags,link_url,object_story_spec}",
        effective_status: notDeleted,
        // Smaller pages: creatives now carry object_story_spec, and big pages can trip Graph's "reduce the amount of data".
        limit: 100,
      }, 6)),
      settle("Account performance", warnings, graph.get<{ data?: Row[] }>(`${id}/insights`, {
        level: "account", time_range: timeRange, fields: insightFields,
      })),
      settle("Campaign performance", warnings, paged(graph, `${id}/insights`, {
        level: "campaign", time_range: timeRange, fields: `campaign_id,${insightFields}`, limit: 200,
      }, 2)),
      settle("Ad set performance", warnings, paged(graph, `${id}/insights`, {
        level: "adset", time_range: timeRange, fields: `adset_id,${insightFields}`, limit: 200,
      }, 3)),
      settle("Ad performance", warnings, paged(graph, `${id}/insights`, {
        level: "ad", time_range: timeRange, fields: `ad_id,quality_ranking,engagement_rate_ranking,conversion_rate_ranking,video_thruplay_watched_actions,${insightFields}`, sort: "spend_descending", limit: 200,
      }, 2)),
      settle("Placement breakdown", warnings, graph.get<{ data?: Row[] }>(`${id}/insights`, {
        level: "account", time_range: timeRange, breakdowns: "publisher_platform", fields: "spend,results",
      })),
      settle("Ad set frequency (7d)", warnings, paged(graph, `${id}/insights`, {
        level: "adset", date_preset: "last_7d", fields: "adset_id,frequency", limit: 200,
      }, 2)),
      // The comparison window (named, or the same length just before), for change-over-time.
      compare
        ? settle(`${comparisonLabel} account totals`, warnings, graph.get<{ data?: Row[] }>(`${id}/insights`, {
            level: "account", time_range: previousRange, fields: insightFields,
          }))
        : null,
      compare
        ? settle(`${comparisonLabel} campaign performance`, warnings, paged(graph, `${id}/insights`, {
            level: "campaign", time_range: previousRange, fields: `campaign_id,${insightFields}`, limit: 200,
          }, 2))
        : null,
      compare
        ? settle(`${comparisonLabel} ad set performance`, warnings, paged(graph, `${id}/insights`, {
            level: "adset", time_range: previousRange, fields: `adset_id,${insightFields}`, limit: 200,
          }, 3))
        : null,
      settle("Ad frequency (7d)", warnings, paged(graph, `${id}/insights`, {
        level: "ad", date_preset: "last_7d", fields: "ad_id,frequency", limit: 200,
      }, 2)),
      // Catalog ads have no single page or category name; their spend per product is what ties them to a category.
      settle("Catalog product spend", warnings, paged(graph, `${id}/insights`, {
        level: "ad", time_range: timeRange, breakdowns: "product_id", fields: "ad_id,spend,actions,action_values", limit: 500,
      }, PRODUCT_PAGES)),
    ]);

  const byKey = (rows: Row[] | null, key: string) => new Map((rows ?? []).map((r) => [String(r[key] ?? ""), r]));
  const campaignPerf = byKey(campaignIns, "campaign_id");
  const adSetPerf = byKey(adSetIns, "adset_id");
  const adPerf = byKey(adIns, "ad_id");
  const weekFrequency = byKey(adSetWeek, "adset_id");
  const adWeekFrequency = byKey(adWeek, "ad_id");
  const previousCampaignPerf = byKey(previousCampaignIns, "campaign_id");
  const previousAdSetPerf = byKey(previousAdSetIns, "adset_id");
  // Compare when any part of the comparison window loaded; name the parts that didn't.
  const comparisonFailures = [
    ...(previousTotals == null ? (["totals"] as const) : []),
    ...(previousCampaignIns == null ? (["campaigns"] as const) : []),
    ...(previousAdSetIns == null ? (["ad sets"] as const) : []),
  ];
  const hasPrevious = compare && comparisonFailures.length < 3;

  const auditAdSets: AuditAdSet[] = (adSets ?? []).map((a) => {
    const promoted = (a.promoted_object ?? {}) as Row;
    const targeting = (a.targeting ?? {}) as Row;
    const learning = (a.learning_stage_info ?? {}) as Row;
    const automation = (targeting.targeting_automation ?? {}) as Row;
    const geo = (targeting.geo_locations ?? {}) as Row;
    const attribution = Array.isArray(a.attribution_spec) ? (a.attribution_spec as Row[]) : [];
    const idsOf = (v: unknown) => (Array.isArray(v) ? (v as Row[]).map((x) => String(x.id ?? "")).filter(Boolean) : []);
    return {
      id: String(a.id),
      name: String(a.name ?? a.id),
      campaignId: String(a.campaign_id ?? ""),
      status: String(a.effective_status ?? ""),
      optimizationGoal: str(a.optimization_goal),
      bidStrategy: str(a.bid_strategy),
      dailyBudgetCents: num(a.daily_budget) > 0 ? toCents(a.daily_budget) : null,
      lifetimeBudgetCents: num(a.lifetime_budget) > 0 ? toCents(a.lifetime_budget) : null,
      learningStatus: str(learning.status),
      lastSignificantEdit: num(learning.last_sig_edit_ts) > 0 ? new Date(num(learning.last_sig_edit_ts) * 1000).toISOString() : null,
      pixelId: str(promoted.pixel_id),
      customEventType: str(promoted.custom_event_type),
      customConversionId: str(promoted.custom_conversion_id),
      attributionWindows: attribution
        .filter((s) => s.event_type === "CLICK_THROUGH" || s.event_type === "VIEW_THROUGH")
        .map((s) => `${num(s.window_days)}d_${s.event_type === "CLICK_THROUGH" ? "click" : "view"}`),
      includedAudienceIds: idsOf(targeting.custom_audiences),
      excludedAudienceIds: idsOf(targeting.excluded_custom_audiences),
      advantageAudience: automation.advantage_audience == null ? null : num(automation.advantage_audience) === 1,
      publisherPlatforms: Array.isArray(targeting.publisher_platforms) ? (targeting.publisher_platforms as string[]) : [],
      countries: Array.isArray(geo.countries) ? (geo.countries as string[]) : [],
      frequency7d: weekFrequency.has(String(a.id)) ? num(weekFrequency.get(String(a.id))!.frequency) : null,
      performance: performanceFrom(adSetPerf.get(String(a.id))),
      ...(hasPrevious && previousAdSetIns != null ? { previousPerformance: performanceFrom(previousAdSetPerf.get(String(a.id))) } : {}),
    };
  });

  // Tracking stats only for pixels the ad sets optimise on (plus the most
  // recently fired one) — each pixel costs three stats calls per window.
  const usedPixelIds = new Set(auditAdSets.map((a) => a.pixelId).filter(Boolean) as string[]);
  const pixelRows = pixels ?? [];
  const latest = pixelRows
    .filter((p) => str(p.last_fired_time))
    .sort((a, b) => String(b.last_fired_time).localeCompare(String(a.last_fired_time)))[0];
  if (latest) usedPixelIds.add(String(latest.id));
  const statsFor = [...usedPixelIds].slice(0, 4);
  const stats = await Promise.all(
    statsFor.map(async (pid) => {
      const [s7, s28] = await Promise.all([
        settle(`Pixel ${pid} events (7d)`, warnings, pixelStats(graph, pid, 7)),
        settle(`Pixel ${pid} events (28d)`, warnings, pixelStats(graph, pid, 28)),
      ]);
      return { pid, s7, s28 };
    }),
  );
  const statsById = new Map(stats.map((s) => [s.pid, s]));

  const auditPixels: AuditPixel[] = pixelRows.map((p) => ({
    id: String(p.id),
    name: String(p.name ?? p.id),
    lastFiredTime: str(p.last_fired_time),
    automaticMatching: p.enable_automatic_matching === true,
    stats7d: statsById.get(String(p.id))?.s7 ?? null,
    stats28d: statsById.get(String(p.id))?.s28 ?? null,
  }));
  // Pixels referenced by ad sets but owned by another account still get stats.
  for (const pid of statsFor) {
    if (!auditPixels.some((p) => p.id === pid)) {
      auditPixels.push({
        id: pid,
        name: `Pixel ${pid}`,
        lastFiredTime: null,
        automaticMatching: false,
        stats7d: statsById.get(pid)?.s7 ?? null,
        stats28d: statsById.get(pid)?.s28 ?? null,
      });
    }
  }

  const catalogProducts = catalogProductsFrom(productIns, warnings);
  const statusCode = num(account.account_status);
  const disable = num(account.disable_reason);

  return {
    account: {
      id,
      name: String(account.name ?? id),
      currency,
      timezone: String(account.timezone_name ?? "UTC"),
      statusCode,
      disableReason: disable > 0 ? `Reason ${disable}` : null,
      amountSpentCents: toCents(account.amount_spent),
      spendCapCents: num(account.spend_cap) > 0 ? toCents(account.spend_cap) : null,
    },
    period: { days, since, until },
    totals: performanceFrom(totals?.data?.[0]),
    ...(hasPrevious
      ? {
          previousPeriod,
          ...(comparison.named ? { comparisonNamed: true } : {}),
          ...(comparisonFailures.length ? { comparisonFailures: [...comparisonFailures] } : {}),
          previousTotals: previousTotals ? performanceFrom(previousTotals.data?.[0]) : null,
        }
      : {}),
    ...(compare ? {} : { comparisonNotRequested: true as const }),
    pixels: auditPixels,
    ...(catalogProducts ? { catalogProducts } : {}),
    customConversions: (customConversions ?? []).map((c) => ({
      id: String(c.id),
      name: String(c.name ?? c.id),
      eventType: String(c.custom_event_type ?? "OTHER"),
      lastFiredTime: str(c.last_fired_time),
      archived: c.is_archived === true,
    })),
    audiences: (audiences ?? []).map((a) => {
      const delivery = (a.delivery_status ?? {}) as Row;
      const operation = (a.operation_status ?? {}) as Row;
      const lower = num(a.approximate_count_lower_bound);
      const ready = num(delivery.code) === 200;
      return {
        id: String(a.id),
        name: String(a.name ?? a.id),
        subtype: String(a.subtype ?? "CUSTOM"),
        sizeLower: lower > 0 ? lower : null,
        ready,
        problem: ready
          ? null
          : str(operation.description) && num(operation.code) !== 200
            ? String(operation.description)
            : str(delivery.description),
      };
    }),
    campaigns: (campaigns ?? []).map((c) => ({
      id: String(c.id),
      name: String(c.name ?? c.id),
      objective: String(c.objective ?? ""),
      status: String(c.effective_status ?? ""),
      bidStrategy: str(c.bid_strategy),
      dailyBudgetCents: num(c.daily_budget) > 0 ? toCents(c.daily_budget) : null,
      lifetimeBudgetCents: num(c.lifetime_budget) > 0 ? toCents(c.lifetime_budget) : null,
      advantagePlus: Boolean(str(c.smart_promotion_type) && c.smart_promotion_type !== "GUIDED_CREATION"),
      specialAdCategories: Array.isArray(c.special_ad_categories) ? (c.special_ad_categories as string[]) : [],
      createdTime: str(c.created_time),
      performance: performanceFrom(campaignPerf.get(String(c.id))),
      ...(hasPrevious && previousCampaignIns != null ? { previousPerformance: performanceFrom(previousCampaignPerf.get(String(c.id))) } : {}),
    })),
    adSets: auditAdSets,
    ads: (ads ?? []).map((a) => {
      const creative = (a.creative ?? {}) as Row;
      const issues = Array.isArray(a.issues_info) ? (a.issues_info as Row[]) : [];
      return {
        id: String(a.id),
        name: String(a.name ?? a.id),
        adSetId: String(a.adset_id ?? ""),
        campaignId: String(a.campaign_id ?? ""),
        status: String(a.effective_status ?? ""),
        createdTime: str(a.created_time),
        format: creative.asset_feed_spec
          ? "DYNAMIC"
          : creative.video_id
            ? "VIDEO"
            : str(creative.object_type),
        issue: str(issues[0]?.error_summary),
        performance: performanceFrom(adPerf.get(String(a.id))),
        urlTags: str(creative.url_tags),
        linkUrl: str(creative.link_url) ?? extractCreativeDestination(creative).landing_page_url,
        frequency7d: adWeekFrequency.has(String(a.id)) ? num(adWeekFrequency.get(String(a.id))!.frequency) : null,
        rankings: (() => {
          const row = adPerf.get(String(a.id));
          const rank = (v: unknown) => (str(v) && v !== "UNKNOWN" ? String(v) : null);
          if (!row) return null;
          const r = { quality: rank(row.quality_ranking), engagement: rank(row.engagement_rate_ranking), conversion: rank(row.conversion_rate_ranking) };
          return r.quality || r.engagement || r.conversion ? r : null;
        })(),
      };
    }),
    placements: (placements?.data ?? []).map((p) => {
      const perf = performanceFrom(p);
      return {
        platform: String(p.publisher_platform ?? "unknown"),
        spendCents: major(p.spend),
        results: perf?.results ?? null,
      };
    }),
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Add up period performance across rows. Reach can't be summed (people
 * overlap between campaigns), so a sum of several rows is flagged
 * `reachSummed` and its reach/frequency are not shown.
 */
function sumPerformance(rows: PeriodPerformance[]): PeriodPerformance | null {
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0]!;
  const total = (pick: (p: PeriodPerformance) => number) => rows.reduce((sum, p) => sum + pick(p), 0);
  const spendCents = total((p) => p.spendCents);
  const impressions = total((p) => p.impressions);
  const reach = total((p) => p.reach);
  const counted = rows.filter((p) => p.results != null);
  const results = counted.length ? counted.reduce((sum, p) => sum + p.results!, 0) : null;
  const labels = new Set(counted.map((p) => p.resultLabel));
  // Optional counts: summed when any row has them, left out otherwise.
  const optional = <K extends "linkClicks" | "landingPageViews" | "videoViews3s" | "thruplays">(key: K) => {
    const present = rows.filter((p) => p[key] != null);
    return present.length ? { [key]: present.reduce((sum, p) => sum + (p[key] as number), 0) } : {};
  };
  const withRoas = rows.filter((p) => p.roas != null);
  const roasSpend = withRoas.reduce((sum, p) => sum + p.spendCents, 0);
  return {
    ...optional("linkClicks"),
    ...optional("landingPageViews"),
    ...optional("videoViews3s"),
    ...optional("thruplays"),
    spendCents,
    impressions,
    reach,
    frequency: reach > 0 ? impressions / reach : 0,
    reachSummed: true,
    linkCtr: impressions > 0 ? total((p) => p.linkCtr * p.impressions) / impressions : 0,
    cpmCents: impressions > 0 ? Math.round((spendCents / impressions) * 1000) : null,
    results,
    resultLabel: labels.size === 1 ? [...labels][0]! : labels.size ? "Mixed goals" : "Results",
    costPerResultCents: results && results > 0 ? Math.round(spendCents / results) : null,
    // Spend-weighted, and only when every row reports it.
    roas: withRoas.length === rows.length && roasSpend > 0 ? withRoas.reduce((sum, p) => sum + p.roas! * p.spendCents, 0) / roasSpend : null,
  };
}

/**
 * Narrow an account snapshot to the audited campaigns: their ad sets, ads and
 * totals. Tracking (pixels, conversions, audiences) stays account-wide — the
 * campaigns depend on it. The placement split is account-level only, so it is
 * dropped rather than credited to these campaigns.
 */
export function scopeAuditSnapshot(snap: MetaAuditSnapshot, campaignIds: string[]): MetaAuditSnapshot {
  const ids = new Set(campaignIds);
  const campaigns = snap.campaigns.filter((c) => ids.has(c.id));
  const delivered = (p: PeriodPerformance | null | undefined) => Boolean(p && (p.spendCents > 0 || p.impressions > 0));
  // When the scope holds every campaign that delivered, the account figures
  // are the same totals — with real reach and frequency.
  const coversAccount = (pick: (c: AuditCampaign) => PeriodPerformance | null | undefined) =>
    snap.campaigns.every((c) => ids.has(c.id) || !delivered(pick(c)));
  const totalsOf = (
    pick: (c: AuditCampaign) => PeriodPerformance | null | undefined,
    account: PeriodPerformance | null | undefined,
  ) =>
    account && coversAccount(pick)
      ? account
      : sumPerformance(campaigns.map(pick).filter((p): p is PeriodPerformance => p != null));
  // Scoped totals come from the campaign rows, so they fail with them.
  const comparisonFailures = snap.comparisonFailures?.includes("campaigns")
    ? ([...new Set([...snap.comparisonFailures, "totals" as const])] as MetaAuditSnapshot["comparisonFailures"])
    : snap.comparisonFailures;
  const scopedAdIds = new Set(snap.ads.filter((a) => ids.has(a.campaignId)).map((a) => a.id));
  return {
    ...snap,
    campaigns,
    adSets: snap.adSets.filter((a) => ids.has(a.campaignId)),
    ads: snap.ads.filter((a) => ids.has(a.campaignId)),
    ...(snap.catalogProducts
      ? {
          catalogProducts: snap.catalogProducts.filter((p) => scopedAdIds.has(p.adId)),
        }
      : {}),
    totals: totalsOf((c) => c.performance, snap.totals),
    ...(snap.previousPeriod
      ? {
          previousTotals: snap.comparisonFailures?.includes("campaigns")
            ? null
            : totalsOf((c) => c.previousPerformance, snap.previousTotals),
          ...(comparisonFailures ? { comparisonFailures } : {}),
        }
      : {}),
    placements: [],
    scope: { campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })) },
  };
}

/** The ClickTrends demo Meta account: it gets the ecommerce sample below. */
export const DEMO_CLICKTRENDS_META_ACCOUNT_ID = "act_700800900";

/** Deterministic sample for DEMO_MODE — exercises most checkpoints. */
export function demoMetaAuditSnapshot(
  accountId: string,
  accountName: string,
  daysOrOptions: number | AuditSnapshotOptions = 30,
): MetaAuditSnapshot {
  const options: AuditSnapshotOptions = typeof daysOrOptions === "number" ? { days: daysOrOptions } : daysOrOptions;
  const snap = demoSnapshotWithComparison(accountId, accountName, options);
  return options.compare === false ? withoutComparison(snap) : snap;
}

function demoSnapshotWithComparison(
  accountId: string,
  accountName: string,
  options: AuditSnapshotOptions,
): MetaAuditSnapshot {
  const until = options.until && ISO_DAY.test(options.until) ? options.until : dayString(new Date(Date.now() - 86_400_000));
  const since =
    options.since && ISO_DAY.test(options.since) && options.since <= until
      ? options.since
      : dayString(new Date(Date.parse(`${until}T00:00:00Z`) - ((options.days ?? 30) - 1) * 86_400_000));
  const days = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
  const comparison = comparisonPeriodOf(since, until, options);
  const previousPeriod = { since: comparison.since, until: comparison.until };
  const named = comparison.named ? { comparisonNamed: true } : {};
  const resultLabel = accountId === DEMO_CLICKTRENDS_META_ACCOUNT_ID ? "Purchases" : "Leads";
  const perf = (spend: number, results: number | null, frequency: number, ctr: number, roas: number | null = null): PeriodPerformance => ({
    spendCents: spend,
    impressions: Math.round(spend * 1.6),
    reach: Math.round((spend * 1.6) / Math.max(frequency, 1)),
    frequency,
    linkCtr: ctr,
    cpmCents: 1_150,
    results,
    resultLabel,
    costPerResultCents: results ? Math.round(spend / results) : null,
    roas,
  });
  const recent = new Date(Date.now() - 12 * 86_400_000).toISOString();
  const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const adSet = (
    id: string,
    name: string,
    campaignId: string,
    over: Partial<AuditAdSet>,
  ): AuditAdSet => ({
    id,
    name,
    campaignId,
    status: "ACTIVE",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    dailyBudgetCents: 4_000,
    lifetimeBudgetCents: null,
    learningStatus: "SUCCESS",
    lastSignificantEdit: old,
    pixelId: "demo_pixel_1",
    customEventType: "LEAD",
    customConversionId: null,
    attributionWindows: ["7d_click", "1d_view"],
    includedAudienceIds: [],
    excludedAudienceIds: [],
    advantageAudience: true,
    publisherPlatforms: ["facebook", "instagram"],
    countries: ["AU"],
    frequency7d: null,
    performance: null,
    ...over,
  });

  if (accountId === DEMO_CLICKTRENDS_META_ACCOUNT_ID) {
    // Ecommerce (bar stools and sofas): one Advantage+ sales campaign, one
    // retargeting campaign, ads linking to the category collections.
    const purchase = { customEventType: "PURCHASE", countries: ["US"] };
    return {
      account: {
        id: accountId,
        name: accountName,
        currency: "USD",
        timezone: "America/Los_Angeles",
        statusCode: 1,
        disableReason: null,
        amountSpentCents: 4_120_000,
        spendCapCents: null,
      },
      period: { days, since, until },
      totals: perf(330_000, 40, 2.4, 1.05, 2.55),
      previousPeriod,
      ...named,
      // The previous campaigns' sum: (190,000 × 2.9 + 110,000 × 1.7) ÷ 300,000 = 2.46.
      previousTotals: perf(300_000, 35, 2.3, 1.1, 2.46),
      pixels: [
        {
          id: "demo_ct_pixel",
          name: "ClickTrends store pixel",
          lastFiredTime: new Date().toISOString(),
          automaticMatching: true,
          stats7d: { events: { PageView: 9_800, AddToCart: 410, Purchase: 11 }, serverShare: 0.62, piiShare: { Purchase: 0.88 } },
          stats28d: { events: { PageView: 39_500, AddToCart: 1_640, Purchase: 42 }, serverShare: 0.6, piiShare: { Purchase: 0.86 } },
        },
      ],
      customConversions: [],
      audiences: [
        { id: "aud_ct_customers", name: "Purchasers 180d", subtype: "CUSTOM", sizeLower: 3_100, ready: true, problem: null },
        { id: "aud_ct_web30", name: "Website visitors 30d", subtype: "WEBSITE", sizeLower: 24_000, ready: true, problem: null },
      ],
      campaigns: [
        { id: "ct_campaign_asc", name: "Bar Stools | Advantage+ | Sales", objective: "OUTCOME_SALES", status: "ACTIVE", bidStrategy: null, dailyBudgetCents: 7_000, lifetimeBudgetCents: null, advantagePlus: true, specialAdCategories: [], createdTime: old, performance: perf(210_000, 31, 2.1, 1.12, 3.1), previousPerformance: perf(190_000, 27, 2.0, 1.15, 2.9) },
        { id: "ct_campaign_rt", name: "Sofas | Retargeting | Sales", objective: "OUTCOME_SALES", status: "ACTIVE", bidStrategy: null, dailyBudgetCents: null, lifetimeBudgetCents: null, advantagePlus: false, specialAdCategories: [], createdTime: old, performance: perf(120_000, 9, 4.6, 0.94, 1.6), previousPerformance: perf(110_000, 8, 4.1, 1.0, 1.7) },
      ],
      adSets: [
        adSet("ct_as_asc", "Bar Stools – Advantage+ audience", "ct_campaign_asc", { ...purchase, pixelId: "demo_ct_pixel", dailyBudgetCents: null, frequency7d: 1.6, performance: perf(210_000, 31, 2.1, 1.12, 3.1) }),
        adSet("ct_as_rt", "Sofas – Retargeting – Website visitors 30d", "ct_campaign_rt", { ...purchase, pixelId: "demo_ct_pixel", dailyBudgetCents: 4_000, advantageAudience: false, includedAudienceIds: ["aud_ct_web30"], excludedAudienceIds: ["aud_ct_customers"], frequency7d: 3.8, performance: perf(120_000, 9, 4.6, 0.94, 1.6) }),
      ],
      ads: [
        { id: "ct_ad_asc", name: "Bar Stools | Advantage+ | Sales", adSetId: "ct_as_asc", campaignId: "ct_campaign_asc", status: "ACTIVE", createdTime: recent, format: "VIDEO", issue: null, linkUrl: "https://clicktrends.example/collections/bar-stools", performance: perf(210_000, 31, 2.1, 1.12, 3.1) },
        { id: "ct_ad_rt", name: "Sofas | Retargeting | Sales", adSetId: "ct_as_rt", campaignId: "ct_campaign_rt", status: "ACTIVE", createdTime: old, format: "IMAGE", issue: null, linkUrl: "https://clicktrends.example/collections/sofas", performance: perf(120_000, 9, 4.6, 0.94, 1.6) },
      ],
      placements: [
        { platform: "facebook", spendCents: 196_000, results: 23 },
        { platform: "instagram", spendCents: 134_000, results: 17 },
      ],
      warnings: [],
      fetchedAt: new Date().toISOString(),
      demo: true,
    };
  }

  return {
    account: {
      id: accountId,
      name: accountName,
      currency: "USD",
      timezone: "America/New_York",
      statusCode: 1,
      disableReason: null,
      amountSpentCents: 5_210_000,
      spendCapCents: 6_000_000,
    },
    period: { days, since, until },
    totals: perf(388_000, 92, 2.6, 0.92),
    previousPeriod,
    ...named,
    previousTotals: perf(360_000, 80, 2.4, 0.95),
    pixels: [
      {
        id: "demo_pixel_1",
        name: "Main website pixel",
        lastFiredTime: new Date().toISOString(),
        automaticMatching: false,
        stats7d: { events: { PageView: 4_210, Lead: 22 }, serverShare: 0, piiShare: { Lead: 0.41 } },
        stats28d: { events: { PageView: 16_840, Lead: 97 }, serverShare: 0, piiShare: { Lead: 0.44 } },
      },
      { id: "demo_pixel_2", name: "Old landing page pixel", lastFiredTime: old, automaticMatching: false, stats7d: null, stats28d: null },
    ],
    customConversions: [],
    audiences: [
      { id: "aud_customers", name: "Customer list", subtype: "CUSTOM", sizeLower: 5_400, ready: true, problem: null },
      { id: "aud_web30", name: "Website visitors 30d", subtype: "WEBSITE", sizeLower: 820, ready: true, problem: null },
      { id: "aud_lal", name: "Lookalike (AU, 1%) - Customers", subtype: "LOOKALIKE", sizeLower: 190_000, ready: true, problem: null },
    ],
    campaigns: [
      { id: "demo_campaign_1", name: "Implants | Leads | Broad | Oct", objective: "OUTCOME_LEADS", status: "ACTIVE", bidStrategy: null, dailyBudgetCents: null, lifetimeBudgetCents: null, advantagePlus: false, specialAdCategories: [], createdTime: old, performance: perf(178_000, 49, 2.2, 1.02), previousPerformance: perf(150_000, 40, 2.0, 1.05) },
      { id: "demo_campaign_2", name: "Veneers Advantage+", objective: "OUTCOME_LEADS", status: "ACTIVE", bidStrategy: "COST_CAP", dailyBudgetCents: 7_000, lifetimeBudgetCents: null, advantagePlus: true, specialAdCategories: [], createdTime: old, performance: perf(134_000, 29, 4.4, 0.61), previousPerformance: perf(120_000, 30, 3.8, 0.7) },
      { id: "demo_campaign_3", name: "Brand | Retargeting | Visitors", objective: "OUTCOME_LEADS", status: "ACTIVE", bidStrategy: null, dailyBudgetCents: null, lifetimeBudgetCents: null, advantagePlus: false, specialAdCategories: [], createdTime: old, performance: perf(76_000, 14, 5.1, 0.88), previousPerformance: perf(90_000, 10, 4.6, 0.95) },
    ],
    adSets: [
      adSet("as_1", "Implants – Broad AU 30-65", "demo_campaign_1", { performance: perf(118_000, 38, 2.1, 1.1), previousPerformance: perf(150_000, 40, 2.0, 1.05) }),
      adSet("as_2", "Implants – Interests: dental", "demo_campaign_1", { includedAudienceIds: ["aud_lal"], learningStatus: "FAIL", dailyBudgetCents: 2_000, performance: perf(60_000, 11, 2.4, 0.9), previousPerformance: null }),
      adSet("as_3", "Veneers – Advantage+ audience", "demo_campaign_2", { dailyBudgetCents: null, bidStrategy: "COST_CAP", attributionWindows: ["7d_click"], publisherPlatforms: ["instagram"], frequency7d: 3.9, performance: perf(134_000, 29, 4.4, 0.61) }),
      adSet("as_4", "Retargeting – Website visitors 30d", "demo_campaign_3", { includedAudienceIds: ["aud_web30"], frequency7d: 4.2, performance: perf(76_000, 14, 5.1, 0.88) }),
    ],
    ads: [
      { id: "ad_1", name: "Implants – Before/After video", adSetId: "as_1", campaignId: "demo_campaign_1", status: "ACTIVE", createdTime: recent, format: "VIDEO", issue: null, performance: perf(70_000, 24, 2.0, 1.2) },
      { id: "ad_2", name: "Implants – Doctor intro", adSetId: "as_1", campaignId: "demo_campaign_1", status: "ACTIVE", createdTime: old, format: "VIDEO", issue: null, performance: perf(48_000, 14, 2.3, 0.95) },
      { id: "ad_3", name: "Interests – Static offer", adSetId: "as_2", campaignId: "demo_campaign_1", status: "ACTIVE", createdTime: old, format: "VIDEO", issue: null, performance: perf(60_000, 11, 2.4, 0.9) },
      { id: "ad_4", name: "Veneers – Smile reveal", adSetId: "as_3", campaignId: "demo_campaign_2", status: "ACTIVE", createdTime: old, format: "VIDEO", issue: null, performance: perf(134_000, 29, 4.4, 0.61) },
      { id: "ad_5", name: "Veneers – Price claim", adSetId: "as_3", campaignId: "demo_campaign_2", status: "DISAPPROVED", createdTime: recent, format: "VIDEO", issue: "Misleading claims about pricing", performance: null },
      { id: "ad_6", name: "Retargeting – Testimonial", adSetId: "as_4", campaignId: "demo_campaign_3", status: "ACTIVE", createdTime: old, format: "VIDEO", issue: null, performance: perf(76_000, 14, 5.1, 0.88) },
    ],
    placements: [
      { platform: "facebook", spendCents: 241_000, results: 61 },
      { platform: "instagram", spendCents: 147_000, results: 31 },
    ],
    warnings: [],
    fetchedAt: new Date().toISOString(),
    demo: true,
  };
}
