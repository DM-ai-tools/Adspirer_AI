import { afterEach, describe, expect, it, vi } from "vitest";

// The live GA4 / Search Console requests below are checked against a fake fetch.
vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/oauth")>();
  return { ...actual, getGoogleAccessToken: async () => "access-token" };
});
vi.mock("@/lib/google/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/provider")>();
  return { ...actual, getGoogleDataProvider: vi.fn(actual.getGoogleDataProvider) };
});
vi.mock("@/lib/observability/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  buildWorkspaceReadToolSet,
  workspaceReadToolNames,
  writerHasTools,
} from "@/lib/agent/diagnose-tools-ai";
import { buildClientContext } from "@/lib/agent/context-builder";
import { buildStaticSystemPromptV2 } from "@/lib/agent/prompts-v2";
import { detectRequestIntent } from "@/lib/agent/task-plan";
import { getDemoStore } from "@/lib/demo/store";
import { runGa4Report } from "@/lib/google/ga4";
import { querySearchAnalytics } from "@/lib/google/gsc";
import { GoogleApiError } from "@/lib/google/http";
import { getMockGoogleDataProvider } from "@/lib/google/mock-provider";
import { GoogleReconnectRequired } from "@/lib/google/oauth";
import { getGoogleDataProvider } from "@/lib/google/provider";
import { classify } from "@/lib/tools/policy";
import { humanToolLabel, humanToolProgressLabel } from "@/lib/tools/display-labels";
import { invokeTool, type ToolContext } from "@/lib/tools/registry";
import "@/lib/tools/diagnose";

const CT = "client_clicktrends";
const TR = "client_trafficradius";
const ctx = (clientId: string): ToolContext => ({ clientId, userId: "user_admin", taskId: "task_x" });
const NEW_TOOLS = ["ga4_report", "search_console_query", "google_ads_report", "meta_insights", "list_client_categories"];

type Result = Record<string, unknown> & { rows?: Array<Record<string, unknown>> };
const call = async (name: string, args: unknown, clientId = CT) => (await invokeTool(name, args, ctx(clientId))) as Result;

