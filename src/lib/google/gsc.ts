import { googleFetch } from "./http";
import { getGoogleAccessToken } from "./oauth";
import type { DateRange, SearchDemand } from "./types";

/**
 * Read-only Search Console client (API v3): the site list and Search
 * Analytics queries. Nothing here writes to Google.
 */
const GSC_BASE = "https://www.googleapis.com/webmasters/v3";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOP_QUERIES = 5;

type SitesResponse = { siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }> };
type QueryResponse = {
  rows?: Array<{ keys?: string[]; clicks?: number | string; impressions?: number | string; position?: number | string }>;
};

/** Search Console sites the Google user can see, with their permission level. */
export async function listGscSites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>> {
  const res = await googleFetch<SitesResponse>(`${GSC_BASE}/sites`, {
    method: "GET",
    accessToken: await getGoogleAccessToken(),
  });
  return (res.siteEntry ?? [])
    .filter((site) => site.siteUrl)
    .map((site) => ({ siteUrl: site.siteUrl ?? "", permissionLevel: site.permissionLevel ?? "" }));
}

function num(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Organic search demand by page, with each page's top queries by clicks.
 * The site URL is percent-encoded into the path, so "sc-domain:example.com"
 * becomes "sc-domain%3Aexample.com".
 */
export async function fetchSearchDemand(siteUrl: string, range: DateRange): Promise<SearchDemand> {
  if (!DATE.test(range.since) || !DATE.test(range.until)) {
    throw new Error("Search Console date range must be YYYY-MM-DD.");
  }
  const accessToken = await getGoogleAccessToken();
  const url = `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const query = (dimensions: string[], rowLimit: number) =>
    googleFetch<QueryResponse>(url, {
      method: "POST",
      accessToken,
      body: { startDate: range.since, endDate: range.until, dimensions, rowLimit },
    });

  const [pages, pageQueries] = await Promise.all([query(["page"], 1000), query(["page", "query"], 5000)]);

  const queriesByPage = new Map<string, Array<{ query: string; clicks: number }>>();
  for (const row of pageQueries.rows ?? []) {
    const [page, text] = row.keys ?? [];
    if (!page || !text) continue;
    const list = queriesByPage.get(page) ?? [];
    list.push({ query: text, clicks: num(row.clicks) });
    queriesByPage.set(page, list);
  }

  return {
    siteUrl,
    rows: (pages.rows ?? [])
      .filter((row) => row.keys?.[0])
      .map((row) => {
        const page = row.keys?.[0] ?? "";
        const topQueries = [...(queriesByPage.get(page) ?? [])]
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, TOP_QUERIES)
          .map((entry) => entry.query);
        return {
          page,
          clicks: num(row.clicks),
          impressions: num(row.impressions),
          position: num(row.position),
          topQueries,
        };
      }),
  };
}
