import type {
  CreateAdInput,
  CreateAdSetInput,
  CreateCampaignInput,
  CreateImageCampaignInput,
  CreateVideoCampaignInput,
  MetaAd,
  MetaAdCreative,
  MetaAdSet,
  MetaAdsProvider,
  MetaCampaign,
  MetaInsights,
  MetaInsightsQuery,
  MetaInsightsReport,
  UpdateAdSetBudgetInput,
  UpdateCampaignBudgetInput,
  TextOptions,
  AdPreviewInput,
  AdPreview,
} from "@/lib/adspirer/provider";
import { MetaGraphClient } from "@/lib/meta/graph-client";
import { compactInsightsRow, insightsParams } from "@/lib/meta/insights-report";
import { fetchMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type {
  MetaCustomAudience,
  MetaTargetingOption,
} from "@/lib/adspirer/targeting";
import {
  buildMetaTargeting,
  buildPromotedObject,
  destinationTypeFor,
  reconcileGoalWithBid,
  optimizationForObjective,
} from "@/lib/meta/targeting-builder";
import { resolvePromotePageId, formatMissingPageHelp } from "@/lib/meta/resolve-page";
import { logger } from "@/lib/observability/logger";
import { centsToMetaMinor, metaMinorToCents } from "@/lib/meta/currency";
import { ATTRIBUTION_SPEC, BID_STRATEGIES, DEFAULT_URL_TAGS } from "@/lib/meta/conventions";
import { ExecutionVerificationError } from "@/lib/errors";
import { assessFatigue } from "@/lib/creative/fatigue";
import {
  PartialCreateError,
  type CreateProgress,
} from "@/lib/meta/create-progress";
import {
  normalizeCallToAction,
  resolveLeadFormId,
} from "@/lib/meta/targeting-builder";
import {
  assertFutureEndTime,
  optionalText,
  positiveMinor,
  positiveNumber,
} from "@/lib/meta/mutation-guards";

export {
  centsToMetaMinor,
  metaCurrencyOffset,
  metaMinorToCents,
} from "@/lib/meta/currency";

function normalizeAccountId(accountId: string): string {
  return accountId.startsWith("act_") ? accountId : `act_${accountId}`;
}

/** Meta v25+ dropped `approximate_count`; use lower/upper bounds instead. */
function audienceApproximateCount(row: Record<string, unknown>): number | null {
  const lower =
    typeof row.approximate_count_lower_bound === "number"
      ? row.approximate_count_lower_bound
      : null;
  const upper =
    typeof row.approximate_count_upper_bound === "number"
      ? row.approximate_count_upper_bound
      : null;
  if (lower != null && lower >= 0) {
    if (upper != null && upper >= 0) {
      return Math.round((lower + upper) / 2);
    }
    return lower;
  }
  if (typeof row.approximate_count === "number" && row.approximate_count >= 0) {
    return row.approximate_count;
  }
  return null;
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function budgetToMinorUnits(budgetDaily?: number): number | undefined {
  if (typeof budgetDaily !== "number" || !Number.isFinite(budgetDaily)) {
    return undefined;
  }
  return Math.round(budgetDaily * 100);
}

function lookbackWindow(days: number): { dateStart: string; dateStop: string } {
  const stop = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - Math.max(1, days));
  return {
    dateStart: start.toISOString().slice(0, 10),
    dateStop: stop.toISOString().slice(0, 10),
  };
}

/** Pixel + event an ad set optimises for, from its promoted_object. */
function promotedConversion(value: unknown): { pixel_id?: string; custom_event_type?: string } {
  if (!value || typeof value !== "object") return {};
  const promoted = value as { pixel_id?: unknown; custom_event_type?: unknown };
  return {
    ...(typeof promoted.pixel_id === "string" && promoted.pixel_id ? { pixel_id: promoted.pixel_id } : {}),
    ...(typeof promoted.custom_event_type === "string" && promoted.custom_event_type
      ? { custom_event_type: promoted.custom_event_type }
      : {}),
  };
}

/**
 * Meta's own "Results" for the row's optimisation event (as Ads Manager shows
 * them); null when the row has no `results` field or mixes goals.
 */
function metaResultCount(row: Record<string, unknown>): number | null {
  const results = Array.isArray(row.results)
    ? (row.results as Array<{ indicator?: string; values?: Array<{ value?: string }> }>)
    : null;
  const first = results?.[0];
  if (!first?.indicator || first.indicator === "mixed") return null;
  const n = Number(first.values?.[0]?.value ?? 0);
  return Number.isFinite(n) ? n : null;
}

function extractConversionMetrics(row: Record<string, unknown>): {
  conversions: number;
  cpa: number | null;
} {
  const actions = Array.isArray(row.actions)
    ? (row.actions as Array<{ action_type?: string; value?: string }>)
    : [];
  const purchase =
    actions.find((a) =>
      /purchase|omni_purchase/i.test(String(a.action_type ?? "")),
    ) ??
    // Not the generic `offsite_conversion` prefix: it also matches ViewContent.
    actions.find((a) =>
      /lead|complete_registration/i.test(String(a.action_type ?? "")),
    );
  const conversions =
    purchase?.value != null ? Number(purchase.value) : 0;
  const cpaRows = Array.isArray(row.cost_per_action_type)
    ? (row.cost_per_action_type as Array<{
        action_type?: string;
        value?: string;
      }>)
    : [];
  const cpaMatch = purchase
    ? cpaRows.find((r) => r.action_type === purchase.action_type)
    : undefined;
  const cpa =
    cpaMatch?.value != null
      ? Number(cpaMatch.value)
      : conversions > 0 && Number(row.spend ?? 0) > 0
        ? Number(row.spend) / conversions
        : null;
  return {
    conversions: Number.isFinite(conversions) ? conversions : 0,
    cpa: cpa != null && Number.isFinite(cpa) ? cpa : null,
  };
}

function mergeCampaignExtra(
  input: CreateImageCampaignInput | CreateVideoCampaignInput,
): Record<string, unknown> {
  return {
    ...(input.extra_args ?? {}),
    ...(input.publisher_platforms
      ? { publisher_platforms: input.publisher_platforms }
      : {}),
    ...(input.facebook_page_id
      ? { facebook_page_id: input.facebook_page_id }
      : {}),
    ...(input.pixel_id ? { pixel_id: input.pixel_id } : {}),
    ...(input.pixel_event_name
      ? { pixel_event_name: input.pixel_event_name }
      : {}),
  };
}

/** object_story_spec for an image or video ad (also what previews render). */
function buildStorySpec(
  input: AdPreviewInput,
  o: { pageId: string; videoId?: string; ctaType: string; leadFormId?: string; isVideo: boolean },
): Record<string, unknown> {
  const ctaValue: Record<string, string> = { link: input.landing_page_url };
  if (o.leadFormId) ctaValue.lead_gen_form_id = o.leadFormId;
  const callToAction = { type: o.ctaType, value: ctaValue };
  const storySpec: Record<string, unknown> = {
    page_id: o.pageId,
    // v22+: instagram_actor_id was replaced by instagram_user_id.
    ...(input.instagram_account_id ? { instagram_user_id: input.instagram_account_id } : {}),
  };
  if (o.isVideo) {
    storySpec.video_data = {
      video_id: o.videoId,
      message: input.primary_text,
      ...(input.headline ? { title: input.headline } : {}),
      ...(input.description ? { link_description: input.description } : {}),
      ...(input.thumbnail_url ? { image_url: input.thumbnail_url } : {}),
      call_to_action: callToAction,
    };
  } else {
    storySpec.link_data = {
      link: input.landing_page_url,
      message: input.primary_text,
      ...(input.headline ? { name: input.headline } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.display_link ? { caption: input.display_link } : {}),
      // link_data takes `picture` (a URL) or `image_hash` — never image_url.
      ...(input.existing_image_hash
        ? { image_hash: input.existing_image_hash }
        : input.image_url
          ? { picture: input.image_url }
          : {}),
      call_to_action: callToAction,
    };
  }
  return storySpec;
}

/** The preview frame's URL, only when it is Meta's own (https facebook.com). */
function previewFrameSrc(body: string | undefined): string | null {
  const raw = body ? /src="([^"]+)"/i.exec(body)?.[1] : undefined;
  if (!raw) return null;
  try {
    const url = new URL(raw.replace(/&amp;/g, "&"));
    return url.protocol === "https:" && /^(www|business|m)\.facebook\.com$/.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];

function textOptionsFrom(extra: Record<string, unknown> | undefined): TextOptions | undefined {
  if (!extra) return undefined;
  const options = {
    primary_texts: strings(extra.primary_texts),
    headlines: strings(extra.headlines),
    descriptions: strings(extra.descriptions),
  };
  return options.primary_texts.length || options.headlines.length || options.descriptions.length ? options : undefined;
}

/**
 * Multiple text options: Meta rotates the primary texts, headlines and
 * descriptions (the ad's own first) and shows each person the best one.
 */
function textOptionsFeed(input: CreateAdInput): Record<string, unknown> | null {
  const o = input.text_options;
  if (!o) return null;
  const list = (first: string | undefined, more: string[] | undefined) =>
    [...new Set([first, ...(more ?? [])].filter((t): t is string => Boolean(t?.trim())))].slice(0, 5).map((text) => ({ text }));
  const feed: Record<string, unknown> = {};
  if (o.primary_texts?.length) feed.bodies = list(input.primary_text, o.primary_texts);
  if (o.headlines?.length) feed.titles = list(input.headline, o.headlines);
  if (o.descriptions?.length) feed.descriptions = list(input.description, o.descriptions);
  if (!Object.keys(feed).length) return null;
  feed.optimization_type = "DEGREES_OF_FREEDOM";
  return feed;
}

type ExtraAd = {
  primary_text?: string;
  headline?: string;
  landing_page_url?: string;
  image_url?: string;
  existing_image_hash?: string;
  video_url?: string;
  existing_video_id?: string;
  thumbnail_url?: string;
  name?: string;
};

function extraAdsFrom(extra: Record<string, unknown> | undefined): ExtraAd[] {
  const raw = extra?.extra_ads;
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).map((a) => {
    const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const pick = (k: string) => optionalText(o[k]);
    return {
      primary_text: pick("primary_text"),
      headline: pick("headline"),
      landing_page_url: pick("landing_page_url"),
      image_url: pick("image_url"),
      existing_image_hash: pick("existing_image_hash"),
      video_url: pick("video_url"),
      existing_video_id: pick("existing_video_id"),
      thumbnail_url: pick("thumbnail_url"),
      name: pick("name"),
    };
  });
}

/**
 * Bid strategy for a new campaign/ad set, validated before any POST. Under a
 * campaign budget the strategy sits on the campaign; the cap or ROAS floor
 * always sits on the ad set. A minimum-ROAS bid optimises for purchase value.
 */