afterEach(() => {
  vi.mocked(getGoogleDataProvider).mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BEST_SELLERS = {
  dimensions: ["itemName"],
  metrics: ["itemRevenue", "itemsPurchased"],
  date_ranges: [{ start_date: "30daysAgo", end_date: "yesterday" }],
  order_by: { field: "itemRevenue", desc: true },
  limit: 10,
};

describe("policy and labels", () => {
  it("classifies every new tool as diagnose and gives it a label", () => {
    for (const name of NEW_TOOLS) {
      expect(classify(name), name).toBe("diagnose");
      expect(humanToolLabel(name), name).not.toMatch(/_/);
      expect(humanToolProgressLabel(name), name).toMatch(/…$/);
    }
  });
});

describe("ga4_report", () => {
  it("answers best-selling products from the demo GA4 data", async () => {
    const out = await call("ga4_report", BEST_SELLERS);
    expect(out.source).toBe("GA4");
    expect(out.currency).toBe("USD");
    expect(out.rows?.[0]).toEqual({ itemName: "Oak Counter Stool", itemRevenue: 3200, itemsPurchased: 40 });
    const revenues = (out.rows ?? []).map((r) => r.itemRevenue as number);
    expect([...revenues].sort((a, b) => b - a)).toEqual(revenues);
  });

  it("filters, orders by a dimension and cuts rows with a note", async () => {
    const out = await call("ga4_report", {
      dimensions: ["itemName", "itemCategory"],
      metrics: ["itemRevenue"],
      date_ranges: [{ start_date: "2026-09-01", end_date: "2026-09-30" }],
      dimension_filter: { dimension: "itemCategory", match: "exact", value: "Bar Stools" },
      order_by: { field: "itemName", desc: false },
      limit: 2,
    });
    expect(out.rows?.map((r) => r.itemName)).toEqual(["Backless Bar Stool", "Oak Counter Stool"]);
    expect(out.row_count).toBe(3);
    expect(String(out.note)).toMatch(/2 of 3/);
  });

  it("validates names, counts, dates and the limit", async () => {
    const bad = [
      { ...BEST_SELLERS, dimensions: ["item name"] },
      { ...BEST_SELLERS, metrics: ["itemRevenue; drop"] },
      { ...BEST_SELLERS, dimensions: ["a", "b", "c", "d", "e", "f", "g"] },
      { ...BEST_SELLERS, metrics: Array.from({ length: 11 }, (_, i) => `m${i}`) },
      { ...BEST_SELLERS, metrics: [] },
      { ...BEST_SELLERS, date_ranges: [] },
      { ...BEST_SELLERS, date_ranges: [{ start_date: "last month", end_date: "today" }] },
      { ...BEST_SELLERS, date_ranges: [1, 2, 3].map(() => ({ start_date: "7daysAgo", end_date: "today" })) },
      { ...BEST_SELLERS, limit: 251 },
    ];
    for (const args of bad) await expect(call("ga4_report", args), JSON.stringify(args)).rejects.toThrow();
  });

  it("reads only the task client's property, whatever the model passes", async () => {
    const out = await call("ga4_report", { ...BEST_SELLERS, property_id: "properties/demo-ga4" }, TR);
    expect(out.error).toBe(true);
    expect(String(out.message)).toMatch(/No GA4 property is mapped/);
    expect(String(out.message)).toMatch(/Admin → Connections/);
  });

  it("returns GA4's own error message to the model", async () => {
    const base = getMockGoogleDataProvider();
    vi.mocked(getGoogleDataProvider).mockReturnValue({
      ...base,
      ga4Report: async () => {
        throw new GoogleApiError("Field itemNam is not a valid dimension.", 400, "INVALID_ARGUMENT");
      },
    });
    const out = await call("ga4_report", { ...BEST_SELLERS, dimensions: ["itemNam"] });
    expect(out).toMatchObject({ error: true, source: "GA4", message: "Field itemNam is not a valid dimension." });
  });

  it("says Google needs reconnecting instead of throwing", async () => {
    const base = getMockGoogleDataProvider();
    vi.mocked(getGoogleDataProvider).mockReturnValue({
      ...base,
      ga4Report: async () => {
        throw new GoogleReconnectRequired();
      },
    });
    const out = await call("ga4_report", BEST_SELLERS);
    expect(out.error).toBe(true);
    expect(String(out.message)).toMatch(/reconnect/i);
  });

  it("rejects an unknown field in the demo data the way GA4 would", async () => {
    const out = await call("ga4_report", { ...BEST_SELLERS, dimensions: ["itemNam"] });
    expect(out.error).toBe(true);
    expect(String(out.message)).toMatch(/itemNam/);
  });
});

describe("live GA4 and Search Console requests", () => {
  type Sent = { url: string; body: Record<string, unknown> };
  function fakeFetch(response: unknown, status = 200) {
    const sent: Sent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        return new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } });
      }),
    );
    return sent;
  }

  it("builds a runReport with filters, order and limit, and reads the headers back", async () => {
    const sent = fakeFetch({
      dimensionHeaders: [{ name: "itemName" }],
      metricHeaders: [{ name: "itemRevenue" }],
      rows: [{ dimensionValues: [{ value: "Oak Stool" }], metricValues: [{ value: "12.5" }] }],
      rowCount: 40,
      metadata: { currencyCode: "AUD" },
    });
    const out = await runGa4Report("properties/123", {
      dimensions: ["itemName"],
      metrics: ["itemRevenue"],
      dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
      dimensionFilter: [
        { dimension: "itemCategory", match: "contains", value: "stool" },
        { dimension: "country", match: "exact", value: "Australia" },
      ],
      orderBy: { field: "itemRevenue", desc: true },
      limit: 25,
    });
    expect(sent[0]!.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123:runReport");
    expect(sent[0]!.body).toMatchObject({
      dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "itemName" }],
      metrics: [{ name: "itemRevenue" }],
      orderBys: [{ metric: { metricName: "itemRevenue" }, desc: true }],
      limit: 25,
      dimensionFilter: {
        andGroup: {
          expressions: [
            { filter: { fieldName: "itemCategory", stringFilter: { matchType: "CONTAINS", value: "stool", caseSensitive: false } } },
            { filter: { fieldName: "country", stringFilter: { matchType: "EXACT", value: "Australia", caseSensitive: false } } },
          ],
        },
      },
    });
    expect(out).toEqual({
      currency: "AUD",
      dimensionHeaders: ["itemName"],
      metricHeaders: ["itemRevenue"],
      rows: [{ dimensions: ["Oak Stool"], metrics: [12.5] }],
      rowCount: 40,
    });
  });

  it("passes GA4's error message through", async () => {
    fakeFetch({ error: { code: 400, message: "Field itemNam is not a valid dimension.", status: "INVALID_ARGUMENT" } }, 400);
    await expect(
      runGa4Report("properties/123", {
        dimensions: ["itemNam"],
        metrics: ["itemRevenue"],
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        limit: 10,
      }),
    ).rejects.toThrow("Field itemNam is not a valid dimension.");
  });

  it("builds a Search Analytics query with filters", async () => {
    const sent = fakeFetch({ rows: [{ keys: ["bar stools"], clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 }] });
    const out = await querySearchAnalytics("sc-domain:example.com", {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["query"],
      filters: [{ dimension: "query", operator: "contains", expression: "stool" }],
      rowLimit: 50,
    });
    expect(sent[0]!.url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
    );
    expect(sent[0]!.body).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["query"],
      rowLimit: 50,
      dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension: "query", operator: "contains", expression: "stool" }] }],
    });
    expect(out.rows).toEqual([{ keys: ["bar stools"], clicks: 10, impressions: 100, ctr: 0.1, position: 4.2 }]);
  });
});

