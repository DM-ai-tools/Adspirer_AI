import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The 403 below is expected; keep the suite's output clean.
vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/google/oauth", () => ({
  getGoogleAccessToken: async () => "access-token",
}));

import { fetchGa4CategoryRevenue, fetchGa4LandingPages, ga4ChannelOf, listGa4Properties } from "@/lib/google/ga4";
import { fetchSearchDemand, listGscSites } from "@/lib/google/gsc";

type Body = {
  dimensions?: Array<{ name: string }>;
  metrics?: Array<{ name: string }>;
  dateRanges?: Array<{ startDate: string; endDate: string }>;
  limit?: number;
  startDate?: string;
  endDate?: string;
  rowLimit?: number;
};
type Call = { url: string; method: string; headers: Record<string, string>; body: Body | null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;

function route(handler: (call: Call) => Response) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? (JSON.parse(String(init.body)) as Body) : null,
    };
    calls.push(call);
    return handler(call);
  });
}

const RANGE = { since: "2026-09-01", until: "2026-09-30" };

/** A GA4 runReport response from rows of [dimension values..., metric values...]. */
function report(
  dimensionCount: number,
  rows: string[][],
  extra: { dataLossFromOtherRow?: boolean; rowCount?: number } = {},
) {
  return json({
    rows: rows.map((row) => ({
      dimensionValues: row.slice(0, dimensionCount).map((value) => ({ value })),
      metricValues: row.slice(dimensionCount).map((value) => ({ value })),
    })),
    rowCount: extra.rowCount ?? rows.length,
    metadata: { currencyCode: "AUD", dataLossFromOtherRow: extra.dataLossFromOtherRow ?? false },
  });
}

const dims = (call: Call) => (call.body?.dimensions ?? []).map((d) => d.name).join(",");

type ReportExtra = { dataLossFromOtherRow?: boolean; rowCount?: number };

/** Routes the three GA4 reports by their dimensions. */
function ga4Reports(
  reports: { item?: string[][]; landing?: string[][]; channel?: string[][] },
  extra: { item?: ReportExtra; landing?: ReportExtra; channel?: ReportExtra } = {},
) {
  route((call) => {
    switch (dims(call)) {
      case "itemCategory":
        return report(1, reports.item ?? [], extra.item);
      case "landingPage":
        return report(1, reports.landing ?? [], extra.landing);
      case "landingPage,sessionDefaultChannelGroup,sessionSource":
        return report(3, reports.channel ?? [], extra.channel);
      default:
        throw new Error(`unexpected report ${dims(call)}`);
    }
  });
}

beforeEach(() => {
  calls = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Read-only guard: only list/get calls, report reads and search analytics queries.
  for (const call of calls) {
    expect(call.headers.Authorization).toBe("Bearer access-token");
    expect(call.url).not.toContain("access-token");
    expect(call.url).toMatch(/(accountSummaries|properties\/\d+|:runReport|webmasters\/v3\/sites(\/[^/]+\/searchAnalytics\/query)?)(\?.*)?$/);
  }
});

