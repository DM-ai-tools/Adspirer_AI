import { z } from "zod";
import { registerTool, type ToolContext } from "@/lib/tools/registry";

/**
 * Read-only data tools the workspace writer can call on any question: GA4,
 * Search Console, Google Ads, Meta insights and the client's categories. The
 * client is always the task's client: each tool resolves the client's mapped
 * GA4 property, Search Console site, Google Ads account or Meta ad account
 * itself, so the model never passes (and can't redirect) an id. A tool that
 * can't answer returns { error: true, source, message } for the model to act
 * on; it never throws out of the tool loop. Nothing here writes anywhere.
 */

const CONNECTIONS = "Admin → Connections";
const RECONNECT = `Google needs reconnecting — an admin can reconnect Google under ${CONNECTIONS}.`;

type ToolError = { error: true; source: string; message: string; not_mapped?: true };

function failed(source: string, error: unknown): ToolError {
  const message =
    error instanceof Error && error.name === "GoogleReconnectRequired"
      ? RECONNECT
      : error instanceof Error
        ? error.message
        : String(error);
  return { error: true, source, message };
}

function notMapped(source: string, what: string): ToolError {
  return {
    error: true,
    source,
    not_mapped: true,
    message: `No ${what} is mapped to this client. Map one under ${CONNECTIONS}, then ask again.`,
  };
}

async function googleAssets(ctx: ToolContext) {
  const { clientGoogleAssets } = await import("@/lib/google/assets");
  return clientGoogleAssets(ctx.clientId);
}