describe("search_console_query", () => {
  it("returns demo queries matching a filter", async () => {
    const out = await call("search_console_query", {
      dimensions: ["query"],
      start_date: "28daysAgo",
      end_date: "yesterday",
      filters: [{ dimension: "query", operator: "contains", expression: "bar" }],
      row_limit: 20,
    });
    expect(out.source).toBe("Search Console");
    expect(out.rows?.length).toBeGreaterThan(0);
    for (const r of out.rows ?? []) expect(String(r.query)).toMatch(/bar/);
  });

  it("validates dimensions and the row limit", async () => {
    await expect(call("search_console_query", { dimensions: ["keyword"], start_date: "2026-09-01", end_date: "2026-09-30" })).rejects.toThrow();
    await expect(
      call("search_console_query", { dimensions: ["query"], start_date: "2026-09-01", end_date: "2026-09-30", row_limit: 501 }),
    ).rejects.toThrow();
  });

  it("says what to map when no site is mapped", async () => {
    const out = await call("search_console_query", { dimensions: ["query"], start_date: "2026-09-01", end_date: "2026-09-30" }, TR);
    expect(out.error).toBe(true);
    expect(String(out.message)).toMatch(/No Search Console site is mapped.*Admin → Connections/);
  });
});

describe("google_ads_report", () => {
  it("returns campaigns, landing pages and product types in major units", async () => {
    const out = await call("google_ads_report", { start_date: "30daysAgo", end_date: "yesterday" });
    expect(out.source).toBe("Google Ads");
    expect(out.currency).toBe("USD");
    const campaigns = out.campaigns as Array<Record<string, unknown>>;
    expect(campaigns.find((c) => c.name === "Search | Bar stools")).toMatchObject({ cost: 850, conversion_value: 2400 });
    expect(out.shopping_product_types).toBeDefined();
    expect(out.landing_pages).toBeDefined();
  });

  it("returns only the sections asked for", async () => {
    const out = await call("google_ads_report", { start_date: "2026-09-01", end_date: "2026-09-30", sections: ["campaigns"] });
    expect(out.campaigns).toBeDefined();
    expect(out.landing_pages).toBeUndefined();
  });

  it("says what to map when no account is mapped", async () => {
    const out = await call("google_ads_report", { start_date: "2026-09-01", end_date: "2026-09-30" }, TR);
    expect(out.error).toBe(true);
    expect(String(out.message)).toMatch(/No Google Ads account is mapped.*Admin → Connections/);
  });
});

describe("meta_insights", () => {
  it("reads ad-level spend for the client's own Meta account", async () => {
    const out = await call("meta_insights", { level: "ad", date_preset: "last_30d" });
    expect(out.source).toBe("Meta");
    expect(out.account_id).toBe("act_700800900");
    expect(out.rows?.length).toBeGreaterThan(0);
    for (const r of out.rows ?? []) expect(r).toHaveProperty("spend");
    expect(out.rows?.[0]).toHaveProperty("ad_name");
  });

  it("breaks spend down by product_id for catalog ads", async () => {
    const out = await call("meta_insights", {
      level: "account",
      fields: ["spend", "impressions"],
      breakdowns: ["product_id"],
      time_range: { since: "2026-09-01", until: "2026-09-30" },
    });
    const ids = (out.rows ?? []).map((r) => r.product_id);
    expect(ids).toContain("BS-OAK-01");
  });

  it("validates fields, breakdowns and dates", async () => {
    await expect(call("meta_insights", { level: "ad", fields: ["spend,impressions"] })).rejects.toThrow();
    await expect(call("meta_insights", { level: "ad", breakdowns: ["age gender"] })).rejects.toThrow();
    await expect(call("meta_insights", { level: "ad", time_range: { since: "last month", until: "today" } })).rejects.toThrow();
    await expect(call("meta_insights", { level: "everything" })).rejects.toThrow();
    await expect(call("meta_insights", { level: "ad", limit: 501 })).rejects.toThrow();
  });

  it("never reads another client's account and says what to map without one", async () => {
    getDemoStore().connectedMetaAccounts = getDemoStore().connectedMetaAccounts.filter((a) => a.client_id !== TR);
    const out = await call("meta_insights", { level: "campaign", account_id: "act_700800900" }, TR);
    expect(out.error).toBe(true);
    expect(String(out.message)).toMatch(/No Meta ad account is mapped.*Admin → Connections/);
  });
});

