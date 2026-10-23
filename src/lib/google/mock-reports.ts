import { GoogleApiError } from "./http";
import type {
  Ga4ReportRequest,
  Ga4ReportResult,
  Ga4StringFilter,
  SearchAnalyticsRequest,
  SearchAnalyticsResult,
} from "./types";

/**
 * Demo data for the free-form GA4 and Search Console tools (ClickTrends). The
 * item rows add up to the mock's category revenue (Bar Stools $7,000 from 92
 * items, Sofas $3,100 from 21) and the query rows to its Search Console pages.
 */

type Fact = { dims: Record<string, string>; metrics: Record<string, number> };

const BAR = "https://clicktrends.example/collections/bar-stools";
const SOFAS = "https://clicktrends.example/collections/sofas";

const item = (
  itemName: string,
  itemId: string,
  itemCategory: string,
  itemRevenue: number,
  itemsPurchased: number,
  itemsViewed: number,
  itemsAddedToCart: number,
): Fact => ({
  dims: { itemName, itemId, itemCategory, itemBrand: "ClickTrends" },
  metrics: { itemRevenue, itemsPurchased, itemsViewed, itemsAddedToCart },
});

const ITEMS: Fact[] = [
  item("Oak Counter Stool", "BS-OAK-01", "Bar Stools", 3200, 40, 1900, 260),
  item("Swivel Bar Stool (Black)", "BS-SWV-02", "Bar Stools", 2400, 32, 1500, 210),
  item("Backless Bar Stool", "BS-BKL-03", "Bar Stools", 1400, 20, 900, 120),
  item("Modern 3-Seater Sofa", "SF-MOD-01", "Sofas", 1900, 12, 800, 70),
  item("Velvet Loveseat", "SF-VLV-02", "Sofas", 1200, 9, 650, 55),
];

const session = (
  channel: string,
  source: string,
  medium: string,
  campaign: string,
  landingPage: string,
  deviceCategory: string,
  m: [sessions: number, users: number, newUsers: number, engaged: number, addToCarts: number, checkouts: number, revenue: number, purchases: number],
): Fact => ({
  dims: {
    sessionDefaultChannelGroup: channel,
    sessionSource: source,
    sessionMedium: medium,
    sessionSourceMedium: `${source} / ${medium}`,
    sessionCampaignName: campaign,
    landingPage,
    pagePath: landingPage,
    deviceCategory,
    country: "United States",
  },
  metrics: {
    sessions: m[0],
    totalUsers: m[1],
    newUsers: m[2],
    engagedSessions: m[3],
    addToCarts: m[4],
    checkouts: m[5],
    purchaseRevenue: m[6],
    totalRevenue: m[6],
    ecommercePurchases: m[7],
    keyEvents: m[7],
  },
});

const SESSIONS: Fact[] = [
  session("Paid Social", "facebook", "paid", "Bar Stools | Advantage+ | Sales", "/collections/bar-stools", "mobile", [4200, 3600, 3000, 2300, 380, 120, 3800, 46]),
  session("Paid Search", "google", "cpc", "Search | Bar stools", "/collections/bar-stools", "desktop", [2100, 1800, 1300, 1400, 210, 70, 2200, 28]),
  session("Organic Search", "google", "organic", "(organic)", "/collections/bar-stools", "mobile", [1200, 1050, 800, 700, 90, 25, 600, 8]),
  session("Paid Social", "instagram", "paid", "Sofas | Retargeting | Sales", "/collections/sofas", "mobile", [1800, 1500, 900, 1000, 120, 40, 1500, 11]),
  session("Paid Search", "google", "cpc", "PMax | Furniture", "/collections/sofas", "desktop", [900, 800, 500, 600, 70, 25, 1050, 7]),
  session("Direct", "(direct)", "(none)", "(direct)", "/", "desktop", [700, 650, 300, 420, 30, 10, 450, 4]),
];

/** Metrics worked out from the summed ones. */
const DERIVED: Record<string, (m: Record<string, number>) => number> = {
  averagePurchaseRevenue: (m) => (m.ecommercePurchases ? round(m.purchaseRevenue! / m.ecommercePurchases) : 0),
};

const round = (n: number) => Math.round(n * 100) / 100;

function tableFor(fields: string[]): Fact[] {
  const has = (table: Fact[], name: string) =>
    name in table[0]!.dims || name in table[0]!.metrics || (name in DERIVED && table === SESSIONS);
  for (const name of fields) {
    if (!has(ITEMS, name) && !has(SESSIONS, name)) {
      throw new GoogleApiError(`Field ${name} is not available in the demo GA4 data.`, 400, "INVALID_ARGUMENT");
    }
  }
  const table = fields.some((name) => has(ITEMS, name)) ? ITEMS : SESSIONS;
  const incompatible = fields.find((name) => !has(table, name));
  if (incompatible) {
    throw new GoogleApiError(
      `Please remove ${incompatible} to make the request compatible: item-scoped and session-scoped fields can't be mixed.`,
      400,
      "INVALID_ARGUMENT",
    );
  }
  return table;
}