async function googleProvider() {
  const { getGoogleDataProvider } = await import("@/lib/google/provider");
  return getGoogleDataProvider();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIVE_DATE = /^(?:today|yesterday|\d{1,4}daysAgo)$/;

/** A date as YYYY-MM-DD, GA4's relative forms (today, yesterday, NdaysAgo) worked out in UTC. */
export function resolveToolDate(value: string, now: Date = new Date()): string {
  if (ISO_DATE.test(value)) return value;
  const today = Date.parse(now.toISOString().slice(0, 10));
  const daysAgo = value === "today" ? 0 : value === "yesterday" ? 1 : Number(value.replace("daysAgo", ""));
  return new Date(today - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

const dateInput = z
  .string()
  .refine((v) => ISO_DATE.test(v) || RELATIVE_DATE.test(v), "Use YYYY-MM-DD, today, yesterday or NdaysAgo");

const round2 = (n: number) => Math.round(n * 100) / 100;
const major = (cents: number) => round2(cents / 100);

// ---------------------------------------------------------------- GA4

/** GA4 API field names: letters, digits, underscores and colons (custom dimensions). */
const GA4_NAME = z.string().regex(/^[A-Za-z][A-Za-z0-9_:]*$/, "Use a GA4 API field name, e.g. itemName");

const ga4Filter = z.object({
  dimension: GA4_NAME,
  match: z.enum(["exact", "contains", "begins_with"]),
  value: z.string().min(1).max(200),
});

export const ga4ReportTool = registerTool({
  name: "ga4_report",
  description: [
    "Read the client's GA4 property (already mapped; never pass a property id). Any GA4 Data API dimension and metric names work; GA4's own error comes back if a name or combination is invalid, so correct it and retry.",
    "Useful dimensions: itemName, itemId, itemCategory, itemBrand, landingPage, pagePath, sessionDefaultChannelGroup, sessionSource, sessionMedium, sessionSourceMedium, sessionCampaignName, transactionId, deviceCategory, country, date.",
    "Useful metrics: itemRevenue, itemsPurchased, itemsViewed, itemsAddedToCart, purchaseRevenue, ecommercePurchases, totalRevenue, sessions, totalUsers, newUsers, engagedSessions, keyEvents, addToCarts, checkouts, averagePurchaseRevenue.",
    "Item dimensions (item*) pair only with item metrics. Best-selling products: dimensions [itemName], metrics [itemRevenue, itemsPurchased], order_by itemRevenue desc.",
    "Dates: YYYY-MM-DD or 30daysAgo / yesterday / today; a second date range compares periods (rows get a dateRange column).",
  ].join(" "),
  inputSchema: z.object({
    dimensions: z.array(GA4_NAME).max(6).default([]),
    metrics: z.array(GA4_NAME).min(1).max(10),
    date_ranges: z
      .array(z.object({ start_date: dateInput, end_date: dateInput }))
      .min(1)
      .max(2),
    dimension_filter: z.union([ga4Filter, z.array(ga4Filter).min(1).max(5)]).optional(),
    order_by: z.object({ field: GA4_NAME, desc: z.boolean().default(true) }).optional(),
    limit: z.number().int().min(1).max(250).default(50),
  }),
  async execute(args, ctx) {
    try {
      const assets = await googleAssets(ctx);
      if (!assets.ga4) return notMapped("GA4", "GA4 property");
      if (args.order_by && ![...args.metrics, ...args.dimensions].includes(args.order_by.field)) {
        return { error: true, source: "GA4", message: `order_by.field must be one of the requested metrics or dimensions (got ${args.order_by.field}).` };
      }
      const filters = args.dimension_filter
        ? Array.isArray(args.dimension_filter)
          ? args.dimension_filter
          : [args.dimension_filter]
        : [];
      const report = await (await googleProvider()).ga4Report(assets.ga4.external_id, {
        dimensions: args.dimensions,
        metrics: args.metrics,
        dateRanges: args.date_ranges.map((r) => ({ startDate: r.start_date, endDate: r.end_date })),
        dimensionFilter: filters,
        orderBy: args.order_by ? { field: args.order_by.field, desc: args.order_by.desc } : undefined,
        limit: args.limit,
      });
      const dimensionNames = report.dimensionHeaders.length ? report.dimensionHeaders : args.dimensions;
      const metricNames = report.metricHeaders.length ? report.metricHeaders : args.metrics;
      const rows = report.rows.map((row) => {
        const out: Record<string, string | number> = {};
        dimensionNames.forEach((name, i) => (out[name] = row.dimensions[i] ?? ""));
        metricNames.forEach((name, i) => (out[name] = row.metrics[i] ?? 0));
        return out;
      });
      return {
        source: "GA4",
        property: assets.ga4.name,
        currency: report.currency || assets.ga4.currency || null,
        date_ranges: args.date_ranges,
        row_count: report.rowCount,
        rows_returned: rows.length,
        rows,
        ...(report.rowCount > rows.length
          ? { note: `Showing ${rows.length} of ${report.rowCount} rows; add a filter or raise limit (max 250) for more.` }
          : {}),
      };
    } catch (error) {
      return failed("GA4", error);
    }
  },
});

// ---------------------------------------------------------------- Search Console

const GSC_DIMENSION = z.enum(["query", "page", "country", "device", "date"]);

export const searchConsoleQueryTool = registerTool({
  name: "search_console_query",
  description:
    "Read the client's Search Console site (already mapped; never pass a site). Organic Google search clicks, impressions, CTR and average position by query, page, country, device or date. Filters: contains / equals / notContains / notEquals on a dimension (AND). Dates: YYYY-MM-DD or 28daysAgo / yesterday; Search Console lags about 2 days.",
  inputSchema: z.object({
    dimensions: z.array(GSC_DIMENSION).max(4).default(["query"]),
    start_date: dateInput,
    end_date: dateInput,
    filters: z
      .array(
        z.object({
          dimension: GSC_DIMENSION,
          operator: z.enum(["contains", "equals", "notContains", "notEquals"]),
          expression: z.string().min(1).max(200),
        }),
      )
      .max(5)
      .optional(),
    row_limit: z.number().int().min(1).max(500).default(100),
  }),
  async execute(args, ctx) {
    try {
      const assets = await googleAssets(ctx);
      if (!assets.gsc) return notMapped("Search Console", "Search Console site");
      const startDate = resolveToolDate(args.start_date);
      const endDate = resolveToolDate(args.end_date);
      const result = await (await googleProvider()).searchAnalytics(assets.gsc.external_id, {
        startDate,
        endDate,
        dimensions: args.dimensions,
        filters: args.filters,
        rowLimit: args.row_limit,
      });
      const rows = result.rows.map((row) => {
        const out: Record<string, string | number> = {};
        args.dimensions.forEach((name, i) => (out[name] = row.keys[i] ?? ""));
        out.clicks = row.clicks;
        out.impressions = row.impressions;
        out.ctr = row.ctr;
        out.position = row.position;
        return out;
      });
      return {
        source: "Search Console",
        site: assets.gsc.external_id,
        date_range: { since: startDate, until: endDate },
        rows_returned: rows.length,
        rows,
        ...(rows.length >= args.row_limit
          ? { note: `Showing the top ${rows.length} rows by clicks; more may exist (row_limit max 500).` }
          : {}),
      };
    } catch (error) {
      return failed("Search Console", error);
    }
  },
});

// ---------------------------------------------------------------- Google Ads

const ADS_SECTIONS = ["campaigns", "landing_pages", "asset_groups", "shopping_product_types"] as const;

export const googleAdsReportTool = registerTool({
  name: "google_ads_report",
  description:
    "Read the client's Google Ads account (already mapped; never pass a customer id; read-only, nothing changes in Google). Cost, conversions, conversion value and ROAS by campaign, landing page, Performance Max asset group and Shopping product type for a date range (YYYY-MM-DD or 30daysAgo / yesterday). Money is in the account currency, major units.",
  inputSchema: z.object({
    start_date: dateInput,
    end_date: dateInput,
    sections: z.array(z.enum(ADS_SECTIONS)).min(1).max(4).optional(),
    limit: z.number().int().min(1).max(50).default(25),
  }),
  async execute(args, ctx) {
    try {
      const assets = await googleAssets(ctx);
      if (!assets.ads) return notMapped("Google Ads", "Google Ads account");
      const since = resolveToolDate(args.start_date);
      const until = resolveToolDate(args.end_date);
      const perf = await (await googleProvider()).adsPerformance(assets.ads.external_id, assets.ads.login_customer_id, {
        since,
        until,
      });
      const sections = new Set(args.sections ?? ADS_SECTIONS);
      const money = (costCents: number, valueCents: number) => ({
        cost: major(costCents),
        conversion_value: major(valueCents),
        roas: costCents > 0 ? round2(valueCents / costCents) : null,
      });
      const top = <T extends { costCents: number }>(rows: T[]) =>
        [...rows].sort((a, b) => b.costCents - a.costCents).slice(0, args.limit);
      return {
        source: "Google Ads",
        account: assets.ads.name,
        currency: perf.currency || assets.ads.currency || null,
        date_range: { since, until },
        merchant_center_linked: perf.merchantCenterLinked,
        ...(sections.has("campaigns")
          ? {
              campaigns: top(perf.campaigns).map((c) => ({
                name: c.name,
                type: c.type,
                status: c.status,
                ...money(c.costCents, c.conversionValueCents),
                conversions: c.conversions,
              })),
            }
          : {}),
        ...(sections.has("landing_pages")
          ? { landing_pages: top(perf.landingPages).map((p) => ({ url: p.url, ...money(p.costCents, p.conversionValueCents) })) }
          : {}),
        ...(sections.has("asset_groups")
          ? { asset_groups: top(perf.assetGroups).map((g) => ({ name: g.name, ...money(g.costCents, g.conversionValueCents) })) }
          : {}),
        ...(sections.has("shopping_product_types")
          ? {
              shopping_product_types: top(perf.shoppingCategories).map((s) => ({
                product_type: s.productType,
                ...money(s.costCents, s.conversionValueCents),
              })),
            }
          : {}),
        ...(perf.warnings?.length ? { warnings: perf.warnings } : {}),
      };
    } catch (error) {
      return failed("Google Ads", error);
    }
  },
});

// ---------------------------------------------------------------- Meta

/** Graph field / breakdown names: lowercase letters, digits and underscores. */
const META_NAME = z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a Meta insights field name, e.g. spend");
const META_ID = z.string().regex(/^[A-Za-z0-9_]+$/, "Use the id as Meta returns it");
const DATE_PRESETS = [
  "today", "yesterday", "this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year",
  "last_3d", "last_7d", "last_14d", "last_28d", "last_30d", "last_90d", "this_week_mon_today",
  "this_week_sun_today", "last_week_mon_sun", "last_week_sun_sat", "maximum",
] as const;

const BASE_META_FIELDS = [
  "spend", "impressions", "reach", "frequency", "clicks", "ctr", "cpc", "cpm", "actions", "action_values", "purchase_roas",
];
const LEVEL_FIELDS: Record<"account" | "campaign" | "adset" | "ad", string[]> = {
  account: ["account_name"],
  campaign: ["campaign_id", "campaign_name", "objective"],
  adset: ["campaign_name", "adset_id", "adset_name"],
  ad: ["campaign_name", "adset_name", "ad_id", "ad_name"],
};

export const metaInsightsTool = registerTool({
  name: "meta_insights",
  description: [
    "Read Meta ad insights for the client's own Meta ad account (already mapped; never pass an account id).",
    "level: account | campaign | adset | ad. fields: any Meta insights fields (default spend, impressions, reach, frequency, clicks, ctr, cpc, cpm, actions, action_values, purchase_roas plus names/ids for the level).",
    "breakdowns: age, gender, country, region, publisher_platform, platform_position, device_platform, impression_device, product_id (catalog ads: spend per product), and others Meta accepts.",
    "Period: time_range {since, until} as YYYY-MM-DD, or date_preset (last_7d, last_30d, this_month, …; default last_30d); time_increment 1–90 days, monthly or all_days.",
    "Filter with campaign_ids / adset_ids / ad_ids. Money is in the account currency, major units; Meta's own error comes back if a field or breakdown is invalid.",
  ].join(" "),
  inputSchema: z.object({
    level: z.enum(["account", "campaign", "adset", "ad"]).default("campaign"),
    fields: z.array(META_NAME).min(1).max(25).optional(),
    breakdowns: z.array(META_NAME).max(4).optional(),
    time_range: z
      .object({ since: z.string().regex(ISO_DATE), until: z.string().regex(ISO_DATE) })
      .optional(),
    date_preset: z.enum(DATE_PRESETS).optional(),
    time_increment: z.union([z.number().int().min(1).max(90), z.enum(["monthly", "all_days"])]).optional(),
    campaign_ids: z.array(META_ID).max(50).optional(),
    adset_ids: z.array(META_ID).max(50).optional(),
    ad_ids: z.array(META_ID).max(50).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  async execute(args, ctx) {
    try {
      const { resolvePrimaryAccountId } = await import("@/lib/adspirer/resolve-meta-account");
      const accountId = await resolvePrimaryAccountId(ctx.clientId);
      if (!accountId) return notMapped("Meta", "Meta ad account");
      const { resolveProvider } = await import("@/lib/adspirer/client");
      const provider = await resolveProvider();
      if (!provider.getInsightsReport) {
        return { error: true, source: "Meta", message: "This Meta connection can't read flexible insights." };
      }
      const fields = args.fields ?? [...LEVEL_FIELDS[args.level], ...BASE_META_FIELDS];
      const report = await provider.getInsightsReport(accountId, {
        level: args.level,
        fields,
        breakdowns: args.breakdowns,
        time_range: args.time_range,
        date_preset: args.time_range ? undefined : (args.date_preset ?? "last_30d"),
        time_increment: args.time_increment,
        campaign_ids: args.campaign_ids,
        adset_ids: args.adset_ids,
        ad_ids: args.ad_ids,
        limit: args.limit,
      });
      return {
        source: "Meta",
        account_id: accountId,
        currency: report.currency,
        level: args.level,
        period: args.time_range ?? { date_preset: args.date_preset ?? "last_30d" },
        rows_returned: report.rows.length,
        rows: report.rows,
        ...(report.has_more ? { note: `Meta has more rows than the ${args.limit} shown; filter or raise limit (max 500).` } : {}),
      };
    } catch (error) {
      return failed("Meta", error);
    }
  },
});

// ---------------------------------------------------------------- Categories

export const listClientCategoriesTool = registerTool({
  name: "list_client_categories",
  description:
    "The client's categories / services as set up on the Services tab: name, landing page, gross margin, average order value (client currency, major units) and whether it's active. A ranking such as 'best selling products' is not a category.",
  inputSchema: z.object({ include_inactive: z.boolean().default(true) }),
  async execute(args, ctx) {
    try {
      const [{ listClientServices }, { getClient }] = await Promise.all([
        import("@/lib/clients/ensure-services"),
        import("@/lib/approvals/service"),
      ]);
      const [services, client] = await Promise.all([
        listClientServices(ctx.clientId),
        getClient(ctx.clientId).catch(() => null),
      ]);
      return {
        source: "Client settings",
        currency: client?.currency ?? null,
        categories: services
          .filter((s) => args.include_inactive || s.is_active)
          .map((s) => ({
            name: s.name,
            landing_page_url: s.landing_page_url ?? null,
            gross_margin_pct: s.gross_margin_pct ?? null,
            average_order_value: s.average_order_value_cents != null ? major(s.average_order_value_cents) : null,
            active: s.is_active,
            keywords: s.keywords ?? [],
          })),
      };
    } catch (error) {
      return failed("Client settings", error);
    }
  },
});