describe("ga4ChannelOf", () => {
  it("maps each listed channel group", () => {
    expect(ga4ChannelOf("Paid Social", "facebook")).toBe("paid_social");
    expect(ga4ChannelOf("Paid Search", "google")).toBe("paid_search");
    expect(ga4ChannelOf("Paid Shopping", "google")).toBe("paid_search");
    expect(ga4ChannelOf("Cross-network", "google")).toBe("paid_search");
    expect(ga4ChannelOf("Paid Other", "google")).toBe("paid_search");
    expect(ga4ChannelOf("Paid Other", "Google Ads")).toBe("paid_search");
    expect(ga4ChannelOf("Paid Other", "bing")).toBe("other");
    expect(ga4ChannelOf("Paid Other")).toBe("other");
    expect(ga4ChannelOf("Organic Search")).toBe("other");
    expect(ga4ChannelOf("Direct")).toBe("other");
    expect(ga4ChannelOf("Organic Social")).toBe("other");
    expect(ga4ChannelOf("Unassigned")).toBe("other");
  });

  it("counts paid social only for Facebook, Instagram and Meta sources", () => {
    for (const source of ["facebook", "Instagram", "fb", "IG", "meta", "m.facebook.com", "l.facebook.com", "facebook.com"]) {
      expect(ga4ChannelOf("Paid Social", source), source).toBe("paid_social");
    }
    expect(ga4ChannelOf("Paid Other", "instagram")).toBe("paid_social");
    for (const source of ["tiktok", "pinterest", "linkedin", "reddit", "snapchat", "digital-partner"]) {
      expect(ga4ChannelOf("Paid Social", source), source).toBe("other");
    }
    expect(ga4ChannelOf("Paid Social")).toBe("other");
    // Organic Facebook traffic is not paid social.
    expect(ga4ChannelOf("Organic Social", "facebook")).toBe("other");
  });

  it("counts paid search only when the source is Google", () => {
    for (const group of ["Paid Search", "Paid Shopping", "Cross-network", "Paid Other"]) {
      expect(ga4ChannelOf(group, "google"), group).toBe("paid_search");
      expect(ga4ChannelOf(group, "Google Ads"), group).toBe("paid_search");
      expect(ga4ChannelOf(group, "bing"), group).toBe("other");
      expect(ga4ChannelOf(group), group).toBe("other");
    }
    expect(ga4ChannelOf("Paid Search", "duckduckgo")).toBe("other");
    expect(ga4ChannelOf("Organic Search", "google")).toBe("other");
  });
});

