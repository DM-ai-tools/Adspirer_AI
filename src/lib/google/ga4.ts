import { googleFetch } from "./http";
import { getGoogleAccessToken } from "./oauth";
import type {
  DateRange,
  Ga4CategoryRevenue,
  Ga4Channel,
  Ga4LandingPages,
  Ga4ReportRequest,
  Ga4ReportResult,
  Ga4StringFilter,
} from "./types";

/**
 * Read-only GA4 client: the Admin API for property discovery and the Data API
 * runReport for revenue. Nothing here writes to Google. Names checked against
 * the Admin API v1beta and Data API v1beta references and API schema.
 */
const ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";

/** runReport's default page; larger properties keep their top rows by revenue. */
const REPORT_LIMIT = 10000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function digits(id: string): string {
  return id.replace(/\D/g, "");
}

type AccountSummariesResponse = {
  accountSummaries?: Array<{
    account?: string;
    displayName?: string;
    propertySummaries?: Array<{ property?: string; displayName?: string }>;
  }>;
  nextPageToken?: string;
};
type PropertyResponse = { currencyCode?: string; timeZone?: string };

export type Ga4Property = {
  propertyId: string;
  name: string;
  accountName: string;
  currency: string | null;
  timezone: string | null;
};

/** Every GA4 property the Google user can see, with its currency and time zone. */
export async function listGa4Properties(): Promise<Ga4Property[]> {
  const accessToken = await getGoogleAccessToken();
  const summaries: Array<{ propertyId: string; name: string; accountName: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: "200" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await googleFetch<AccountSummariesResponse>(`${ADMIN_BASE}/accountSummaries?${params}`, {
      method: "GET",
      accessToken,
    });
    for (const account of res.accountSummaries ?? []) {
      for (const property of account.propertySummaries ?? []) {
        const propertyId = digits(property.property ?? "");
        if (!propertyId) continue;
        summaries.push({ propertyId, name: property.displayName ?? "", accountName: account.displayName ?? "" });
      }
    }
    pageToken = res.nextPageToken || undefined;
  } while (pageToken);

  return Promise.all(
    summaries.map(async (summary) => {
      try {
        const property = await googleFetch<PropertyResponse>(`${ADMIN_BASE}/properties/${summary.propertyId}`, {
          method: "GET",
          accessToken,
        });
        return { ...summary, currency: property.currencyCode || null, timezone: property.timeZone || null };
      } catch {
        // An unreadable property is still listed; its currency is just unknown.
        return { ...summary, currency: null, timezone: null };
      }
    }),
  );
}

/** Paid default channel groups; any other group (organic, direct, email…) is "other". */
const PAID_GROUPS = new Set(["Paid Social", "Paid Search", "Paid Shopping", "Cross-network", "Paid Video", "Paid Other"]);
const META_SOURCES = ["facebook", "instagram", "meta", "messenger"];
/**
 * Too short to match inside other words ("digital", "plan"), so they must be a whole part of
 * the source: fb, ig, an (Audience Network), msg (Messenger).
 */
const META_SHORT_SOURCES = new Set(["fb", "ig", "an", "msg"]);

/**
 * A paid GA4 session to the plan's channel, by its source: paid social is
 * Facebook / Instagram / Meta traffic only, paid search is Google traffic
 * only. Other paid sources (TikTok, Bing, Pinterest, LinkedIn…) are "other",
 * so neither Meta nor Google is credited with revenue it didn't drive.
 */
export function ga4ChannelOf(channelGroup: string, source?: string): Ga4Channel {
  if (!PAID_GROUPS.has(channelGroup.trim())) return "other";
  const s = (source ?? "").trim().toLowerCase();
  if (!s) return "other";
  if (META_SOURCES.some((m) => s.includes(m)) || s.split(/[^a-z0-9]+/).some((part) => META_SHORT_SOURCES.has(part))) {
    return "paid_social";
  }
  return s.includes("google") ? "paid_search" : "other";
}

type ReportResponse = {
  rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
  rowCount?: number | string;
  metadata?: { currencyCode?: string; dataLossFromOtherRow?: boolean };
};
type ReportRow = { dims: string[]; values: number[] };
type Report = { rows: ReportRow[]; currency: string; dataLoss: boolean };

/** GA4 metric values arrive as strings; anything unparseable counts as 0. */
function num(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Currency units to integer cents. */
function unitsToCents(value: number): number {
  return Math.round(value * 100);
}

/** GA4's placeholder buckets carry no usable key. */
function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "(not set)" || trimmed === "(other)";
}