describe("list_client_categories", () => {
  it("lists the client's categories with landing page, margin, order value and status", async () => {
    const out = await call("list_client_categories", {});
    const categories = out.categories as Array<Record<string, unknown>>;
    expect(categories.map((c) => c.name)).toEqual(expect.arrayContaining(["Bar stools", "Sofas"]));
    for (const c of categories) {
      expect(c).toHaveProperty("landing_page_url");
      expect(c).toHaveProperty("gross_margin_pct");
      expect(c).toHaveProperty("average_order_value");
      expect(c).toHaveProperty("active");
    }
  });
});

describe("writer tool set", () => {
  it("has the audit tools plus the new read tools, and nothing that writes", () => {
    const tools = buildWorkspaceReadToolSet(ctx(CT));
    const names = Object.keys(tools);
    for (const name of [...NEW_TOOLS, "get_meta_ad_creatives", "list_campaigns", "analyze_landing_pages"]) {
      expect(names, name).toContain(name);
    }
    for (const name of names) expect(classify(name), name).toBe("diagnose");
    expect(names).not.toContain("update_client_settings");
    expect(workspaceReadToolNames().sort()).toEqual(names.sort());
  });

  it("is given to the writer on every question intent and on the image / campaign flows, not on the fixed copy and scrape flows", () => {
    for (const intent of ["general", "chat", "audit", "strategy", "budget", "list_campaigns", "export", "optimize", "generate_creatives", "create_campaign"] as const) {
      expect(writerHasTools(intent), intent).toBe(true);
    }
    for (const intent of ["ad_copy", "scrape_services", "copy_approved"] as const) {
      expect(writerHasTools(intent), intent).toBe(false);
    }
  });

  it("keeps the Meta tools on the client's own account", async () => {
    const tools = buildWorkspaceReadToolSet(ctx(TR));
    const execute = tools.list_campaigns!.execute! as (args: unknown, opts: unknown) => Promise<Record<string, unknown>>;
    const out = await execute({ account_id: "act_700800900" }, { toolCallId: "t1", messages: [] });
    expect(out.error).toBe(true);
    expect(String(out.message)).toMatch(/not mapped to this client/);
    const own = await execute({ account_id: "act_400500600" }, { toolCallId: "t2", messages: [] });
    expect(own.error).toBeUndefined();
  });

  it("returns tool errors to the model instead of throwing", async () => {
    const tools = buildWorkspaceReadToolSet(ctx(TR));
    const execute = tools.ga4_report!.execute! as (args: unknown, opts: unknown) => Promise<Record<string, unknown>>;
    const out = await execute(BEST_SELLERS, { toolCallId: "t3", messages: [] });
    expect(out.error).toBe(true);
  });
});

describe("routing and prompt", () => {
  it("routes data questions to the general path, never out of scope or chat", () => {
    for (const ask of [
      "tell me the best selling products for me in the last 30 days",
      "use GA4 and get it",
      "what are my best selling products?",
      "what are our top landing pages?",
      "show me google ads spend for last 30 days",
      "what are the top search terms in search console?",
      "how much have we spent on the best selling product in the last 30 days",
      "what are our traffic sources?",
    ]) {
      expect(["general", "budget"], ask).toContain(detectRequestIntent(ask));
    }
  });

  it("no longer claims Meta-only and tells the model to use the tools", () => {
    const prompt = buildStaticSystemPromptV2();
    expect(prompt).not.toMatch(/Meta-only/);
    expect(prompt).not.toMatch(/scoped to Meta Ads operations/);
    expect(prompt).toMatch(/GA4/);
    expect(prompt).toMatch(/Search Console/);
    expect(prompt).toMatch(/Google Ads/);
    expect(prompt).toMatch(/Google is read-only/);
    expect(prompt).toMatch(/call the tools/i);
    expect(prompt).toMatch(/never say GA4, Search Console or Google Ads is out of scope/i);
  });

  it("puts the mapped Google assets in the client context", async () => {
    const ct = await buildClientContext(CT);
    expect(ct).toMatch(/## Connected data/);
    expect(ct).toMatch(/GA4: ClickTrends Store \(GA4\)/);
    expect(ct).toMatch(/Search Console: https:\/\/clicktrends\.example\//);
    expect(ct).toMatch(/Google Ads: ClickTrends Google Ads/);
    const tr = await buildClientContext(TR);
    expect(tr).toMatch(/GA4: not mapped/);
  });
});