function matches(value: string, filter: Ga4StringFilter): boolean {
  const v = value.toLowerCase();
  const want = filter.value.toLowerCase();
  if (filter.match === "exact") return v === want;
  if (filter.match === "begins_with") return v.startsWith(want);
  return v.includes(want);
}

export function mockGa4Report(request: Ga4ReportRequest, currency: string): Ga4ReportResult {
  const filters = request.dimensionFilter ?? [];
  const table = tableFor([...request.dimensions, ...request.metrics, ...filters.map((f) => f.dimension)]);
  const kept = table.filter((fact) => filters.every((f) => matches(fact.dims[f.dimension] ?? "", f)));
  const twoRanges = request.dateRanges.length > 1;
  const dimensionHeaders = [...request.dimensions, ...(twoRanges ? ["dateRange"] : [])];

  // The second range is the earlier period: the same rows at 85%.
  const groups = new Map<string, { dims: string[]; sums: Record<string, number> }>();
  request.dateRanges.forEach((_, rangeIndex) => {
    const scale = rangeIndex === 0 ? 1 : 0.85;
    for (const fact of kept) {
      const dims = [...request.dimensions.map((d) => fact.dims[d] ?? ""), ...(twoRanges ? [`date_range_${rangeIndex}`] : [])];
      const key = dims.join("\u0000");
      const group = groups.get(key) ?? { dims, sums: {} };
      for (const [name, value] of Object.entries(fact.metrics)) {
        group.sums[name] = (group.sums[name] ?? 0) + value * scale;
      }
      groups.set(key, group);
    }
  });

  const rows = [...groups.values()].map((g) => ({
    dimensions: g.dims,
    metrics: request.metrics.map((m) => round(DERIVED[m] ? DERIVED[m](g.sums) : (g.sums[m] ?? 0))),
  }));
  const order = request.orderBy ?? { field: request.metrics[0]!, desc: true };
  const metricAt = request.metrics.indexOf(order.field);
  const dimAt = request.dimensions.indexOf(order.field);
  rows.sort((a, b) => {
    const diff =
      metricAt >= 0
        ? a.metrics[metricAt]! - b.metrics[metricAt]!
        : dimAt >= 0
          ? a.dimensions[dimAt]!.localeCompare(b.dimensions[dimAt]!)
          : 0;
    return order.desc ? -diff : diff;
  });
  return {
    currency,
    dimensionHeaders,
    metricHeaders: [...request.metrics],
    rows: rows.slice(0, request.limit),
    rowCount: rows.length,
  };
}

const query = (q: string, page: string, device: string, clicks: number, impressions: number, position: number) => ({
  keys: { query: q, page, country: "usa", device },
  clicks,
  impressions,
  position,
});

const QUERIES = [
  query("bar stools", BAR, "MOBILE", 520, 12_000, 7.9),
  query("counter height bar stools", BAR, "DESKTOP", 260, 6_400, 8.8),
  query("swivel bar stools", BAR, "MOBILE", 240, 7_100, 9.1),
  query("backless bar stools", BAR, "DESKTOP", 220, 6_000, 8.6),
  query("sofas", SOFAS, "MOBILE", 300, 11_000, 12.4),
  query("modern sofa", SOFAS, "DESKTOP", 180, 6_800, 10.9),
  query("3 seater sofa", SOFAS, "MOBILE", 130, 5_000, 11.2),
];

export function mockSearchAnalytics(request: SearchAnalyticsRequest): SearchAnalyticsResult {
  const keyOf = (row: (typeof QUERIES)[number], dimension: string) =>
    dimension === "date" ? request.endDate : row.keys[dimension as keyof typeof row.keys];
  const kept = QUERIES.filter((row) =>
    (request.filters ?? []).every((f) => {
      const value = keyOf(row, f.dimension).toLowerCase();
      const want = f.expression.toLowerCase();
      if (f.operator === "equals") return value === want;
      if (f.operator === "notEquals") return value !== want;
      if (f.operator === "notContains") return !value.includes(want);
      return value.includes(want);
    }),
  );
  const groups = new Map<string, { keys: string[]; clicks: number; impressions: number; weighted: number }>();
  for (const row of kept) {
    const keys = request.dimensions.map((d) => keyOf(row, d));
    const key = keys.join("\u0000");
    const group = groups.get(key) ?? { keys, clicks: 0, impressions: 0, weighted: 0 };
    group.clicks += row.clicks;
    group.impressions += row.impressions;
    group.weighted += row.position * row.impressions;
    groups.set(key, group);
  }
  return {
    rows: [...groups.values()]
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, request.rowLimit)
      .map((g) => ({
        keys: g.keys,
        clicks: g.clicks,
        impressions: g.impressions,
        ctr: g.impressions ? Math.round((g.clicks / g.impressions) * 10_000) / 10_000 : 0,
        position: g.impressions ? Math.round((g.weighted / g.impressions) * 10) / 10 : 0,
      })),
  };
}