function bidPlan(
  extra: Record<string, unknown>,
  objective: string | undefined,
  currency: string,
): { strategy: string; adset: Record<string, string>; valueGoal: boolean } {
  const strategy = (optionalText(extra.bid_strategy) ?? "LOWEST_COST_WITHOUT_CAP").toUpperCase();
  if (!(BID_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new Error(`Unknown bid_strategy "${strategy}" — use one of ${BID_STRATEGIES.join(", ")}. Nothing was created.`);
  }
  const adset: Record<string, string> = {};
  if (strategy === "COST_CAP" || strategy === "LOWEST_COST_WITH_BID_CAP") {
    const amount = positiveNumber(extra.bid_amount);
    if (amount == null) {
      throw new Error(
        `${strategy === "COST_CAP" ? "A cost cap" : "A bid cap"} needs bid_amount (major units, e.g. 30 for 30 per result). Nothing was created.`,
      );
    }
    adset.bid_amount = String(centsToMetaMinor(Math.round(amount * 100), currency));
  }
  if (strategy === "LOWEST_COST_WITH_MIN_ROAS") {
    if ((objective ?? "").toUpperCase() !== "OUTCOME_SALES") {
      throw new Error("A minimum ROAS bid only works for Sales campaigns that optimise for purchase value. Nothing was created.");
    }
    const floor = positiveNumber(extra.roas_average_floor);
    if (floor == null) {
      throw new Error("A minimum ROAS bid needs roas_average_floor (e.g. 2.5 for 2.5×). Nothing was created.");
    }
    adset.bid_constraints = JSON.stringify({ roas_average_floor: Math.round(floor * 10_000) });
  }
  return { strategy, adset, valueGoal: strategy === "LOWEST_COST_WITH_MIN_ROAS" };
}

export class MetaGraphProviderV2 implements MetaAdsProvider {
  readonly name = "MetaGraphProviderV2";
  private readonly graph: MetaGraphClient;

  /** Per-request caches: a provider instance lives for one API call / turn. */
  private readonly currencyByAccount = new Map<string, Promise<string>>();
  private readonly campaignsByAccount = new Map<string, Promise<MetaCampaign[]>>();
  private readonly overviewByAccount = new Map<
    string,
    ReturnType<MetaGraphProviderV2["fetchAccountOverview"]>
  >();

  constructor(accessToken: string) {
    this.graph = new MetaGraphClient(accessToken);
  }

  /** Account currency (cached); budgets are converted with its offset. */
  async accountCurrency(accountId: string): Promise<string> {
    const id = normalizeAccountId(accountId);
    let pending = this.currencyByAccount.get(id);
    if (!pending) {
      pending = this.graph
        .get<{ currency?: string }>(id, { fields: "currency" })
        .then((row) => String(row.currency ?? "USD"))
        .catch(() => "USD");
      this.currencyByAccount.set(id, pending);
    }
    return pending;
  }

  private invalidateCampaigns(accountId: string): void {
    this.campaignsByAccount.delete(normalizeAccountId(accountId));
  }

  private async resolveFacebookPageId(
    accountId: string,
    explicit?: string,
  ): Promise<string> {
    if (explicit?.trim()) return explicit.trim();
    const pageId = await resolvePromotePageId(this.graph, accountId);
    if (pageId) return pageId;
    throw new Error(formatMissingPageHelp(accountId));
  }

  private async uploadVideoFromUrl(
    accountId: string,
    videoUrl: string,
  ): Promise<string> {
    const res = await this.graph.post<{ id: string }>(
      `${normalizeAccountId(accountId)}/advideos`,
      { file_url: videoUrl },
    );
    const id = String(res.id ?? "");
    if (!id) {
      throw new Error(
        "Meta did not return a video ID after uploading video_url. Check the URL is public HTTPS (MP4/MOV) and try again.",
      );
    }
    return id;
  }

  private rethrowStep(step: string, error: unknown): never {
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    throw new Error(`${step}: ${message}`);
  }

  async listCampaigns(accountId: string): Promise<MetaCampaign[]> {
    const id = normalizeAccountId(accountId);
    // The overview and the audit both list campaigns; share one fetch.
    let pending = this.campaignsByAccount.get(id);
    if (!pending) {
      pending = this.fetchCampaigns(id);
      this.campaignsByAccount.set(id, pending);
      pending.catch(() => this.campaignsByAccount.delete(id));
    }
    return pending;
  }

  private async fetchCampaigns(id: string): Promise<MetaCampaign[]> {
    const currencyPromise = this.accountCurrency(id);
    const rows: Array<Record<string, unknown>> = [];
    let after: string | undefined;

    for (let page = 0; page < 20; page++) {
      const data = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
        paging?: { cursors?: { after?: string } };
      }>(`${id}/campaigns`, {
        fields:
          "id,name,status,objective,daily_budget,lifetime_budget,updated_time,created_time",
        limit: 100,
        ...(after ? { after } : {}),
      });

      rows.push(...(data.data ?? []));
      after = data.paging?.cursors?.after;
      if (!after || !(data.data?.length)) break;
    }

    const currency = await currencyPromise;
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      account_id: id,
      name: String(row.name ?? "Campaign"),
      status: String(row.status ?? "PAUSED") as MetaCampaign["status"],
      objective: String(row.objective ?? "OUTCOME_TRAFFIC"),
      daily_budget_cents:
        row.daily_budget != null
          ? metaMinorToCents(Number(row.daily_budget), currency)
          : undefined,
      lifetime_budget_cents:
        row.lifetime_budget != null
          ? metaMinorToCents(Number(row.lifetime_budget), currency)
          : undefined,
      created_time:
        typeof row.created_time === "string" ? row.created_time : undefined,
      updated_time:
        typeof row.updated_time === "string" ? row.updated_time : undefined,
    }));
  }

  async getCampaignInsights(
    accountId: string,
    campaignId: string,
    dateStart: string,
    dateStop: string,
  ): Promise<MetaInsights> {
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      `${campaignId}/insights`,
      {
        fields:
          "spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type,results",
        time_range: JSON.stringify({ since: dateStart, until: dateStop }),
        level: "campaign",
      },
    );
    const first = data.data?.[0] ?? {};
    return this.mapInsightsRow(accountId, campaignId, "campaign", dateStart, dateStop, first);
  }

  async getAccountInsights(
    accountId: string,
    dateStart: string,
    dateStop: string,
  ): Promise<MetaInsights> {
    const id = normalizeAccountId(accountId);
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      `${id}/insights`,
      {
        fields:
          "spend,impressions,clicks,ctr,cpc,reach,frequency,actions,cost_per_action_type",
        time_range: JSON.stringify({ since: dateStart, until: dateStop }),
        level: "account",
      },
    );
    const first = data.data?.[0] ?? {};
    return this.mapInsightsRow(id, id, "account", dateStart, dateStop, first);
  }

  async getInsightsReport(accountId: string, query: MetaInsightsQuery): Promise<MetaInsightsReport> {
    const id = normalizeAccountId(accountId);
    const currencyPromise = this.accountCurrency(id);
    const rows: Array<Record<string, unknown>> = [];
    let after: string | undefined;
    let hasMore = false;
    // Up to 5 pages of at most 100 rows: the tool's limit is 500.
    for (let page = 0; page < 5; page++) {
      const data = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>(`${id}/insights`, {
        ...insightsParams(query, Math.min(100, query.limit)),
        ...(after ? { after } : {}),
      });
      rows.push(...(data.data ?? []));
      after = data.paging?.next ? data.paging.cursors?.after : undefined;
      if (rows.length >= query.limit) {
        hasMore = rows.length > query.limit || Boolean(after);
        break;
      }
      if (!after || !data.data?.length) break;
      hasMore = page === 4;
    }
    return {
      currency: await currencyPromise,
      rows: rows.slice(0, query.limit).map(compactInsightsRow),
      has_more: hasMore,
    };
  }

  private mapInsightsRow(
    accountId: string,
    entityId: string,
    entityType: MetaInsights["entity_type"],
    dateStart: string,
    dateStop: string,
    first: Record<string, unknown>,
  ): MetaInsights {
    const actions = Array.isArray(first.actions)
      ? (first.actions as Array<{ action_type?: string; value?: string }>)
      : [];
    // Meta's own result count when the row has one; otherwise the action-name
    // guess, which never matches the generic `offsite_conversion` (ViewContent).
    const counted = metaResultCount(first);
    const purchase =
      actions.find((a) => /purchase|omni_purchase/i.test(String(a.action_type))) ??
      actions.find((a) => /lead|complete_registration/i.test(String(a.action_type)));
    const conversions =
      counted ?? (purchase?.value != null ? Number(purchase.value) : undefined);
    const cpaRows = Array.isArray(first.cost_per_action_type)
      ? (first.cost_per_action_type as Array<{ action_type?: string; value?: string }>)
      : [];
    const cpaMatch = purchase
      ? cpaRows.find((r) => r.action_type === purchase.action_type)
      : undefined;

    return {
      account_id: normalizeAccountId(accountId),
      entity_id: entityId,
      entity_type: entityType,
      date_start: dateStart,
      date_stop: dateStop,
      spend: Number(first.spend ?? 0),
      impressions: Number(first.impressions ?? 0),
      clicks: Number(first.clicks ?? 0),
      ctr: Number(first.ctr ?? 0),
      cpc: Number(first.cpc ?? 0),
      reach: Number(first.reach ?? 0),
      frequency: Number(first.frequency ?? 0),
      conversions,
      cost_per_conversion:
        counted != null
          ? counted > 0
            ? Number(first.spend ?? 0) / counted
            : undefined
          : cpaMatch?.value != null
            ? Number(cpaMatch.value)
            : undefined,
      raw: first,
    };
  }

  async listAdSets(accountId: string, campaignId?: string): Promise<MetaAdSet[]> {
    const path = campaignId
      ? `${campaignId}/adsets`
      : `${normalizeAccountId(accountId)}/adsets`;
    const currencyPromise = this.accountCurrency(accountId);
    // Follow paging — accounts with >100 ad sets were silently truncated.
    const rows: Array<Record<string, unknown>> = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const data = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
        paging?: { cursors?: { after?: string }; next?: string };
      }>(path, {
        fields:
          "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,targeting,promoted_object",
        limit: 100,
        ...(after ? { after } : {}),
      });
      rows.push(...(data.data ?? []));
      after = data.paging?.next ? data.paging?.cursors?.after : undefined;
      if (!after) break;
    }
    const currency = await currencyPromise;
    return rows.map((row) => ({
      id: String(row.id ?? ""),
      campaign_id: String(row.campaign_id ?? campaignId ?? ""),
      account_id: normalizeAccountId(accountId),
      name: String(row.name ?? "Ad Set"),
      status: String(row.status ?? "PAUSED") as MetaAdSet["status"],
      effective_status:
        typeof row.effective_status === "string" ? row.effective_status : undefined,
      daily_budget_cents: metaMinorToCents(Number(row.daily_budget ?? 0), currency),
      lifetime_budget_cents:
        Number(row.lifetime_budget ?? 0) > 0
          ? metaMinorToCents(Number(row.lifetime_budget), currency)
          : undefined,
      optimization_goal:
        typeof row.optimization_goal === "string"
          ? row.optimization_goal
          : undefined,
      billing_event:
        typeof row.billing_event === "string" ? row.billing_event : undefined,
      targeting_summary:
        row.targeting && typeof row.targeting === "object"
          ? JSON.stringify(row.targeting)
          : undefined,
      ...promotedConversion(row.promoted_object),
    }));
  }

  /** `parentId` may be an ad set or a campaign — both expose an `/ads` edge. */
  async listAds(accountId: string, adSetId?: string): Promise<MetaAd[]> {
    const path = adSetId
      ? `${adSetId}/ads`
      : `${normalizeAccountId(accountId)}/ads`;
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      path,
      {
        fields: "id,name,status,effective_status,adset_id,campaign_id,creative",
        limit: 100,
      },
    );
    return (data.data ?? []).map((row) => ({
      id: String(row.id ?? ""),
      adset_id: String(row.adset_id ?? adSetId ?? ""),
      campaign_id: String(row.campaign_id ?? ""),
      account_id: normalizeAccountId(accountId),
      name: String(row.name ?? "Ad"),
      status: String(row.status ?? "PAUSED") as MetaAd["status"],
      effective_status:
        typeof row.effective_status === "string" ? row.effective_status : undefined,
      creative_summary: row.creative ? "Meta creative attached" : undefined,
    }));
  }

  async analyzeAccount(accountId: string) {
    const overview = await this.getAccountOverview(accountId);
    return {
      overview,
      findings: [
        `Account currency: ${overview.currency}`,
        `Total campaigns: ${overview.total_campaigns ?? overview.active_campaigns + overview.paused_campaigns}`,
        `Active campaigns: ${overview.active_campaigns}`,
        `Paused campaigns: ${overview.paused_campaigns}`,
      ],
      // Only evidence-based recommendations belong here; canned advice was
      // being presented to operators as if it came from their data.
      recommended_actions: [] as string[],
    };
  }

  /** Overview (cached per turn): the agent and analyzeAccount share one fetch. */
  async getAuditSnapshot(
    accountId: string,
    options?: { days?: number; since?: string; until?: string; compare?: boolean; compareSince?: string; compareUntil?: string },
  ) {
    return fetchMetaAuditSnapshot(this.graph, normalizeAccountId(accountId), options);
  }

  async getAccountOverview(accountId: string) {
    const id = normalizeAccountId(accountId);
    let pending = this.overviewByAccount.get(id);
    if (!pending) {
      pending = this.fetchAccountOverview(id);
      this.overviewByAccount.set(id, pending);
      pending.catch(() => this.overviewByAccount.delete(id));
    }
    return pending;
  }

  private async fetchAccountOverview(id: string) {
    const [account, campaigns] = await Promise.all([
      this.graph.get<Record<string, unknown>>(id, {
        fields: "id,name,currency,timezone_name",
      }),
      this.listCampaigns(id).catch(() => [] as MetaCampaign[]),
    ]);
    if (typeof account.currency === "string" && !this.currencyByAccount.has(id)) {
      this.currencyByAccount.set(id, Promise.resolve(account.currency));
    }
    const active = campaigns.filter((c) => c.status === "ACTIVE").length;
    const paused = campaigns.filter((c) => c.status === "PAUSED").length;
    const archived = campaigns.filter((c) => c.status === "ARCHIVED").length;
    return {
      account_id: id,
      account_name: String(account.name ?? id),
      currency: String(account.currency ?? "USD"),
      timezone: String(account.timezone_name ?? "UTC"),
      spend_7d: 0,
      spend_30d: 0,
      active_campaigns: active,
      paused_campaigns: paused,
      total_campaigns: campaigns.length,
      archived_campaigns: archived,
      health: "healthy" as const,
      notes: [] as string[],
    };
  }

  // ---------------------------------------------------------------------------
  // Mutations. Every write validates up front, fails closed on anything it
  // cannot confirm (currency, owning account, CBO), and reads the result back.
  // ---------------------------------------------------------------------------

  /** Write-path currency cache: unlike accountCurrency() this never guesses. */
  private readonly writeCurrencyByAccount = new Map<string, Promise<string>>();

  /**
   * Account currency for budget writes. A failed lookup throws: guessing USD
   * for a JPY/KRW account would send a budget 100× too large.
   */
  async requireAccountCurrency(accountId: string): Promise<string> {
    const id = normalizeAccountId(accountId);
    let pending = this.writeCurrencyByAccount.get(id);
    if (!pending) {
      pending = this.graph
        .get<{ currency?: unknown }>(id, { fields: "currency" })
        .then((row) => {
          const currency =
            typeof row.currency === "string"
              ? row.currency.trim().toUpperCase()
              : "";
          if (!/^[A-Z]{3}$/.test(currency)) {
            throw new Error("Meta returned no currency for the account");
          }
          return currency;
        })
        .catch((error: unknown) => {
          this.writeCurrencyByAccount.delete(id);
          const reason =
            error instanceof Error ? error.message : String(error ?? "unknown");
          throw new Error(
            `Could not read the currency of ad account ${id} (${reason}). Nothing was sent to Meta — budgets are never sent with a guessed currency, because a wrong guess changes the amount up to 100×.`,
          );
        });
      this.writeCurrencyByAccount.set(id, pending);
    }
    return pending;
  }

  /** App cents → Meta minor units as the string Graph expects; rejects 0. */
  private budgetMinor(cents: number, currency: string, label: string): string {
    const minor = centsToMetaMinor(cents, currency);
    if (!Number.isFinite(minor) || minor <= 0) {
      throw new Error(
        `${label} ${formatMoney(cents, currency)} is too small to send to Meta.`,
      );
    }
    return String(minor);
  }

  /** Confirm `entityId` lives in `accountId` before touching it. */
  private async assertEntityInAccount(
    entityId: string,
    accountId: string,
    label: string,
  ): Promise<void> {
    const row = await this.graph.get<{ account_id?: unknown }>(entityId, {
      fields: "account_id",
    });
    const actual =
      row.account_id != null && String(row.account_id).trim()
        ? normalizeAccountId(String(row.account_id).trim())
        : null;
    if (!actual) {
      throw new Error(
        `Could not confirm which ad account ${label} ${entityId} belongs to. Nothing was changed.`,
      );
    }
    if (actual !== normalizeAccountId(accountId)) {
      throw new Error(
        `${label} ${entityId} belongs to ad account ${actual}, not ${normalizeAccountId(accountId)}. Nothing was changed.`,
      );
    }
  }

  async updateAdSetBudget(input: UpdateAdSetBudgetInput): Promise<
    MetaAdSet & {
      currency: string;
      previous_daily_budget_cents: number | null;
      effective_status?: string;
      verified: boolean;
      verification_error?: string;
    }
  > {
    const adset = await this.graph.get<{
      id?: string;
      name?: string;
      status?: string;
      account_id?: unknown;
      campaign_id?: string;
      daily_budget?: string;
      lifetime_budget?: string;
      campaign?: {
        id?: string;
        name?: string;
        daily_budget?: string;
        lifetime_budget?: string;
        bid_strategy?: string;
      };
    }>(input.adset_id, {
      fields:
        "id,name,status,account_id,campaign_id,daily_budget,lifetime_budget,campaign{id,name,daily_budget,lifetime_budget,bid_strategy}",
    });
    const name = adset.name ?? input.adset_id;

    // The account comes from the ad set itself, never from the proposal.
    const accountId =
      adset.account_id != null && String(adset.account_id).trim()
        ? normalizeAccountId(String(adset.account_id).trim())
        : null;
    if (!accountId) {
      throw new Error(
        `Could not confirm which ad account ad set ${input.adset_id} belongs to. Nothing was changed.`,
      );
    }
    if (input.account_id && normalizeAccountId(input.account_id) !== accountId) {
      throw new Error(
        `Ad set "${name}" belongs to ad account ${accountId}, not ${normalizeAccountId(input.account_id)}. Nothing was changed.`,
      );
    }

    const campaign = adset.campaign ?? {};
    if (positiveMinor(campaign.daily_budget) || positiveMinor(campaign.lifetime_budget)) {
      throw new Error(
        `Ad set "${name}" is in campaign "${campaign.name ?? campaign.id ?? adset.campaign_id}", which uses a campaign budget (Advantage+ campaign budget / CBO). Its budget is set on the campaign, so the ad set daily budget can't be changed. Nothing was changed.`,
      );
    }
    if (positiveMinor(adset.lifetime_budget)) {
      throw new Error(
        `Ad set "${name}" uses a lifetime budget, not a daily budget — change it in Ads Manager. Nothing was changed.`,
      );
    }

    const currency = await this.requireAccountCurrency(accountId);
    const requestedMinor = this.budgetMinor(
      input.daily_budget_cents,
      currency,
      "Daily budget",
    );
    const previousCents = positiveMinor(adset.daily_budget)
      ? metaMinorToCents(Number(adset.daily_budget), currency)
      : null;

    await this.graph.post(input.adset_id, { daily_budget: requestedMinor });

    const base = {
      id: input.adset_id,
      campaign_id: String(adset.campaign_id ?? campaign.id ?? ""),
      account_id: accountId,
      name,
      status: String(adset.status ?? "PAUSED") as MetaAdSet["status"],
      currency,
      previous_daily_budget_cents: previousCents,
    };

    // Read back: the change succeeded on Meta, so a failed re-read is
    // reported as unverified (never as a failure that invites a retry).
    let after: { daily_budget?: string; status?: string; effective_status?: string };
    try {
      after = await this.graph.get(input.adset_id, {
        fields: "daily_budget,lifetime_budget,status,effective_status",
      });
    } catch (error) {
      return {
        ...base,
        daily_budget_cents: input.daily_budget_cents,
        verified: false,
        verification_error:
          error instanceof Error ? error.message : "Read-back failed",
      };
    }
    const actualMinor = Number(after.daily_budget);
    if (!Number.isFinite(actualMinor) || String(actualMinor) !== requestedMinor) {
      const shown = Number.isFinite(actualMinor)
        ? formatMoney(metaMinorToCents(actualMinor, currency), currency)
        : "no daily budget";
      throw new ExecutionVerificationError(
        `Meta accepted the budget update for "${name}", but reading it back shows ${shown} instead of ${formatMoney(input.daily_budget_cents, currency)}. Check the ad set in Ads Manager before trying again.`,
        { adset_id: input.adset_id, requested_minor: requestedMinor, actual_minor: after.daily_budget ?? null },
      );
    }
    return {
      ...base,
      status: String(after.status ?? base.status) as MetaAdSet["status"],
      daily_budget_cents: metaMinorToCents(actualMinor, currency),
      effective_status: after.effective_status,
      verified: true,
    };
  }

  /**
   * Daily budget of a campaign that owns its budget (CBO / Advantage+
   * campaign budget). Campaigns whose ad sets hold the budgets go through
   * updateAdSetBudget instead.
   */
  async updateCampaignBudget(input: UpdateCampaignBudgetInput): Promise<
    MetaCampaign & {
      currency: string;
      previous_daily_budget_cents: number | null;
      daily_budget_cents: number;
      effective_status?: string;
      verified: boolean;
      verification_error?: string;
    }
  > {
    const campaign = await this.graph.get<{
      id?: string;
      name?: string;
      status?: string;
      objective?: string;
      account_id?: unknown;
      daily_budget?: string;
      lifetime_budget?: string;
    }>(input.campaign_id, {
      fields: "id,name,status,objective,account_id,daily_budget,lifetime_budget",
    });
    const name = campaign.name ?? input.campaign_id;

    // The account comes from the campaign itself, never from the proposal.
    const accountId =
      campaign.account_id != null && String(campaign.account_id).trim()
        ? normalizeAccountId(String(campaign.account_id).trim())
        : null;
    if (!accountId) {
      throw new Error(
        `Could not confirm which ad account campaign ${input.campaign_id} belongs to. Nothing was changed.`,
      );
    }
    if (input.account_id && normalizeAccountId(input.account_id) !== accountId) {
      throw new Error(
        `Campaign "${name}" belongs to ad account ${accountId}, not ${normalizeAccountId(input.account_id)}. Nothing was changed.`,
      );
    }
    if (positiveMinor(campaign.lifetime_budget)) {
      throw new Error(
        `Campaign "${name}" uses a lifetime budget, not a daily budget — change it in Ads Manager. Nothing was changed.`,
      );
    }
    if (!positiveMinor(campaign.daily_budget)) {
      throw new Error(
        `Campaign "${name}" has no campaign budget — its ad set budgets control spend, so change those with update_adset_budget. Nothing was changed.`,
      );
    }

    const currency = await this.requireAccountCurrency(accountId);
    const requestedMinor = this.budgetMinor(input.daily_budget_cents, currency, "Campaign daily budget");
    const previousCents = metaMinorToCents(Number(campaign.daily_budget), currency);

    await this.graph.post(input.campaign_id, { daily_budget: requestedMinor });
    this.invalidateCampaigns(accountId);

    const base = {
      id: input.campaign_id,
      account_id: accountId,
      name,
      objective: campaign.objective ?? "",
      status: String(campaign.status ?? "PAUSED") as MetaCampaign["status"],
      currency,
      previous_daily_budget_cents: previousCents,
    };

    // Read back: the change succeeded on Meta, so a failed re-read is
    // reported as unverified (never as a failure that invites a retry).
    let after: { daily_budget?: string; status?: string; effective_status?: string };
    try {
      after = await this.graph.get(input.campaign_id, {
        fields: "daily_budget,status,effective_status",
      });
    } catch (error) {
      return {
        ...base,
        daily_budget_cents: input.daily_budget_cents,
        verified: false,
        verification_error: error instanceof Error ? error.message : "Read-back failed",
      };
    }
    const actualMinor = Number(after.daily_budget);
    if (!Number.isFinite(actualMinor) || String(actualMinor) !== requestedMinor) {
      const shown = Number.isFinite(actualMinor)
        ? formatMoney(metaMinorToCents(actualMinor, currency), currency)
        : "no daily budget";
      throw new ExecutionVerificationError(
        `Meta accepted the budget update for "${name}", but reading it back shows ${shown} instead of ${formatMoney(input.daily_budget_cents, currency)}. Check the campaign in Ads Manager before trying again.`,
        { campaign_id: input.campaign_id, requested_minor: requestedMinor, actual_minor: after.daily_budget ?? null },
      );
    }
    return {
      ...base,
      status: String(after.status ?? base.status) as MetaCampaign["status"],
      daily_budget_cents: metaMinorToCents(actualMinor, currency),
      effective_status: after.effective_status,
      verified: true,
    };
  }

  /** POST a status change and read it back. */
  private async setStatusVerified(
    label: "Campaign" | "Ad set" | "Ad",
    accountId: string,
    entityId: string,
    status: "ACTIVE" | "PAUSED",
  ): Promise<{
    name?: string;
    status: string;
    effective_status?: string;
    objective?: string;
    adset_id?: string;
    campaign_id?: string;
    verified: boolean;
    verification_error?: string;
  }> {
    await this.assertEntityInAccount(entityId, accountId, label);
    await this.graph.post(entityId, { status });
    let row: Record<string, unknown>;
    try {
      row = await this.graph.get<Record<string, unknown>>(entityId, {
        fields:
          label === "Campaign"
            ? "name,status,effective_status,objective"
            : label === "Ad set"
              ? "name,status,effective_status,campaign_id"
              : "name,status,effective_status,adset_id,campaign_id",
      });
    } catch (error) {
      return {
        status,
        verified: false,
        verification_error:
          error instanceof Error ? error.message : "Read-back failed",
      };
    }
    const actual = typeof row.status === "string" ? row.status : "";
    if (actual !== status) {
      throw new ExecutionVerificationError(
        `Meta accepted the request, but ${label.toLowerCase()} ${entityId} reports status ${actual || "unknown"} instead of ${status}. Check it in Ads Manager.`,
        { entity_id: entityId, requested_status: status, actual_status: actual || null },
      );
    }
    return {
      name: typeof row.name === "string" ? row.name : undefined,
      status: actual,
      effective_status:
        typeof row.effective_status === "string" ? row.effective_status : undefined,
      objective: typeof row.objective === "string" ? row.objective : undefined,
      adset_id: typeof row.adset_id === "string" ? row.adset_id : undefined,
      campaign_id: typeof row.campaign_id === "string" ? row.campaign_id : undefined,
      verified: true,
    };
  }

  async pauseCampaign(
    accountId: string,
    campaignId: string,
  ): Promise<MetaCampaign & { effective_status?: string; verified: boolean; verification_error?: string }> {
    const res = await this.setStatusVerified("Campaign", accountId, campaignId, "PAUSED");
    this.invalidateCampaigns(accountId);
    return {
      id: campaignId,
      account_id: normalizeAccountId(accountId),
      name: res.name ?? campaignId,
      status: res.status as MetaCampaign["status"],
      objective: res.objective ?? "",
      effective_status: res.effective_status,
      verified: res.verified,
      ...(res.verification_error ? { verification_error: res.verification_error } : {}),
    };
  }

  async resumeCampaign(
    accountId: string,
    campaignId: string,
  ): Promise<MetaCampaign & { effective_status?: string; verified: boolean; verification_error?: string }> {
    const res = await this.setStatusVerified("Campaign", accountId, campaignId, "ACTIVE");
    this.invalidateCampaigns(accountId);
    return {
      id: campaignId,
      account_id: normalizeAccountId(accountId),
      name: res.name ?? campaignId,
      status: res.status as MetaCampaign["status"],
      objective: res.objective ?? "",
      effective_status: res.effective_status,
      verified: res.verified,
      ...(res.verification_error ? { verification_error: res.verification_error } : {}),
    };
  }

  private async setAdSetStatus(
    accountId: string,
    adSetId: string,
    status: "ACTIVE" | "PAUSED",
  ): Promise<MetaAdSet & { effective_status?: string; verified: boolean; verification_error?: string }> {
    const res = await this.setStatusVerified("Ad set", accountId, adSetId, status);
    return {
      id: adSetId,
      campaign_id: res.campaign_id ?? "unknown",
      account_id: normalizeAccountId(accountId),
      name: res.name ?? adSetId,
      status: res.status as MetaAdSet["status"],
      // Status only — the budget is untouched and not re-read here.
      daily_budget_cents: 0,
      effective_status: res.effective_status,
      verified: res.verified,
      ...(res.verification_error ? { verification_error: res.verification_error } : {}),
    };
  }

  async pauseAdSet(accountId: string, adSetId: string) {
    return this.setAdSetStatus(accountId, adSetId, "PAUSED");
  }

  async resumeAdSet(accountId: string, adSetId: string) {
    return this.setAdSetStatus(accountId, adSetId, "ACTIVE");
  }

  async createCampaign(input: CreateCampaignInput): Promise<MetaCampaign> {
    const accountId = normalizeAccountId(input.account_id);
    const hasDaily = typeof input.daily_budget_cents === "number";
    const hasLifetime = typeof input.lifetime_budget_cents === "number";
    if (hasDaily && hasLifetime) {
      throw new Error("A campaign can have a daily or a lifetime budget, not both.");
    }
    const body: Record<string, string | boolean> = {
      name: input.name,
      objective: input.objective,
      status: input.status ?? "PAUSED",
      special_ad_categories: JSON.stringify(input.special_ad_categories ?? []),
    };
    if (hasDaily || hasLifetime) {
      // Campaign budget (CBO): the campaign also owns the bid strategy.
      const currency = await this.requireAccountCurrency(accountId);
      if (hasDaily) {
        body.daily_budget = this.budgetMinor(
          input.daily_budget_cents!,
          currency,
          "Campaign daily budget",
        );
      } else {
        body.lifetime_budget = this.budgetMinor(
          input.lifetime_budget_cents!,
          currency,
          "Campaign lifetime budget",
        );
      }
      body.bid_strategy = input.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP";
    } else {
      // Meta Marketing API v24+: required when budget lives on ad sets (not CBO).
      body.is_adset_budget_sharing_enabled =
        input.is_adset_budget_sharing_enabled ?? false;
    }
    const res = await this.graph.post<{ id: string }>(
      `${accountId}/campaigns`,
      body,
    );
    this.invalidateCampaigns(accountId);
    return {
      id: String(res.id),
      account_id: accountId,
      name: input.name,
      status: (input.status ?? "PAUSED") as MetaCampaign["status"],
      objective: input.objective,
      daily_budget_cents: input.daily_budget_cents,
      lifetime_budget_cents: input.lifetime_budget_cents,
    };
  }

  async createImageCampaign(input: CreateImageCampaignInput) {
    return this.createFullCampaign(input, "image");
  }

  async createVideoCampaign(input: CreateVideoCampaignInput) {
    return this.createFullCampaign(input, "video");
  }

  /**
   * Campaign → ad set → creative → ad, all PAUSED. Everything that can be
   * checked is checked before the first POST; each created ID is reported
   * through onProgress, and IDs in `resume` (from an earlier failed run) are
   * reused instead of created again.
   */
  private async createFullCampaign(
    input: CreateImageCampaignInput | CreateVideoCampaignInput,
    kind: "image" | "video",
  ) {
    const accountId = normalizeAccountId(input.account_id);
    const progress: CreateProgress = { ...(input.resume ?? {}) };
    const record = async (patch: CreateProgress) => {
      Object.assign(progress, patch);
      try {
        await input.onProgress?.({ ...progress });
      } catch (error) {
        logger.warn("Create progress checkpoint failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        throw new PartialCreateError(name, error, progress);
      }
    };

    // ---- 1. Validate everything before anything is created -------------
    const objective = input.objective ?? "OUTCOME_TRAFFIC";
    const useCbo = Boolean(input.campaign_budget_optimization);
    const daily = positiveNumber(input.budget_daily);
    const lifetime = positiveNumber(input.budget_lifetime);
    if (daily == null && lifetime == null) {
      throw new Error(
        "A budget is required — set budget_daily, or budget_lifetime with end_time. Nothing was created.",
      );
    }
    if (daily != null && lifetime != null) {
      throw new Error("Set either budget_daily or budget_lifetime, not both. Nothing was created.");
    }
    if (lifetime != null) assertFutureEndTime(input.end_time, true);
    else if (input.end_time) assertFutureEndTime(input.end_time, false);
    const cta = normalizeCallToAction(input.call_to_action);
    const currency = await this.requireAccountCurrency(accountId);
    const facebookPageId = await step("Resolve Facebook page", () =>
      this.resolveFacebookPageId(accountId, input.facebook_page_id),
    );
    const leadFormId = resolveLeadFormId(input);

    const adSetInput: CreateAdSetInput = {
      account_id: accountId,
      campaign_id: progress.campaign_id ?? "pending",
      name: input.ad_set_name ?? `${input.campaign_name} - Ad Set`,
      budget_daily: useCbo ? undefined : (daily ?? undefined),
      budget_lifetime: useCbo ? undefined : (lifetime ?? undefined),
      start_time: input.start_time,
      end_time: input.end_time,
      ad_type: kind,
      landing_page_url: input.landing_page_url,
      primary_text: input.primary_text,
      age_min: input.age_min,
      age_max: input.age_max,
      genders: input.genders,
      locations: input.locations,
      publisher_platforms: input.publisher_platforms,
      objective,
      facebook_page_id: facebookPageId,
      pixel_id: input.pixel_id,
      pixel_event_name: input.pixel_event_name,
      lead_form_id: leadFormId,
      campaign_budget_optimization: useCbo,
      extra_args: mergeCampaignExtra(input),
    };
    // Throws on missing location / budget before any POST.
    const adSetPlan = await this.planAdSet(adSetInput, {
      cbo: useCbo,
      objective,
      currency,
      special_ad_categories: input.special_ad_categories,
    });
    const campaignBudgetCents = useCbo
      ? budgetToMinorUnits(daily ?? lifetime ?? undefined)
      : undefined;
    if (useCbo) this.budgetMinor(campaignBudgetCents ?? 0, currency, "Campaign budget");
    const campaignBudget = !useCbo
      ? {}
      : daily != null
        ? { daily_budget_cents: campaignBudgetCents }
        : { lifetime_budget_cents: campaignBudgetCents };
    const bids = bidPlan(adSetInput.extra_args ?? {}, objective, currency);

    // A recorded campaign must still exist in this account; never re-create it.
    if (progress.campaign_id) {
      const campaignId = progress.campaign_id;
      await step("Check previously created campaign", () =>
        this.assertEntityInAccount(campaignId, accountId, "Campaign"),
      );
    }

    // ---- 2. Video upload ---------------------------------------------------
    const video = input as CreateVideoCampaignInput;
    let videoId = kind === "video" ? (video.existing_video_id ?? progress.video_id) : undefined;
    if (kind === "video" && !videoId) {
      if (!video.video_url) {
        throw new Error("A video ad needs video_url or existing_video_id. Nothing was created.");
      }
      videoId = await step("Upload video", () =>
        this.uploadVideoFromUrl(accountId, video.video_url!),
      );
      await record({ video_id: videoId });
    }

    // ---- 3. Campaign -------------------------------------------------------
    let campaign: MetaCampaign;
    if (progress.campaign_id) {
      campaign = {
        id: progress.campaign_id,
        account_id: accountId,
        name: input.campaign_name,
        status: "PAUSED",
        objective,
      };
    } else {
      campaign = await step("Create campaign", () =>
        this.createCampaign({
          account_id: accountId,
          name: input.campaign_name,
          objective,
          status: "PAUSED",
          special_ad_categories: input.special_ad_categories,
          ...campaignBudget,
          ...(useCbo ? { bid_strategy: bids.strategy } : {}),
        }),
      );
      await record({ campaign_id: campaign.id });
    }

    // ---- 4. Ad set ---------------------------------------------------------
    let adset: MetaAdSet;
    if (progress.adset_id) {
      adset = {
        id: progress.adset_id,
        campaign_id: campaign.id,
        account_id: accountId,
        name: adSetInput.name ?? "Ad Set",
        status: "PAUSED",
        daily_budget_cents: adSetPlan.daily_budget_cents,
      };
    } else {
      const res = await step("Create ad set", () =>
        this.graph.post<{ id: string }>(`${accountId}/adsets`, {
          ...adSetPlan.body,
          campaign_id: campaign.id,
        }),
      );
      adset = {
        id: String(res.id),
        campaign_id: campaign.id,
        account_id: accountId,
        name: adSetInput.name ?? "Ad Set",
        status: "PAUSED",
        daily_budget_cents: adSetPlan.daily_budget_cents,
        optimization_goal: adSetPlan.optimization_goal,
        billing_event: adSetPlan.billing_event,
        targeting_summary: JSON.stringify(adSetPlan.targeting),
      };
      await record({ adset_id: adset.id });
    }

    // ---- 5. Creative + ad --------------------------------------------------
    const ad = await this.createAdSteps(
      {
        account_id: accountId,
        ad_set_id: adset.id,
        ad_type: kind,
        primary_text: input.primary_text,
        headline: input.headline,
        description: input.description,
        call_to_action: cta,
        landing_page_url: input.landing_page_url,
        display_link: input.display_link,
        url_tags: input.url_tags,
        image_url: kind === "image" ? (input as CreateImageCampaignInput).image_url : undefined,
        existing_image_hash:
          kind === "image" ? (input as CreateImageCampaignInput).existing_image_hash : undefined,
        existing_video_id: videoId,
        thumbnail_url: kind === "video" ? video.thumbnail_url : undefined,
        facebook_page_id: facebookPageId,
        instagram_account_id: input.instagram_account_id,
        lead_form_id: leadFormId,
        name: input.ad_name ?? `${input.campaign_name} - ${kind === "video" ? "Video Ad" : "Ad"}`,
        text_options: textOptionsFrom(adSetInput.extra_args),
      },
      { progress, record, step, adSetVerified: true, pageId: facebookPageId },
    );

    // ---- 6. Further ads in the same ad set --------------------------------
    for (const [i, extra] of extraAdsFrom(adSetInput.extra_args).entries()) {
      const sub: CreateProgress = { ...(progress.extra_ads?.[i] ?? {}) };
      const recordSub = async (patch: CreateProgress) => {
        Object.assign(sub, patch);
        const list = [...(progress.extra_ads ?? [])];
        list[i] = { creative_id: sub.creative_id, ad_id: sub.ad_id, video_id: sub.video_id };
        await record({ extra_ads: list });
      };
      await this.createAdSteps(
        {
          account_id: accountId,
          ad_set_id: adset.id,
          ad_type: kind,
          primary_text: extra.primary_text ?? input.primary_text,
          headline: extra.headline ?? input.headline,
          description: input.description,
          call_to_action: cta,
          landing_page_url: extra.landing_page_url ?? input.landing_page_url,
          display_link: input.display_link,
          url_tags: input.url_tags,
          image_url: kind === "image" ? extra.image_url : undefined,
          existing_image_hash: kind === "image" ? extra.existing_image_hash : undefined,
          video_url: kind === "video" ? extra.video_url : undefined,
          existing_video_id: kind === "video" ? extra.existing_video_id : undefined,
          thumbnail_url: kind === "video" ? extra.thumbnail_url : undefined,
          facebook_page_id: facebookPageId,
          instagram_account_id: input.instagram_account_id,
          lead_form_id: leadFormId,
          name: extra.name ?? `${input.ad_name ?? input.campaign_name} #${i + 2}`,
        },
        { progress: sub, record: recordSub, step, adSetVerified: true, pageId: facebookPageId },
      );
    }

    return {
      campaign: { ...campaign, account_id: accountId },
      adset,
      ad,
      currency,
      created: { ...progress },
      raw_text: "Created with Meta Graph API (all PAUSED)",
    };
  }

  /**
   * Build (and validate) the ad set POST body without sending it. `campaign`
   * says whether the parent campaign owns the budget (CBO).
   */
  private async planAdSet(
    input: CreateAdSetInput,
    campaign: { cbo: boolean; objective?: string; currency?: string; special_ad_categories?: string[] },
  ): Promise<{
    body: Record<string, string | number | boolean | null | undefined>;
    optimization_goal: string;
    billing_event: string;
    targeting: Record<string, unknown>;
    daily_budget_cents: number;
    budget_note?: string;
  }> {
    const accountId = normalizeAccountId(input.account_id);
    const objective = input.objective ?? campaign.objective;
    const extra = { ...(input.extra_args ?? {}) };
    const leadFormId = resolveLeadFormId({ lead_form_id: input.lead_form_id, extra_args: extra });
    if (leadFormId) extra.lead_form_id = leadFormId;

    const currencyForBids = campaign.currency ?? (await this.requireAccountCurrency(accountId));
    const bids = bidPlan(extra, objective, currencyForBids);
    const resolved = optimizationForObjective(objective, { pixel_id: input.pixel_id, extra_args: extra });
    const billing_event = resolved.billing_event;
    const optimization_goal = reconcileGoalWithBid(
      resolved.optimization_goal,
      optionalText(extra.optimization_goal),
      bids.valueGoal,
    );
    // Throws a clear error when no location was given (never defaults to US).
    const targeting = buildMetaTargeting({
      age_min: input.age_min,
      age_max: input.age_max,
      genders: input.genders,
      locations: input.locations,
      publisher_platforms: input.publisher_platforms,
      special_ad_categories: campaign.special_ad_categories,
      extra_args: extra,
    });
    const promoted = buildPromotedObject({
      objective,
      lead_form_id: leadFormId,
      facebook_page_id: input.facebook_page_id,
      pixel_id: input.pixel_id,
      pixel_event_name: input.pixel_event_name,
      extra_args: extra,
    });

    const body: Record<string, string | number | boolean | null | undefined> = {
      name: input.name ?? "Ad Set",
      campaign_id: input.campaign_id,
      status: "PAUSED",
      billing_event,
      optimization_goal,
      targeting: JSON.stringify(targeting),
    };
    if (input.start_time) body.start_time = input.start_time;
    if (input.end_time) {
      assertFutureEndTime(input.end_time, false);
      body.end_time = input.end_time;
    }

    let dailyCents = 0;
    let budgetNote: string | undefined;
    const daily = positiveNumber(input.budget_daily);
    const lifetime = positiveNumber(input.budget_lifetime);
    if (campaign.cbo) {
      // Budget and bid strategy belong to the campaign under CBO.
      if (daily != null || lifetime != null) {
        budgetNote =
          "The campaign uses a campaign budget (CBO), so the ad set budget in the proposal was not applied — the campaign budget is shared across its ad sets.";
      }
    } else {
      if (daily == null && lifetime == null) {
        throw new Error(
          "Missing ad set budget — set budget_daily (major units, e.g. 5 for 5/day), or budget_lifetime with end_time. Nothing was created.",
        );
      }
      if (daily != null && lifetime != null) {
        throw new Error("Set either budget_daily or budget_lifetime on the ad set, not both.");
      }
      if (lifetime != null) assertFutureEndTime(input.end_time, true);
      const currency =
        campaign.currency ?? (await this.requireAccountCurrency(accountId));
      body.bid_strategy = bids.strategy;
      if (daily != null) {
        dailyCents = budgetToMinorUnits(daily) ?? 0;
        body.daily_budget = this.budgetMinor(dailyCents, currency, "Ad set daily budget");
      } else {
        body.lifetime_budget = this.budgetMinor(
          budgetToMinorUnits(lifetime ?? undefined) ?? 0,
          currency,
          "Ad set lifetime budget",
        );
      }
    }

    const destinationType = destinationTypeFor({
      destination_type: optionalText(extra.destination_type),
      conversion_location: optionalText(extra.conversion_location),
      leadFormId,
    });
    if (destinationType) body.destination_type = destinationType;
    const dsaBeneficiary = optionalText(extra.dsa_beneficiary);
    if (dsaBeneficiary) body.dsa_beneficiary = dsaBeneficiary;
    const dsaPayor = optionalText(extra.dsa_payor);
    if (dsaPayor) body.dsa_payor = dsaPayor;
    if (promoted) body.promoted_object = JSON.stringify(promoted);
    Object.assign(body, bids.adset);
    // Attribution applies where Meta optimises for a conversion.
    const attribution = optionalText(extra.attribution);
    if (attribution && ATTRIBUTION_SPEC[attribution] && (optimization_goal === "OFFSITE_CONVERSIONS" || optimization_goal === "VALUE")) {
      body.attribution_spec = JSON.stringify(ATTRIBUTION_SPEC[attribution]);
    }

    return {
      body,
      optimization_goal,
      billing_event,
      targeting,
      daily_budget_cents: dailyCents,
      ...(budgetNote ? { budget_note: budgetNote } : {}),
    };
  }

  async createAdSet(
    input: CreateAdSetInput,
  ): Promise<MetaAdSet & { raw_text?: string; budget_note?: string }> {
    const accountId = normalizeAccountId(input.account_id);
    // The live campaign decides CBO / objective — not the proposal's flag.
    const campaign = await this.graph.get<{
      account_id?: unknown;
      objective?: string;
      daily_budget?: string;
      lifetime_budget?: string;
      bid_strategy?: string;
      special_ad_categories?: string[];
    }>(input.campaign_id, {
      fields: "account_id,objective,daily_budget,lifetime_budget,bid_strategy,special_ad_categories",
    });
    const campaignAccount =
      campaign.account_id != null && String(campaign.account_id).trim()
        ? normalizeAccountId(String(campaign.account_id).trim())
        : null;
    if (campaignAccount !== accountId) {
      throw new Error(
        `Campaign ${input.campaign_id} belongs to ${campaignAccount ?? "an unknown ad account"}, not ${accountId}. Nothing was created.`,
      );
    }
    const cbo =
      positiveMinor(campaign.daily_budget) || positiveMinor(campaign.lifetime_budget);
    // Under a campaign budget the campaign owns the bid strategy: never let a
    // cap or ROAS floor look applied when the campaign bids differently.
    const requested = optionalText(input.extra_args?.bid_strategy)?.toUpperCase();
    const current = (campaign.bid_strategy ?? "LOWEST_COST_WITHOUT_CAP").toUpperCase();
    if (cbo && requested && requested !== current) {
      throw new Error(
        `Campaign ${input.campaign_id} has a campaign budget bidding ${current}, so a new ad set can't use ${requested}. Change the campaign's bid strategy in Ads Manager, or leave bid_strategy off. Nothing was created.`,
      );
    }
    const plan = await this.planAdSet(
      { ...input, account_id: accountId },
      {
        cbo,
        objective: input.objective ?? campaign.objective,
        special_ad_categories: Array.isArray(campaign.special_ad_categories) ? campaign.special_ad_categories : [],
      },
    );

    const res = await this.graph.post<{ id: string }>(`${accountId}/adsets`, plan.body);
    return {
      id: String(res.id),
      campaign_id: input.campaign_id,
      account_id: accountId,
      name: input.name ?? "Ad Set",
      status: "PAUSED",
      daily_budget_cents: plan.daily_budget_cents,
      optimization_goal: plan.optimization_goal,
      billing_event: plan.billing_event,
      targeting_summary: JSON.stringify(plan.targeting),
      raw_text: "Ad set created with Meta Graph API (PAUSED)",
      ...(plan.budget_note ? { budget_note: plan.budget_note } : {}),
    };
  }

  async createAd(input: CreateAdInput): Promise<MetaAd & { raw_text?: string }> {
    const progress: CreateProgress = { ...(input.resume ?? {}) };
    const record = async (patch: CreateProgress) => {
      Object.assign(progress, patch);
      try {
        await input.onProgress?.({ ...progress });
      } catch (error) {
        logger.warn("Create progress checkpoint failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        throw new PartialCreateError(name, error, progress);
      }
    };
    return this.createAdSteps(input, { progress, record, step, adSetVerified: false });
  }

  /**
   * Meta's preview of an ad before anything is created. Video previews need
   * the video in Meta already (it is uploaded on approval).
   */
  async previewAd(input: AdPreviewInput, formats: string[]): Promise<AdPreview[]> {
    const accountId = normalizeAccountId(input.account_id);
    const isVideo = Boolean(input.ad_type === "video" || input.video_url || input.existing_video_id);
    if (isVideo && !input.existing_video_id) {
      throw new Error("A video ad can be previewed after the video is uploaded to Meta — it uploads when the approval runs, and the ad is created PAUSED.");
    }
    const pageId = await this.resolveFacebookPageId(accountId, input.facebook_page_id);
    const storySpec = buildStorySpec(input, {
      pageId,
      videoId: input.existing_video_id,
      ctaType: normalizeCallToAction(input.call_to_action) ?? "LEARN_MORE",
      leadFormId: input.lead_form_id?.trim() || undefined,
      isVideo,
    });
    const creative = JSON.stringify({ object_story_spec: storySpec });
    return Promise.all(
      formats.map(async (format) => {
        const res = await this.graph.get<{ data?: Array<{ body?: string }> }>(`${accountId}/generatepreviews`, {
          creative,
          ad_format: format,
        });
        return { format, iframeSrc: previewFrameSrc(res.data?.[0]?.body) };
      }),
    );
  }

  /** Creative + ad, resuming from `progress` (creative_id / ad_id / video_id). */
  private async createAdSteps(
    input: CreateAdInput,
    ctx: {
      progress: CreateProgress;
      record: (patch: CreateProgress) => Promise<void>;
      step: <T>(name: string, run: () => Promise<T>) => Promise<T>;
      adSetVerified: boolean;
      pageId?: string;
    },
  ): Promise<MetaAd & { raw_text?: string; creative_id: string }> {
    const { progress, record, step } = ctx;
    const accountId = normalizeAccountId(input.account_id);

    // Validate before any POST.
    const ctaType = normalizeCallToAction(input.call_to_action) ?? "LEARN_MORE";
    const leadFormId = input.lead_form_id?.trim() || undefined;
    if (!ctx.adSetVerified) {
      await step("Check ad set", () =>
        this.assertEntityInAccount(input.ad_set_id, accountId, "Ad set"),
      );
    }
    const pageId =
      ctx.pageId ??
      (await step("Resolve Facebook page", () =>
        this.resolveFacebookPageId(accountId, input.facebook_page_id),
      ));

    const isVideo = Boolean(
      input.ad_type === "video" || input.video_url || input.existing_video_id,
    );
    let videoId = input.existing_video_id ?? progress.video_id;
    if (isVideo && !videoId && !input.video_url) {
      throw new Error(
        "Video ad requires existing_video_id or a public video_url Meta can fetch.",
      );
    }

    let creativeId = progress.creative_id;
    if (!creativeId) {
      if (isVideo && !videoId) {
        videoId = await step("Upload video", () =>
          this.uploadVideoFromUrl(accountId, input.video_url!),
        );
        await record({ video_id: videoId });
      }
      const storySpec = buildStorySpec(input, { pageId, videoId, ctaType, leadFormId, isVideo });

      const creativeBody: Record<string, string | number | boolean | null | undefined> = {
        name: input.name ?? "Creative",
        object_story_spec: JSON.stringify(storySpec),
      };
      const feed = textOptionsFeed(input);
      if (feed) creativeBody.asset_feed_spec = JSON.stringify(feed);
      // Standard UTMs unless the operator set their own or the link has them.
      const urlTags =
        input.url_tags ?? (leadFormId || /[?&]utm_/i.test(input.landing_page_url) ? undefined : DEFAULT_URL_TAGS);
      if (urlTags) creativeBody.url_tags = urlTags;

      const creative = await step("Create ad creative", () =>
        this.graph.post<{ id: string }>(`${accountId}/adcreatives`, creativeBody),
      );
      creativeId = String(creative.id);
      await record({ creative_id: creativeId });
    }

    let adId = progress.ad_id;
    if (!adId) {
      const finalCreativeId = creativeId;
      const ad = await step("Create ad", () =>
        this.graph.post<{ id: string }>(`${accountId}/ads`, {
          name: input.name ?? "Ad",
          adset_id: input.ad_set_id,
          status: "PAUSED",
          creative: JSON.stringify({ creative_id: finalCreativeId }),
        }),
      );
      adId = String(ad.id);
      await record({ ad_id: adId });
    }

    return {
      id: adId,
      adset_id: input.ad_set_id,
      campaign_id: progress.campaign_id ?? "unknown",
      account_id: accountId,
      name: input.name ?? "Ad",
      status: "PAUSED",
      creative_id: creativeId,
      creative_summary: input.display_link
        ? `Display: ${input.display_link}`
        : input.landing_page_url,
      raw_text: "Ad created with Meta Graph API (PAUSED)",
    };
  }

  async getEntityState(
    accountId: string,
    entityType: "campaign" | "adset" | "ad",
    entityId: string,
  ): Promise<{ status: string; daily_budget_cents?: number | null } | null> {
    let row: { account_id?: unknown; status?: unknown; daily_budget?: unknown };
    try {
      row = await this.graph.get(entityId, {
        fields: entityType === "ad" ? "account_id,status" : "account_id,status,daily_budget",
      });
    } catch (error) {
      // Missing is an answer; anything else (outage, auth) must fail closed.
      if (error instanceof Error && /does not exist/i.test(error.message)) return null;
      throw error;
    }
    const owner = row.account_id != null && String(row.account_id).trim() ? normalizeAccountId(String(row.account_id)) : null;
    if (owner !== normalizeAccountId(accountId)) return null;
    const status = String(row.status ?? "");
    if (entityType === "ad") return { status };
    const minor = Number(row.daily_budget ?? 0);
    return {
      status,
      daily_budget_cents: minor > 0 ? metaMinorToCents(minor, await this.accountCurrency(accountId)) : null,
    };
  }

  async pauseAd(accountId: string, adId: string) {
    return this.setAdStatus(accountId, adId, "PAUSED");
  }

  async resumeAd(accountId: string, adId: string) {
    return this.setAdStatus(accountId, adId, "ACTIVE");
  }

  private async setAdStatus(
    accountId: string,
    adId: string,
    status: "ACTIVE" | "PAUSED",
  ): Promise<MetaAd & { effective_status?: string; verified: boolean; verification_error?: string }> {
    const res = await this.setStatusVerified("Ad", accountId, adId, status);
    return {
      id: adId,
      adset_id: res.adset_id ?? "unknown",
      campaign_id: res.campaign_id ?? "unknown",
      account_id: normalizeAccountId(accountId),
      name: res.name ?? adId,
      status: res.status as MetaAd["status"],
      effective_status: res.effective_status,
      verified: res.verified,
      ...(res.verification_error ? { verification_error: res.verification_error } : {}),
    };
  }

  async listCustomAudiences(accountId: string): Promise<MetaCustomAudience[]> {
    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      `${normalizeAccountId(accountId)}/customaudiences`,
      {
        fields:
          "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status",
        limit: 100,
      },
    );
    return (data.data ?? [])
      .map((row) => ({
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        subtype: typeof row.subtype === "string" ? row.subtype : null,
        approximate_count: audienceApproximateCount(row),
        delivery_status:
          typeof row.delivery_status === "string" ? row.delivery_status : null,
      }))
      .filter((a) => a.id && a.name);
  }

  async searchTargeting(
    _accountId: string,
    input: {
      search_type: string;
      query: string;
      limit?: number;
      country_code?: string;
    },
  ): Promise<MetaTargetingOption[]> {
    const type = input.search_type.toLowerCase();
    const isLocation = type === "location";
    const params: Record<string, string | number | boolean | null | undefined> = {
      type: isLocation ? "adgeolocation" : "adinterest",
      q: input.query,
      limit: input.limit ?? 25,
    };
    if (isLocation) {
      params.location_types = JSON.stringify([
        "country",
        "region",
        "city",
        "zip",
      ]);
      if (input.country_code) params.country_code = input.country_code;
    } else if (type === "behavior") {
      params.type = "adTargetingCategory";
      params.class = "behaviors";
    } else if (type === "demographic" || type === "life_event") {
      params.type = "adTargetingCategory";
      params.class = type === "life_event" ? "life_events" : "demographics";
    } else if (type === "interest") {
      params.type = "adinterest";
    }

    const data = await this.graph.get<{ data?: Array<Record<string, unknown>> }>(
      "search",
      params,
    );
    return (data.data ?? [])
      .map((row) => {
        const key = String(row.key ?? row.id ?? "");
        const locType =
          typeof row.type === "string"
            ? row.type
            : typeof row.location_type === "string"
              ? row.location_type
              : input.search_type;
        return {
          id: key,
          name: String(row.name ?? ""),
          type: isLocation ? locType : input.search_type,
          audience_size:
            typeof row.audience_size === "number"
              ? row.audience_size
              : Array.isArray(row.audience_size_lower_bound)
                ? Number(row.audience_size_lower_bound[0] ?? 0) || null
                : null,
          path: Array.isArray(row.path)
            ? (row.path as string[]).join(" > ")
            : typeof row.path === "string"
              ? row.path
              : null,
          country_code:
            typeof row.country_code === "string" ? row.country_code : null,
          key,
        };
      })
      .filter((o) => o.id && o.name);
  }

  async browseTargeting(
    accountId: string,
    input: { category: string; limit?: number },
  ): Promise<MetaTargetingOption[]> {
    const category = input.category.replace(/s$/, "");
    // Meta browse via targetingcategory — fall back to a seed search
    return this.searchTargeting(accountId, {
      search_type: category === "interest" ? "interest" : category,
      query: category === "behavior" ? "shopping" : "business",
      limit: input.limit ?? 50,
    });
  }

  async optimizeBudget(
    accountId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }> {
    const id = normalizeAccountId(accountId);
    const lookbackDays = Math.min(
      90,
      Math.max(3, Number(options.lookback_days ?? 7) || 7),
    );
    const { dateStart, dateStop } = lookbackWindow(lookbackDays);
    const [adsets, currency, campaigns] = await Promise.all([
      this.listAdSets(id),
      this.accountCurrency(id),
      this.listCampaigns(id).catch(() => [] as MetaCampaign[]),
    ]);
    const money = (cents: number) => formatMoney(cents, currency);
    let insightsError: string | null = null;
    // Every ad set's window performance, budgeted or not (CBO ad sets carry no budget).
    const perAdSet = new Map<string, { spend: number; conversions: number }>();
    const budgeted = adsets.filter((a) => a.daily_budget_cents > 0);
    const pool =
      budgeted.filter((a) => a.status === "ACTIVE").length > 0
        ? budgeted.filter((a) => a.status === "ACTIVE")
        : budgeted;

    type Ranked = {
      adset_id: string;
      name: string;
      status: string;
      daily_budget_cents: number;
      spend: number;
      clicks: number;
      ctr: number;
      conversions: number;
      cpa: number | null;
      score: number;
    };

    const byId = new Map<string, Ranked>();
    for (const a of pool) {
      byId.set(a.id, {
        adset_id: a.id,
        name: a.name,
        status: a.status,
        daily_budget_cents: a.daily_budget_cents,
        spend: 0,
        clicks: 0,
        ctr: 0,
        conversions: 0,
        cpa: null,
        score: 0,
      });
    }

    try {
      const data = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
      }>(`${id}/insights`, {
        fields:
          "adset_id,adset_name,spend,impressions,clicks,ctr,cpc,actions,cost_per_action_type,frequency,results",
        level: "adset",
        time_range: JSON.stringify({ since: dateStart, until: dateStop }),
        limit: 100,
      });
      for (const row of data.data ?? []) {
        const adsetId = String(row.adset_id ?? "");
        if (!adsetId) continue;
        const existing =
          byId.get(adsetId) ??
          ({
            adset_id: adsetId,
            name: String(row.adset_name ?? adsetId),
            status: "UNKNOWN",
            daily_budget_cents:
              pool.find((a) => a.id === adsetId)?.daily_budget_cents ?? 0,
            spend: 0,
            clicks: 0,
            ctr: 0,
            conversions: 0,
            cpa: null,
            score: 0,
          } satisfies Ranked);
        const spend = Number(row.spend ?? 0);
        const clicks = Number(row.clicks ?? 0);
        const ctr = Number(row.ctr ?? 0);
        // Meta's result count for the ad set's own optimisation event; the
        // action-name guess only for rows without it.
        const counted = metaResultCount(row);
        const legacy = extractConversionMetrics(row);
        const conversions = counted ?? legacy.conversions;
        const cpa = counted != null ? (counted > 0 ? spend / counted : null) : legacy.cpa;
        perAdSet.set(adsetId, { spend, conversions });
        existing.spend = spend;
        existing.clicks = clicks;
        existing.ctr = ctr;
        existing.conversions = conversions;
        existing.cpa = cpa;
        if (!byId.has(adsetId) && existing.daily_budget_cents > 0) {
          byId.set(adsetId, existing);
        } else if (byId.has(adsetId)) {
          byId.set(adsetId, existing);
        }
      }
    } catch (error) {
      // Without performance data we can still show budgets, but must not
      // recommend moving money (that would be a guess dressed up as analysis).
      insightsError = error instanceof Error ? error.message : String(error);
    }

    const ranked = [...byId.values()].map((row) => {
      let score = row.ctr;
      if (row.conversions > 0 && row.cpa != null && row.cpa > 0) {
        score = 1_000_000 / row.cpa + row.conversions * 10;
      } else if (row.spend > 0 && row.conversions === 0) {
        score = row.ctr - Math.min(50, row.spend);
      }
      return { ...row, score };
    });
    ranked.sort((a, b) => b.score - a.score);

    const proposals: Array<{
      tool: string;
      args: Record<string, unknown>;
      rationale: string;
    }> = [];
    const lines: string[] = [
      `### Budget optimize (${id}) · ${dateStart} → ${dateStop}`,
    ];

    if (insightsError) {
      lines.push(
        `- Performance data could not be loaded (${insightsError}). No budget changes are proposed until it can be read — try again shortly.`,
      );
      return {
        text: lines.join("\n"),
        structured: {
          accountId: id,
          lookback_days: lookbackDays,
          proposals: [],
          insights_error: insightsError,
        },
      };
    }

    // Campaign budget (CBO): the campaign owns the money, so it is scaled or
    // trimmed there, and an ad set wasting it is paused instead of trimmed.
    const cboCampaigns = campaigns.filter(
      (c) => c.status === "ACTIVE" && (c.daily_budget_cents ?? 0) > 0,
    );

    if (!ranked.length && !cboCampaigns.length) {
      lines.push("- No ad sets or campaigns with a daily budget found to rebalance.");
      return {
        text: lines.join("\n"),
        structured: { accountId: id, lookback_days: lookbackDays, proposals: [] },
      };
    }

    const withSpend = ranked.filter((r) => r.spend > 0);
    // Scale only on results — never on CTR or delivery alone.
    const winners = withSpend.filter((r) => r.conversions > 0).slice(0, 2);
    const losers = [...withSpend]
      .reverse()
      .filter((r) => !winners.some((w) => w.adset_id === r.adset_id))
      .slice(0, 2);

    for (const w of winners) {
      if (w.daily_budget_cents <= 0) continue;
      const next = Math.max(
        w.daily_budget_cents + 100,
        Math.round(w.daily_budget_cents * 1.2),
      );
      if (next === w.daily_budget_cents) continue;
      const rationale = `Scale ${w.name}: ${w.conversions} conv · CPA ${
        w.cpa != null ? money(Math.round(w.cpa * 100)) : "n/a"
      } · +20% daily budget.`;
      proposals.push({
        tool: "update_adset_budget",
        args: {
          account_id: id,
          adset_id: w.adset_id,
          daily_budget_cents: next,
          previous_daily_budget_cents: w.daily_budget_cents,
        },
        rationale,
      });
      lines.push(
        `- SCALE ${w.name} (${w.adset_id}): ${money(w.daily_budget_cents)} → ${money(next)}/day`,
      );
    }

    for (const l of losers) {
      if (l.daily_budget_cents <= 0) continue;
      const wasted =
        l.spend >= Math.max(10, l.daily_budget_cents / 100) &&
        l.conversions === 0;
      if (wasted && l.daily_budget_cents >= 500) {
        const next = Math.max(
          100,
          Math.round(l.daily_budget_cents * 0.8),
        );
        if (next >= l.daily_budget_cents) continue;
        const rationale = `Trim ${l.name}: ${money(Math.round(l.spend * 100))} spend with 0 conversions in window · −20% daily budget.`;
        proposals.push({
          tool: "update_adset_budget",
          args: {
            account_id: id,
            adset_id: l.adset_id,
            daily_budget_cents: next,
            previous_daily_budget_cents: l.daily_budget_cents,
          },
          rationale,
        });
        lines.push(
          `- TRIM ${l.name} (${l.adset_id}): ${money(l.daily_budget_cents)} → ${money(next)}/day`,
        );
      }
    }

    const cboRows = cboCampaigns.map((c) => {
      const own = adsets.filter((a) => a.campaign_id === c.id);
      const live = own.filter((a) => a.status === "ACTIVE");
      const perf = own.map((a) => ({ adset: a, ...(perAdSet.get(a.id) ?? { spend: 0, conversions: 0 }) }));
      const spend = perf.reduce((sum, p) => sum + p.spend, 0);
      const conversions = perf.reduce((sum, p) => sum + p.conversions, 0);
      return { campaign: c, budget: c.daily_budget_cents!, live, perf, spend, conversions };
    });
    const cboWinners = cboRows
      .filter((r) => r.conversions > 0)
      .sort((a, b) => a.spend / a.conversions - b.spend / b.conversions)
      .slice(0, 2);

    for (const r of cboRows) {
      const { campaign: c, budget } = r;
      if (cboWinners.includes(r)) {
        const next = Math.max(budget + 100, Math.round(budget * 1.2));
        const cpa = Math.round((r.spend * 100) / r.conversions);
        proposals.push({
          tool: "update_campaign_budget",
          args: { account_id: id, campaign_id: c.id, daily_budget_cents: next, previous_daily_budget_cents: budget },
          rationale: `Scale ${c.name}: ${r.conversions} conv · CPA ${money(cpa)} · +20% campaign daily budget.`,
        });
        lines.push(`- SCALE campaign ${c.name} (${c.id}): ${money(budget)} → ${money(next)}/day (campaign budget)`);
      } else if (r.conversions === 0 && r.spend >= Math.max(10, budget / 100) && budget >= 500) {
        const next = Math.max(100, Math.round(budget * 0.8));
        if (next < budget) {
          proposals.push({
            tool: "update_campaign_budget",
            args: { account_id: id, campaign_id: c.id, daily_budget_cents: next, previous_daily_budget_cents: budget },
            rationale: `Trim ${c.name}: ${money(Math.round(r.spend * 100))} spend with 0 conversions in window · −20% campaign daily budget.`,
          });
          lines.push(`- TRIM campaign ${c.name} (${c.id}): ${money(budget)} → ${money(next)}/day (campaign budget)`);
        }
      }

      // Pause an ad set that spent with nothing to show while a sibling
      // converts — Meta then moves its share to the proven one. Never the
      // last live ad set: that would stop the campaign.
      if (r.conversions === 0) continue;
      const wasters = r.perf
        .filter(
          (p) =>
            p.adset.status === "ACTIVE" &&
            p.conversions === 0 &&
            p.spend >= Math.max(10, budget / 100),
        )
        .sort((a, b) => b.spend - a.spend);
      let liveLeft = r.live.length;
      for (const w of wasters.slice(0, 2)) {
        if (liveLeft <= 1) break;
        liveLeft -= 1;
        proposals.push({
          tool: "pause_adset",
          args: { account_id: id, adset_id: w.adset.id },
          rationale: `Pause ${w.adset.name}: ${money(Math.round(w.spend * 100))} spend with 0 conversions while other ad sets in ${c.name} convert.`,
        });
        lines.push(`- PAUSE ad set ${w.adset.name} (${w.adset.id}): ${money(Math.round(w.spend * 100))} spend, 0 conversions`);
      }
    }

    if (!proposals.length) {
      // No proposal is better than a guess: nothing cleared an evidence gate.
      lines.push(
        "- No budget change proposed: no ad set or campaign has enough results or wasted spend in this window to justify one.",
      );
    }

    lines.push(
      "",
      "These are proposals only. Queue the `update_adset_budget` / `update_campaign_budget` / `pause_adset` execute tools for Approvals — Meta is not changed until approved.",
    );

    return {
      text: lines.join("\n"),
      structured: {
        accountId: id,
        lookback_days: lookbackDays,
        date_start: dateStart,
        date_stop: dateStop,
        rankings: ranked.slice(0, 20),
        proposals,
      },
    };
  }

  async optimizePlacements(
    accountId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }> {
    const id = normalizeAccountId(accountId);
    void options;
    return {
      text: [
        `### Placement optimize (${id})`,
        "- Prefer Feed + Reels / Stories; review Audience Network and right-hand column if CTR is weak.",
        "- Placement edits are advisory in V2 until a dedicated placement execute tool is queued; budget/pause changes cover most immediate wins.",
      ].join("\n"),
      structured: { accountId: id, proposals: [] },
    };
  }

  async detectCreativeFatigue(
    accountId: string,
    options: Record<string, unknown> = {},
  ): Promise<{ text: string; structured?: Record<string, unknown> | null }> {
    const id = normalizeAccountId(accountId);
    // This week vs the week before, judged by the shared fatigue rule. Meta's
    // presets use the account's time zone; the earlier week is 14 days − 7.
    const lookbackDays = 14;
    const frequencyMax = Number(options.frequency_max) > 0 ? Number(options.frequency_max) : undefined;
    const ads = await this.listAds(id);
    const activeAds = ads.filter((a) => a.status === "ACTIVE");

    const proposals: Array<{
      tool: string;
      args: Record<string, unknown>;
      rationale: string;
    }> = [];
    let dateStart = "";
    let dateStop = "";
    const lines: string[] = [];

    try {
      const insights = async (preset: "last_7d" | "last_14d") => {
        const rows: Array<Record<string, unknown>> = [];
        let after: string | undefined;
        for (let page = 0; page < 10; page++) {
          const data = await this.graph.get<{
            data?: Array<Record<string, unknown>>;
            paging?: { cursors?: { after?: string }; next?: string };
          }>(`${id}/insights`, {
            fields: "ad_id,ad_name,adset_id,spend,impressions,frequency,inline_link_clicks,date_start,date_stop",
            level: "ad",
            date_preset: preset,
            limit: 200,
            ...(after ? { after } : {}),
          });
          rows.push(...(data.data ?? []));
          after = data.paging?.next ? data.paging?.cursors?.after : undefined;
          if (!after) break;
        }
        return rows;
      };
      const [now, fortnight] = await Promise.all([insights("last_7d"), insights("last_14d").catch(() => [])]);
      dateStart = String(now[0]?.date_start ?? "");
      dateStop = String(now[0]?.date_stop ?? "");
      const totals14 = new Map(fortnight.map((r) => [String(r.ad_id ?? ""), { imps: Number(r.impressions ?? 0), clicks: Number(r.inline_link_clicks ?? 0) }]));
      const fatigued = now
        .map((row) => {
          const adId = String(row.ad_id ?? "");
          const imps = Number(row.impressions ?? 0);
          const clicks = Number(row.inline_link_clicks ?? 0);
          const all = totals14.get(adId);
          const impsBefore = all ? all.imps - imps : 0;
          const verdict = assessFatigue(
            {
              impressions: imps,
              frequency7d: Number(row.frequency ?? 0),
              ctrNow: imps > 0 ? (clicks / imps) * 100 : 0,
              ctrBefore: all && impsBefore > 0 ? ((all.clicks - clicks) / impsBefore) * 100 : null,
            },
            { frequencyMax },
          );
          return { adId, name: String(row.ad_name ?? adId), adsetId: String(row.adset_id ?? ""), ...verdict };
        })
        .filter((r) => r.adId && r.fatigued);

      if (!fatigued.length) lines.push("- No ad meets the fatigue rule (7-day frequency over the limit and link CTR down 20%+).");
      const pausing = new Set<string>();
      for (const f of fatigued) {
        const live = activeAds.find((a) => a.id === f.adId);
        if (!live) {
          lines.push(`- ${f.name} (${f.adId}): ${f.reason} Already not active.`);
          continue;
        }
        // Never empty an ad set: something must keep delivering.
        const siblings = activeAds.filter((a) => a.adset_id === live.adset_id && a.id !== f.adId && !pausing.has(a.id));
        if (!siblings.length) {
          lines.push(`- ${f.name} (${f.adId}): ${f.reason} Not proposed — it's the only live ad in its ad set; add a replacement first.`);
          continue;
        }
        if (pausing.size >= 3) continue;
        pausing.add(f.adId);
        proposals.push({ tool: "pause_ad", args: { account_id: id, ad_id: f.adId }, rationale: `Pause fatigued ad ${f.name}: ${f.reason}` });
        lines.push(`- PAUSE ${f.name} (${f.adId}): ${f.reason}`);
      }
    } catch {
      lines.push(`- Could not load ad-level insights. Active ads on file: ${activeAds.length}.`);
    }
    lines.unshift(
      `### Creative fatigue (${id}) · ${dateStart && dateStop ? `${dateStart} → ${dateStop}` : "last 7 days"} vs the 7 days before`,
    );

    lines.push(
      "",
      "Pause proposals require Approvals. Refresh creative separately via image generation if needed.",
    );

    return {
      text: lines.join("\n"),
      structured: {
        accountId: id,
        lookback_days: lookbackDays,
        date_start: dateStart,
        date_stop: dateStop,
        proposals,
      },
    };
  }

  async getAdCreatives(
    accountId: string,
    options: {
      lookback_days?: number;
      campaign_id?: string;
      ad_set_id?: string;
      limit?: number;
    } = {},
  ): Promise<MetaAdCreative[]> {
    const id = normalizeAccountId(accountId);
    const limit = Math.min(50, Math.max(1, options.limit ?? 30));
    const path = options.ad_set_id
      ? `${options.ad_set_id}/ads`
      : options.campaign_id
        ? `${options.campaign_id}/ads`
        : `${id}/ads`;

    const creativeFields =
      "id,name,title,body,call_to_action_type,call_to_action,link_url,object_url,object_story_spec,asset_feed_spec,thumbnail_url,image_url,url_tags,effective_object_story_id,object_story_id";

    const { extractCreativeDestination } = await import(
      "@/lib/meta/extract-creative-destination"
    );

    const pagePostCache = new Map<string, Record<string, unknown> | null>();

    const loadPagePost = async (
      storyId: string | null,
    ): Promise<Record<string, unknown> | null> => {
      if (!storyId) return null;
      if (pagePostCache.has(storyId)) return pagePostCache.get(storyId) ?? null;
      try {
        const post = await this.graph.get<Record<string, unknown>>(storyId, {
          fields:
            "id,call_to_action,link,message,attachments{unshimmed_url,url,title,description,target}",
        });
        pagePostCache.set(storyId, post);
        return post;
      } catch {
        pagePostCache.set(storyId, null);
        return null;
      }
    };

    const creativeIdOf = (row: Record<string, unknown>): string | null => {
      const nested =
        row.creative && typeof row.creative === "object"
          ? (row.creative as Record<string, unknown>)
          : null;
      return (
        (nested && typeof nested.id === "string" && nested.id) ||
        (typeof row.creative === "string" ? row.creative : null)
      );
    };

    const mapRows = async (
      rows: Array<Record<string, unknown>>,
    ): Promise<MetaAdCreative[]> => {
      // Always hydrate creatives by id — the nested expand is often
      // incomplete — but in one batched request instead of one per ad.
      let hydrated: Record<string, Record<string, unknown>> = {};
      try {
        hydrated = await this.graph.getByIds<Record<string, unknown>>(
          rows.map(creativeIdOf).filter((id): id is string => Boolean(id)),
          { fields: creativeFields },
        );
      } catch {
        // keep nested expands
      }

      const results: MetaAdCreative[] = [];
      for (const row of rows) {
        const creativeId = creativeIdOf(row);
        const creative: Record<string, unknown> | null =
          (creativeId ? hydrated[creativeId] : undefined) ??
          (row.creative && typeof row.creative === "object"
            ? (row.creative as Record<string, unknown>)
            : null);

        // The creative's own Website URL wins. Only consult the linked page post
        // when the creative carries no destination at all (post links can be stale).
        let extracted = extractCreativeDestination(creative);
        if (!extracted.landing_page_url) {
          const storyIdRaw =
            (typeof creative?.effective_object_story_id === "string" &&
              creative.effective_object_story_id) ||
            (typeof creative?.object_story_id === "string" &&
              creative.object_story_id) ||
            null;
          const pagePost = await loadPagePost(storyIdRaw);
          if (pagePost) {
            extracted = extractCreativeDestination(creative, pagePost);
          }
          if (!extracted.landing_page_url) {
            // Surface the shape Meta actually returned instead of silently
            // reporting "no destination" for an ad that has one in Ads Manager.
            logger.warn("meta.creative_destination_missing", {
              ad_id: String(row.id ?? ""),
              creative_id: creativeId,
              story_id: storyIdRaw,
              creative_keys: creative ? Object.keys(creative) : [],
              story_spec_keys: Object.keys(
                (creative?.object_story_spec as Record<string, unknown>) ?? {},
              ),
            });
          }
        }

        results.push({
          ad_id: String(row.id ?? ""),
          ad_name: String(row.name ?? "Ad"),
          campaign_id: String(row.campaign_id ?? options.campaign_id ?? ""),
          adset_id: String(row.adset_id ?? options.ad_set_id ?? ""),
          headline: extracted.headline,
          primary_text: extracted.primary_text,
          call_to_action_type: extracted.call_to_action_type,
          landing_page_url: extracted.landing_page_url,
          image_url:
            typeof creative?.image_url === "string"
              ? creative.image_url
              : typeof creative?.thumbnail_url === "string"
                ? creative.thumbnail_url
                : null,
          creative_type: extracted.creative_type,
          destination_source: extracted.destination_source,
          destination_candidates: extracted.destination_candidates,
          ad_status: typeof row.status === "string" ? row.status : null,
          effective_status:
            typeof row.effective_status === "string"
              ? row.effective_status
              : null,
        });
      }
      return results;
    };

    const fetchAds = async (withStatusFilter: boolean) => {
      const params: Record<string, string | number | boolean> = {
        fields: `id,name,status,effective_status,campaign_id,adset_id,creative{${creativeFields}}`,
        limit,
      };
      if (withStatusFilter) {
        // Include paused — Website URL is creative config, not delivery.
        params.filtering = JSON.stringify([
          {
            field: "effective_status",
            operator: "IN",
            value: [
              "ACTIVE",
              "PAUSED",
              "CAMPAIGN_PAUSED",
              "ADSET_PAUSED",
              "PENDING_REVIEW",
              "DISAPPROVED",
              "PREAPPROVED",
              "PENDING_BILLING_INFO",
              "IN_PROCESS",
              "WITH_ISSUES",
            ],
          },
        ]);
      }
      return this.graph.get<{ data?: Array<Record<string, unknown>> }>(
        path,
        params,
      );
    };

    try {
      let data: { data?: Array<Record<string, unknown>> };
      try {
        data = await fetchAds(true);
      } catch {
        data = await fetchAds(false);
      }
      let results = await mapRows(data.data ?? []);

      // If filtered call returned nothing, retry unfiltered (paused ads).
      if (!results.length) {
        data = await fetchAds(false);
        results = await mapRows(data.data ?? []);
      }

      return results;
    } catch {
      // Last resort: list ads then hydrate each creative by id
      try {
        const ads = await this.listAds(
          accountId,
          options.ad_set_id,
        );
        const scoped = options.campaign_id
          ? ads.filter((a) => a.campaign_id === options.campaign_id)
          : ads;
        const hydrated: MetaAdCreative[] = [];
        for (const ad of scoped.slice(0, limit)) {
          try {
            const fullAd = await this.graph.get<Record<string, unknown>>(ad.id, {
              fields: `id,name,status,effective_status,campaign_id,adset_id,creative{${creativeFields}}`,
            });
            const mapped = await mapRows([fullAd]);
            if (mapped[0]) hydrated.push(mapped[0]);
          } catch {
            hydrated.push({
              ad_id: ad.id,
              ad_name: ad.name,
              campaign_id: ad.campaign_id,
              adset_id: ad.adset_id,
              headline: null,
              primary_text: null,
              landing_page_url: null,
              creative_type: "unknown",
              ad_status: ad.status,
              effective_status: null,
            });
          }
        }
        return hydrated;
      } catch {
        return [];
      }
    }
  }

  async listAccessibleAccounts() {
    const fields = "id,name,currency,timezone_name,business";
    const byId = new Map<
      string,
      {
        meta_account_id: string;
        meta_account_name: string;
        currency?: string;
        timezone?: string;
        business_id?: string;
      }
    >();

    const addRow = (row: Record<string, unknown>) => {
      const rawId = String(row.id ?? "").trim();
      if (!rawId || rawId === "me") return;
      const meta_account_id = rawId.startsWith("act_")
        ? rawId
        : `act_${rawId.replace(/^act_/, "")}`;
      if (byId.has(meta_account_id)) return;
      byId.set(meta_account_id, {
        meta_account_id,
        meta_account_name: String(row.name ?? meta_account_id),
        currency: typeof row.currency === "string" ? row.currency : undefined,
        timezone:
          typeof row.timezone_name === "string" ? row.timezone_name : undefined,
        business_id:
          row.business && typeof row.business === "object"
            ? String((row.business as { id?: unknown }).id ?? "") || undefined
            : undefined,
      });
    };

    const addFromEdge = async (path: string) => {
      let after: string | undefined;
      do {
        const res = await this.graph.get<{
          data?: Array<Record<string, unknown>>;
          paging?: { cursors?: { after?: string } };
        }>(path, {
          fields,
          limit: 100,
          ...(after ? { after } : {}),
        });
        for (const row of res.data ?? []) addRow(row);
        after = res.paging?.cursors?.after;
      } while (after);
    };

    try {
      await addFromEdge("me/adaccounts");
    } catch {
      // User may only have business-scoped access for some accounts.
    }

    try {
      const businesses = await this.graph.get<{
        data?: Array<Record<string, unknown>>;
      }>("me/businesses", { fields: "id,name", limit: 50 });
      for (const biz of businesses.data ?? []) {
        const businessId = String(biz.id ?? "").trim();
        if (!businessId) continue;
        for (const edge of ["owned_ad_accounts", "client_ad_accounts"] as const) {
          try {
            await addFromEdge(`${businessId}/${edge}`);
          } catch {
            // Skip businesses the token cannot read.
          }
        }
      }
    } catch {
      // business_management may be missing on older tokens until reconnect.
    }

    return Array.from(byId.values());
  }
}

