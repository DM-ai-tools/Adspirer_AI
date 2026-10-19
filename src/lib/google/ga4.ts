import { googleFetch } from "./http";
import { getGoogleAccessToken } from "./oauth";
import type { DateRange, Ga4CategoryRevenue, Ga4Channel } from "./types";

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

/**
 * GA4 default channel group to the plan's channel. "Paid Other" counts as
 * search only when the session source is Google.
 */
export function ga4ChannelOf(channelGroup: string, source?: string): Ga4Channel {
  switch (channelGroup.trim()) {
    case "Paid Social":
      return "paid_social";
    case "Paid Search":
    case "Paid Shopping":
    case "Cross-network":
      return "paid_search";
    case "Paid Other":
      return source?.toLowerCase().includes("google") ? "paid_search" : "other";
    default:
      return "other";
  }
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
    rows: (res.rows ?? []).map((row) => ({
      dims: (row.dimensionValues ?? []).map((d) => d.value ?? ""),
      values: (row.metricValues ?? []).map((m) => num(m.value)),
    })),
  };
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
 * from the session landing page, channel group and source.
 *
 * Compatibility: itemCategory is item-scoped, so it pairs only with the
 * item-scoped itemRevenue and itemsPurchased. The landing page and channel
 * reports use session-scoped dimensions with the event-scoped purchaseRevenue
 * and ecommercePurchases (purchases only, not ad or subscription revenue).
 * They group by landingPage (the path alone): with the query string, every
 * fbclid/gclid would be its own row and paid traffic would spill into "(other)".
 */
export async function fetchGa4CategoryRevenue(propertyId: string, range: DateRange): Promise<Ga4CategoryRevenue> {
  const id = digits(propertyId);
  if (!id) throw new Error("GA4 property id must be numeric, e.g. properties/123456.");
  if (!DATE.test(range.since) || !DATE.test(range.until)) {
    throw new Error("GA4 date range must be YYYY-MM-DD.");
  }

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
    return { method: "item", currency: item.currency || channel.currency, rows: itemRows, byChannel, warnings };
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