describe("fetchGa4CategoryRevenue", () => {
  it("converts item rows to cents and uses the item method", async () => {
    ga4Reports({
      item: [
        ["Sofas", "1234.56", "7"],
        ["Bar stools", "99.99", "3"],
        ["(not set)", "50", "1"],
        ["Rugs", "0", "0"],
      ],
    });

    const result = await fetchGa4CategoryRevenue("properties/123", RANGE);

    expect(result.method).toBe("item");
    expect(result.currency).toBe("AUD");
    expect(result.rows).toEqual([
      { key: "Sofas", revenueCents: 123456, purchases: 7 },
      { key: "Bar stools", revenueCents: 9999, purchases: 3 },
    ]);

    const item = calls.find((call) => dims(call) === "itemCategory");
    expect(item?.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123:runReport");
    expect(item?.method).toBe("POST");
    expect(item?.body?.metrics?.map((m) => m.name)).toEqual(["itemRevenue", "itemsPurchased"]);
    expect(item?.body?.dateRanges).toEqual([{ startDate: "2026-09-01", endDate: "2026-09-30" }]);
    expect(item?.body?.limit).toBe(10000);
    // The landing-page report is only a fallback.
    expect(calls.some((call) => dims(call) === "landingPage")).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to landing pages when the item report has no revenue", async () => {
    ga4Reports({
      item: [["(not set)", "0", "0"]],
      landing: [
        ["/sofas?utm_source=meta", "300.5", "2"],
        ["/sofas#reviews", "100", "1"],
        ["/bar-stools", "80", "1"],
        ["(not set)", "999", "9"],
      ],
    });

    const result = await fetchGa4CategoryRevenue("123", RANGE);

    expect(result.method).toBe("landing_page");
    expect(result.rows).toEqual([
      { key: "/sofas", revenueCents: 40050, purchases: 3 },
      { key: "/bar-stools", revenueCents: 8000, purchases: 1 },
    ]);
    const landing = calls.find((call) => dims(call) === "landingPage");
    expect(landing?.body?.metrics?.map((m) => m.name)).toEqual(["purchaseRevenue", "ecommercePurchases"]);
    expect(landing?.body?.limit).toBe(10000);
  });

  it("gives method none when both revenue reports are empty, keeping byChannel", async () => {
    ga4Reports({
      item: [],
      landing: [["/sofas", "0", "0"]],
      channel: [["/sofas", "Paid Social", "facebook", "0"]],
    });

    const result = await fetchGa4CategoryRevenue("123", RANGE);

    expect(result.method).toBe("none");
    expect(result.rows).toEqual([]);
    expect(result.byChannel).toEqual([{ landingPage: "/sofas", channel: "paid_social", revenueCents: 0 }]);
  });

  it("builds byChannel from landing page, channel group and source, stripping query strings", async () => {
    ga4Reports({
      item: [["Sofas", "500", "2"]],
      channel: [
        ["/sofas?fbclid=abc", "Paid Social", "facebook", "200"],
        ["/sofas?fbclid=def", "Paid Social", "instagram", "50.25"],
        ["/sofas?gclid=x", "Paid Search", "google", "150"],
        ["/sofas", "Paid Other", "google", "10"],
        ["/sofas", "Paid Other", "taboola", "5"],
        ["/bar-stools#top", "Organic Search", "google", "40"],
        ["(not set)", "Direct", "(direct)", "70"],
      ],
    });

    const result = await fetchGa4CategoryRevenue("123", RANGE);

    expect(result.byChannel).toEqual([
      { landingPage: "/sofas", channel: "paid_social", revenueCents: 25025 },
      { landingPage: "/sofas", channel: "paid_search", revenueCents: 16000 },
      { landingPage: "/sofas", channel: "other", revenueCents: 500 },
      { landingPage: "/bar-stools", channel: "other", revenueCents: 4000 },
    ]);
    const channel = calls.find((call) => dims(call).includes("sessionDefaultChannelGroup"));
    // The path alone: with the query string every fbclid/gclid would be its own row.
    expect(dims(channel!)).toBe("landingPage,sessionDefaultChannelGroup,sessionSource");
    expect(calls.every((call) => !dims(call).includes("landingPagePlusQueryString"))).toBe(true);
    expect(channel?.body?.metrics?.map((m) => m.name)).toEqual(["purchaseRevenue"]);
    expect(channel?.body?.limit).toBe(10000);
  });

  it("warns when GA4 grouped channel rows into (other)", async () => {
    ga4Reports(
      { item: [["Sofas", "500", "2"]], channel: [["/sofas", "Paid Social", "facebook", "200"]] },
      { channel: { dataLossFromOtherRow: true } },
    );

    const result = await fetchGa4CategoryRevenue("123", RANGE);

    expect(result.warnings).toEqual([
      "GA4 grouped some landing pages into (other); per-channel figures may be understated",
    ]);
  });

  it("warns when a report has more rows than the limit returned", async () => {
    ga4Reports(
      { item: [], landing: [["/sofas", "100", "1"]], channel: [["/sofas", "Paid Search", "google", "100"]] },
      { landing: { rowCount: 12000 }, channel: { rowCount: 10001 } },
    );

    const result = await fetchGa4CategoryRevenue("123", RANGE);

    expect(result.method).toBe("landing_page");
    expect(result.warnings).toEqual([
      "GA4 grouped some landing pages into (other); per-channel figures may be understated",
      "GA4 grouped some landing pages into (other); landing page figures may be understated",
    ]);
  });

  it("drops placeholder rows even with surrounding whitespace", async () => {
    ga4Reports({
      item: [[" (not set) ", "50", "1"], ["(other) ", "40", "1"], ["Sofas", "10", "1"]],
      channel: [[" (not set)", "Direct", "(direct)", "70"], ["/sofas", "Direct", "(direct)", "10"]],
    });

    const result = await fetchGa4CategoryRevenue("123", RANGE);

    expect(result.rows).toEqual([{ key: "Sofas", revenueCents: 1000, purchases: 1 }]);
    expect(result.byChannel).toEqual([{ landingPage: "/sofas", channel: "other", revenueCents: 1000 }]);
  });

  it("rejects an empty property id before calling Google", async () => {
    ga4Reports({});
    await expect(fetchGa4CategoryRevenue("properties/", RANGE)).rejects.toThrow(/property id/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed date range before calling Google", async () => {
    ga4Reports({});
    await expect(fetchGa4CategoryRevenue("123", { since: "2026-9-1", until: "2026-09-30" })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("fetchGa4LandingPages", () => {
  it("reads purchase revenue and purchases by landing path, one read-only report", async () => {
    ga4Reports(
      {
        landing: [
          ["/collections/sofas?fbclid=x", "300.5", "2"],
          ["/collections/sofas", "100", "1"],
          ["/collections/rugs", "0", "0"],
          ["(not set)", "999", "9"],
        ],
      },
      { landing: { dataLossFromOtherRow: true } },
    );
    const result = await fetchGa4LandingPages("properties/123", RANGE);
    expect(result).toEqual({
      currency: "AUD",
      rows: [{ path: "/collections/sofas", revenueCents: 40050, purchases: 3 }],
      warnings: ["GA4 grouped some landing pages into (other); landing page figures may be understated"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/properties/123:runReport");
    expect(calls[0]!.body?.metrics?.map((m) => m.name)).toEqual(["purchaseRevenue", "ecommercePurchases"]);
  });

  it("rejects a malformed date range before calling Google", async () => {
    ga4Reports({});
    await expect(fetchGa4LandingPages("123", { since: "2026-9-1", until: "2026-09-30" })).rejects.toThrow(/YYYY-MM-DD/);
    expect(calls).toHaveLength(0);
  });
});

describe("listGa4Properties", () => {
  it("follows accountSummaries pages and reads each property's currency and time zone", async () => {
    route((call) => {
      if (call.url.includes("accountSummaries")) {
        if (!call.url.includes("pageToken=")) {
          return json({
            accountSummaries: [
              {
                account: "accounts/1",
                displayName: "ClickTrends",
                propertySummaries: [{ property: "properties/111", displayName: "ClickTrends Store" }],
              },
            ],
            nextPageToken: "page 2",
          });
        }
        return json({
          accountSummaries: [
            {
              account: "accounts/2",
              displayName: "Other Co",
              propertySummaries: [
                { property: "properties/222", displayName: "Other Site" },
                { property: "properties/333", displayName: "Other App" },
              ],
            },
            { account: "accounts/3", displayName: "Empty account" },
          ],
        });
      }
      if (call.url.endsWith("/properties/111")) return json({ currencyCode: "AUD", timeZone: "Australia/Sydney" });
      if (call.url.endsWith("/properties/222")) return json({ currencyCode: "USD", timeZone: "America/New_York" });
      return json({ error: { message: "Forbidden", status: "PERMISSION_DENIED" } }, 403);
    });

    const properties = await listGa4Properties();

    expect(properties).toEqual([
      { propertyId: "111", name: "ClickTrends Store", accountName: "ClickTrends", currency: "AUD", timezone: "Australia/Sydney" },
      { propertyId: "222", name: "Other Site", accountName: "Other Co", currency: "USD", timezone: "America/New_York" },
      { propertyId: "333", name: "Other App", accountName: "Other Co", currency: null, timezone: null },
    ]);

    const pages = calls.filter((call) => call.url.includes("accountSummaries"));
    expect(pages).toHaveLength(2);
    expect(pages[0].url).toMatch(/^https:\/\/analyticsadmin\.googleapis\.com\/v1beta\/accountSummaries\?/);
    expect(new URL(pages[1].url).searchParams.get("pageToken")).toBe("page 2");
    expect(calls.find((call) => call.url.endsWith("/properties/111"))?.url).toBe(
      "https://analyticsadmin.googleapis.com/v1beta/properties/111",
    );
  });
});

describe("listGscSites", () => {
  it("returns site URLs and permission levels", async () => {
    route(() =>
      json({
        siteEntry: [
          { siteUrl: "sc-domain:clicktrends.com.au", permissionLevel: "siteOwner" },
          { siteUrl: "https://www.clicktrends.com.au/", permissionLevel: "siteFullUser" },
        ],
      }),
    );

    expect(await listGscSites()).toEqual([
      { siteUrl: "sc-domain:clicktrends.com.au", permissionLevel: "siteOwner" },
      { siteUrl: "https://www.clicktrends.com.au/", permissionLevel: "siteFullUser" },
    ]);
    expect(calls[0].url).toBe("https://www.googleapis.com/webmasters/v3/sites");
    expect(calls[0].method).toBe("GET");
  });

  it("gives an empty list when there are no sites", async () => {
    route(() => json({}));
    expect(await listGscSites()).toEqual([]);
  });
});

describe("fetchSearchDemand", () => {
  it("returns pages with clicks, impressions, position and the top 5 queries by clicks", async () => {
    route((call) => {
      if (call.body?.dimensions?.join(",") === "page") {
        return json({
          rows: [
            { keys: ["https://clicktrends.com.au/sofas"], clicks: 120, impressions: 4000, ctr: 0.03, position: 6.4 },
            { keys: ["https://clicktrends.com.au/bar-stools"], clicks: 30, impressions: 900, ctr: 0.033, position: 11.2 },
          ],
        });
      }
      return json({
        rows: [
          { keys: ["https://clicktrends.com.au/sofas", "sofa bed"], clicks: 10, impressions: 100, position: 5 },
          { keys: ["https://clicktrends.com.au/sofas", "corner sofa"], clicks: 40, impressions: 300, position: 3 },
          { keys: ["https://clicktrends.com.au/sofas", "leather sofa"], clicks: 25, impressions: 200, position: 4 },
          { keys: ["https://clicktrends.com.au/sofas", "sofas sydney"], clicks: 30, impressions: 250, position: 2 },
          { keys: ["https://clicktrends.com.au/sofas", "cheap sofa"], clicks: 5, impressions: 500, position: 9 },
          { keys: ["https://clicktrends.com.au/sofas", "modular sofa"], clicks: 8, impressions: 90, position: 7 },
          { keys: ["https://clicktrends.com.au/bar-stools", "bar stools"], clicks: 20, impressions: 600, position: 10 },
        ],
      });
    });

    const demand = await fetchSearchDemand("https://clicktrends.com.au/", RANGE);

    expect(demand).toEqual({
      siteUrl: "https://clicktrends.com.au/",
      rows: [
        {
          page: "https://clicktrends.com.au/sofas",
          clicks: 120,
          impressions: 4000,
          position: 6.4,
          topQueries: ["corner sofa", "sofas sydney", "leather sofa", "sofa bed", "modular sofa"],
        },
        { page: "https://clicktrends.com.au/bar-stools", clicks: 30, impressions: 900, position: 11.2, topQueries: ["bar stools"] },
      ],
    });

    const page = calls.find((call) => call.body?.dimensions?.join(",") === "page");
    expect(page?.method).toBe("POST");
    expect(page?.body).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-30", rowLimit: 1000 });
    const pageQuery = calls.find((call) => call.body?.dimensions?.join(",") === "page,query");
    expect(pageQuery?.body).toMatchObject({ startDate: "2026-09-01", endDate: "2026-09-30", rowLimit: 5000 });
  });

  it("percent-encodes an sc-domain: site URL in the path", async () => {
    route(() => json({ rows: [] }));

    const demand = await fetchSearchDemand("sc-domain:clicktrends.com.au", RANGE);

    expect(demand).toEqual({ siteUrl: "sc-domain:clicktrends.com.au", rows: [] });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe(
        "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aclicktrends.com.au/searchAnalytics/query",
      );
    }
  });

  it("rejects a malformed date range before calling Google", async () => {
    route(() => json({ rows: [] }));
    await expect(fetchSearchDemand("sc-domain:x.com", { since: "2026-09-01", until: "30/09/2026" })).rejects.toThrow(
      /YYYY-MM-DD/,
    );
    expect(calls).toHaveLength(0);
  });
});