/** The path of a landing page; a guard in case a query string or hash slips through. */
function landingPath(value: string): string {
  return (value.split(/[?#]/)[0] ?? "").trim();
}

function reportRows(res: ReportResponse): ReportRow[] {
  return (res.rows ?? []).map((row) => ({
    dims: (row.dimensionValues ?? []).map((d) => d.value ?? ""),
    values: (row.metricValues ?? []).map((m) => num(m.value)),
  }));
}

async function runReport(
  propertyId: string,
  range: DateRange,
  dimensions: string[],
  metrics: string[],
): Promise<Report> {
  const res = await googleFetch<ReportResponse>(`${DATA_BASE}/properties/${propertyId}:runReport`, {
    method: "POST",
    accessToken: await getGoogleAccessToken(),
    body: {
      dateRanges: [{ startDate: range.since, endDate: range.until }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
      limit: REPORT_LIMIT,
    },
  });
  return {
    currency: res.metadata?.currencyCode ?? "",
    // Rows past the limit, or grouped into "(other)", are missing from the report.
    dataLoss: res.metadata?.dataLossFromOtherRow === true || num(String(res.rowCount ?? 0)) > REPORT_LIMIT,
    rows: reportRows(res),
  };
}

/** The order-level reports read at most this many rows each. */
const MAX_ORDER_ROWS = 100_000;

/**
 * Every row of a report, a page of REPORT_LIMIT at a time by offset, up to MAX_ORDER_ROWS.
 * Ordered by the first dimension so the pages don't shift between calls.
 */
async function runPagedReport(
  propertyId: string,
  range: DateRange,
  dimensions: string[],
  metrics: string[],
): Promise<Report> {
  const accessToken = await getGoogleAccessToken();
  const rows: ReportRow[] = [];
  let currency = "";
  let dataLoss = false;
  for (let offset = 0; ; ) {
    const res = await googleFetch<ReportResponse>(`${DATA_BASE}/properties/${propertyId}:runReport`, {
      method: "POST",
      accessToken,
      body: {
        dateRanges: [{ startDate: range.since, endDate: range.until }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        orderBys: [{ dimension: { dimensionName: dimensions[0] } }],
        limit: REPORT_LIMIT,
        offset,
      },
    });
    currency ||= res.metadata?.currencyCode ?? "";
    if (res.metadata?.dataLossFromOtherRow === true) dataLoss = true;
    const page = reportRows(res);
    rows.push(...page);
    offset += page.length;
    const total = num(String(res.rowCount ?? 0));
    if (page.length === 0 || offset >= total) break;
    if (offset >= MAX_ORDER_ROWS) {
      dataLoss = true;
      break;
    }
  }
  return { rows, currency, dataLoss };
}

const ORDER_DATA_LOSS_WARNING =
  "GA4 has more order rows than were read (over 100,000, or grouped into (other)); per-channel category figures may be understated";

/**
 * Item revenue per item category per channel: each order's channel (from the session that
 * placed it) joined to its items on transactionId. An order the channel report doesn't have
 * counts as "other"; placeholder transaction ids and categories are skipped. Undefined when
 * either report has no rows; a failed report adds a warning and leaves the rest untouched.
 */
async function fetchItemChannels(
  propertyId: string,
  range: DateRange,
  warnings: string[],
): Promise<Ga4CategoryRevenue["byItemChannel"]> {
  let items: Report;
  let orders: Report;
  try {
    [items, orders] = await Promise.all([
      runPagedReport(propertyId, range, ["transactionId", "itemCategory"], ["itemRevenue"]),
      runPagedReport(propertyId, range, ["transactionId", "sessionDefaultChannelGroup", "sessionSource"], ["purchaseRevenue"]),
    ]);
  } catch (error) {
    // A revoked connection is the caller's to handle; it would fail every other call too.
    if (error instanceof Error && error.name === "GoogleReconnectRequired") throw error;
    warnings.push(
      `GA4 revenue by order and channel didn't load (${error instanceof Error ? error.message : String(error)}); the per-channel split uses landing pages instead`,
    );
    return undefined;
  }
  if (items.dataLoss || orders.dataLoss) warnings.push(ORDER_DATA_LOSS_WARNING);
  if (items.rows.length === 0 || orders.rows.length === 0) return undefined;

  // One channel per order; should GA4 split an order across rows, its biggest row decides.
  const orderChannel = new Map<string, { channel: Ga4Channel; revenue: number }>();
  for (const row of orders.rows) {
    const [txn = "", group = "", source = ""] = row.dims;
    if (isPlaceholder(txn)) continue;
    const id = txn.trim();
    const revenue = row.values[0] ?? 0;
    const seen = orderChannel.get(id);
    if (!seen || revenue > seen.revenue) orderChannel.set(id, { channel: ga4ChannelOf(group, source), revenue });
  }

  const totals = new Map<string, NonNullable<Ga4CategoryRevenue["byItemChannel"]>[number]>();
  for (const row of items.rows) {
    const [txn = "", category = ""] = row.dims;
    if (isPlaceholder(txn) || isPlaceholder(category)) continue;
    const itemCategory = category.trim();
    const channel = orderChannel.get(txn.trim())?.channel ?? "other";
    const key = `${itemCategory}\u0000${channel}`;
    const entry = totals.get(key) ?? { itemCategory, channel, revenueCents: 0 };
    entry.revenueCents += unitsToCents(row.values[0] ?? 0);
    totals.set(key, entry);
  }
  const joined = [...totals.values()].filter((entry) => entry.revenueCents > 0);
  return joined.length > 0 ? joined : undefined;
}

/** Revenue rows keyed by `keyOf`, summed, keeping only keys that earned revenue. */
function revenueRows(rows: ReportRow[], keyOf: (dim: string) => string): Ga4CategoryRevenue["rows"] {
  const totals = new Map<string, { key: string; revenueCents: number; purchases: number }>();
  for (const row of rows) {
    const raw = row.dims[0] ?? "";
    if (isPlaceholder(raw)) continue;
    const key = keyOf(raw);
    if (!key) continue;
    const entry = totals.get(key) ?? { key, revenueCents: 0, purchases: 0 };
    entry.revenueCents += unitsToCents(row.values[0] ?? 0);
    entry.purchases += row.values[1] ?? 0;
    totals.set(key, entry);
  }
  return [...totals.values()].filter((entry) => entry.revenueCents > 0);
}

/**
 * Revenue by category from GA4 purchase items; without item revenue, by
 * landing page instead; with neither, method "none". byChannel always comes
 * from the session landing page, channel group and source. With item
 * categories, byItemChannel also credits each item to its order's channel.
 *
 * Compatibility: itemCategory is item-scoped, so it pairs only with the
 * item-scoped itemRevenue and itemsPurchased. The landing page and channel
 * reports use session-scoped dimensions with the event-scoped purchaseRevenue
 * and ecommercePurchases (purchases only, not ad or subscription revenue).
 * They group by landingPage (the path alone): with the query string, every
 * fbclid/gclid would be its own row and paid traffic would spill into "(other)".
 */
/** The numeric property id, after checking the id and date range before anything calls Google. */
function checkedPropertyId(propertyId: string, range: DateRange): string {
  const id = digits(propertyId);
  if (!id) throw new Error("GA4 property id must be numeric, e.g. properties/123456.");
  if (!DATE.test(range.since) || !DATE.test(range.until)) {
    throw new Error("GA4 date range must be YYYY-MM-DD.");
  }
  return id;
}

export type Ga4CategoryRevenueOptions = {
  /** Read the order-level reports for byItemChannel (default true); category discovery doesn't need them. */
  byItemChannel?: boolean;
};

export async function fetchGa4CategoryRevenue(
  propertyId: string,
  range: DateRange,
  opts: Ga4CategoryRevenueOptions = {},
): Promise<Ga4CategoryRevenue> {
  const id = checkedPropertyId(propertyId, range);

  const [item, channel] = await Promise.all([
    runReport(id, range, ["itemCategory"], ["itemRevenue", "itemsPurchased"]),
    runReport(id, range, ["landingPage", "sessionDefaultChannelGroup", "sessionSource"], ["purchaseRevenue"]),
  ]);
  const warnings: string[] = [];
  if (channel.dataLoss) {
    warnings.push("GA4 grouped some landing pages into (other); per-channel figures may be understated");
  }

  const byChannelMap = new Map<string, Ga4CategoryRevenue["byChannel"][number]>();
  for (const row of channel.rows) {
    const [page = "", group = "", source = ""] = row.dims;
    if (isPlaceholder(page)) continue;
    const landingPage = landingPath(page);
    if (!landingPage) continue;
    const ch = ga4ChannelOf(group, source);
    const mapKey = `${landingPage}\u0000${ch}`;
    const entry = byChannelMap.get(mapKey) ?? { landingPage, channel: ch, revenueCents: 0 };
    entry.revenueCents += unitsToCents(row.values[0] ?? 0);
    byChannelMap.set(mapKey, entry);
  }
  const byChannel = [...byChannelMap.values()];

  const itemRows = revenueRows(item.rows, (category) => category.trim());
  if (itemRows.length > 0) {
    if (item.dataLoss) {
      warnings.push("GA4 grouped some item categories into (other); category figures may be understated");
    }
    const result: Ga4CategoryRevenue = { method: "item", currency: item.currency || channel.currency, rows: itemRows, byChannel, warnings };
    // Only item categories can be joined to orders, so only the item method reads them.
    if (opts.byItemChannel !== false) {
      const byItemChannel = await fetchItemChannels(id, range, warnings);
      if (byItemChannel) result.byItemChannel = byItemChannel;
    }
    return result;
  }

  const landing = await runReport(id, range, ["landingPage"], ["purchaseRevenue", "ecommercePurchases"]);
  const landingRows = revenueRows(landing.rows, landingPath);
  const currency = item.currency || landing.currency || channel.currency;
  if (landingRows.length > 0) {
    if (landing.dataLoss) {
      warnings.push("GA4 grouped some landing pages into (other); landing page figures may be understated");
    }
    return { method: "landing_page", currency, rows: landingRows, byChannel, warnings };
  }
  return { method: "none", currency, rows: [], byChannel, warnings };
}

/**
 * Purchase revenue and purchases by session landing page (the path alone),
 * for pages that earned revenue. Same report as the landing-page fallback above.
 */
export async function fetchGa4LandingPages(propertyId: string, range: DateRange): Promise<Ga4LandingPages> {
  const id = checkedPropertyId(propertyId, range);
  const landing = await runReport(id, range, ["landingPage"], ["purchaseRevenue", "ecommercePurchases"]);
  const warnings = landing.dataLoss
    ? ["GA4 grouped some landing pages into (other); landing page figures may be understated"]
    : [];
  return {
    currency: landing.currency,
    rows: revenueRows(landing.rows, landingPath).map(({ key, revenueCents, purchases }) => ({ path: key, revenueCents, purchases })),
    warnings,
  };
}

const MATCH_TYPE: Record<Ga4StringFilter["match"], string> = {
  exact: "EXACT",
  contains: "CONTAINS",
  begins_with: "BEGINS_WITH",
};

function ga4Filter(filter: Ga4StringFilter) {
  return {
    filter: {
      fieldName: filter.dimension,
      stringFilter: { matchType: MATCH_TYPE[filter.match], value: filter.value, caseSensitive: false },
    },
  };
}

type FreeReportResponse = ReportResponse & {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string }>;
};

/**
 * A free-form runReport for the workspace's ga4_report tool: any dimension and
 * metric names (GA4 checks them and its error message goes back to the model),
 * up to two date ranges, an AND of string filters, one order and a row limit.
 * Read-only.
 */
export async function runGa4Report(propertyId: string, request: Ga4ReportRequest): Promise<Ga4ReportResult> {
  const id = digits(propertyId);
  if (!id) throw new Error("GA4 property id must be numeric, e.g. properties/123456.");
  const filters = request.dimensionFilter ?? [];
  const order = request.orderBy ?? (request.metrics[0] ? { field: request.metrics[0], desc: true } : undefined);
  const orderBys = order
    ? request.metrics.includes(order.field)
      ? [{ metric: { metricName: order.field }, desc: order.desc }]
      : [{ dimension: { dimensionName: order.field }, desc: order.desc }]
    : undefined;
  const res = await googleFetch<FreeReportResponse>(`${DATA_BASE}/properties/${id}:runReport`, {
    method: "POST",
    accessToken: await getGoogleAccessToken(),
    body: {
      dateRanges: request.dateRanges.map((r) => ({ startDate: r.startDate, endDate: r.endDate })),
      dimensions: request.dimensions.map((name) => ({ name })),
      metrics: request.metrics.map((name) => ({ name })),
      ...(filters.length === 1
        ? { dimensionFilter: ga4Filter(filters[0]!) }
        : filters.length > 1
          ? { dimensionFilter: { andGroup: { expressions: filters.map(ga4Filter) } } }
          : {}),
      ...(orderBys ? { orderBys } : {}),
      limit: request.limit,
    },
  });
  const rows = reportRows(res);
  return {
    currency: res.metadata?.currencyCode ?? "",
    dimensionHeaders: (res.dimensionHeaders ?? []).map((h) => h.name ?? ""),
    metricHeaders: (res.metricHeaders ?? []).map((h) => h.name ?? ""),
    rows: rows.map((row) => ({ dimensions: row.dims, metrics: row.values })),
    rowCount: Math.max(num(String(res.rowCount ?? 0)), rows.length),
  };
}
