import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/google/oauth", () => ({
  getGoogleAccessToken: async () => "access-token",
}));

import { resetConfigCache } from "@/lib/config";
import {
  DEFAULT_GOOGLE_ADS_API_VERSION,
  discoverAdsAccounts,
  fetchAdsPerformance,
  listAccessibleCustomers,
  searchGaql,
} from "@/lib/google/ads";

type Call = { url: string; method: string; headers: Record<string, string>; query: string | null; pageToken: string | null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: Call[];
let fetchMock: ReturnType<typeof vi.fn>;

/** Routes a mocked fetch to a handler that sees the parsed call. */
function route(handler: (call: Call) => Response) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as { query?: string; pageToken?: string }) : null;
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      query: body?.query ?? null,
      pageToken: body?.pageToken ?? null,
    };
    calls.push(call);
    return handler(call);
  });
}

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "dev-token";
  resetConfigCache();
  calls = [];
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
  delete process.env.GOOGLE_ADS_API_VERSION;
  resetConfigCache();

  // Read-only guard: every call this suite made was a search or the account list.
  for (const call of calls) {
    expect(call.url).toMatch(/(googleAds:search|customers:listAccessibleCustomers)$/);
  }
});

describe("read-only guard", () => {
  it("the Ads client source never mentions mutate", () => {
    const source = readFileSync(path.resolve(__dirname, "../src/lib/google/ads.ts"), "utf8");
    expect(source.toLowerCase()).not.toContain("mutate");
  });
});

describe("searchGaql", () => {
  it("posts to googleAds:search with the developer and login headers and follows nextPageToken", async () => {
    route((call) =>
      call.pageToken === null
        ? json({ results: [{ campaign: { id: "1" } }], nextPageToken: "page-2" })
        : json({ results: [{ campaign: { id: "2" } }] }),
    );

    const rows = await searchGaql("123", "SELECT campaign.id FROM campaign", "999");

    expect(rows).toEqual([{ campaign: { id: "1" } }, { campaign: { id: "2" } }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      `https://googleads.googleapis.com/${DEFAULT_GOOGLE_ADS_API_VERSION}/customers/123/googleAds:search`,
    );
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["developer-token"]).toBe("dev-token");
    expect(calls[0].headers["login-customer-id"]).toBe("999");
    expect(calls[0].headers.Authorization).toBe("Bearer access-token");
    expect(calls[0].query).toBe("SELECT campaign.id FROM campaign");
    expect(calls[1].pageToken).toBe("page-2");
    expect(calls[1].query).toBe("SELECT campaign.id FROM campaign");
  });

  it("omits login-customer-id when it is null and honours GOOGLE_ADS_API_VERSION", async () => {
    process.env.GOOGLE_ADS_API_VERSION = "v99";
    resetConfigCache();
    route(() => json({}));

    expect(await searchGaql("123", "SELECT customer.id FROM customer", null)).toEqual([]);
    expect(calls[0].url).toBe("https://googleads.googleapis.com/v99/customers/123/googleAds:search");
    expect(calls[0].headers).not.toHaveProperty("login-customer-id");
  });
});

describe("listAccessibleCustomers", () => {
  it("returns digit-only customer ids", async () => {
    route(() => json({ resourceNames: ["customers/1112223333", "customers/4445556666"] }));
    expect(await listAccessibleCustomers()).toEqual(["1112223333", "4445556666"]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers["developer-token"]).toBe("dev-token");
  });
});

describe("discoverAdsAccounts", () => {
  it("returns a direct account and a manager's child once each, skipping a manager whose query fails", async () => {
    route((call) => {
      if (call.url.endsWith("customers:listAccessibleCustomers")) {
        return json({ resourceNames: ["customers/111", "customers/900", "customers/800"] });
      }
      const id = call.url.match(/customers\/(\d+)\/googleAds:search$/)?.[1];
      if (call.query?.includes("FROM customer_client")) {
        if (id === "800") return json({ error: { code: 403, message: "denied", status: "PERMISSION_DENIED" } }, 403);
        expect(call.headers["login-customer-id"]).toBe(id);
        return json({
          results: [
            {
              customerClient: {
                id: "222", descriptiveName: "Child", currencyCode: "AUD", timeZone: "Australia/Sydney",
                manager: false, level: "1",
              },
            },
            // Also reachable directly: still listed once.
            {
              customerClient: {
                id: "111", descriptiveName: "Direct", currencyCode: "USD", timeZone: "America/New_York",
                manager: false, level: "1",
              },
            },
          ],
        });
      }
      const customers: Record<string, unknown> = {
        "111": { id: "111", descriptiveName: "Direct", currencyCode: "USD", timeZone: "America/New_York", manager: false },
        "900": { id: "900", descriptiveName: "Agency MCC", currencyCode: "USD", timeZone: "UTC", manager: true },
        "800": { id: "800", descriptiveName: "Other MCC", currencyCode: "USD", timeZone: "UTC", manager: true },
      };
      return json({ results: [{ customer: customers[id ?? ""] }] });
    });

    const accounts = await discoverAdsAccounts();

    expect(accounts).toHaveLength(2);
    expect(accounts).toEqual(
      expect.arrayContaining([
        {
          customerId: "111", name: "Direct", currency: "USD", timezone: "America/New_York",
          loginCustomerId: null, manager: false, parentName: null,
        },
        {
          customerId: "222", name: "Child", currency: "AUD", timezone: "Australia/Sydney",
          loginCustomerId: "900", manager: false, parentName: "Agency MCC",
        },
      ]),
    );
  });

  it("prefers GOOGLE_ADS_LOGIN_CUSTOMER_ID when that manager reaches the account", async () => {
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "800";
    resetConfigCache();
    route((call) => {
      if (call.url.endsWith("customers:listAccessibleCustomers")) {
        return json({ resourceNames: ["customers/900", "customers/800"] });
      }
      const id = call.url.match(/customers\/(\d+)\/googleAds:search$/)?.[1] ?? "";
      if (call.query?.includes("FROM customer_client")) {
        return json({
          results: [{ customerClient: { id: "222", descriptiveName: "Child", currencyCode: "AUD", timeZone: "UTC", manager: false, level: "1" } }],
        });
      }
      return json({ results: [{ customer: { id, descriptiveName: `MCC ${id}`, currencyCode: "USD", timeZone: "UTC", manager: true } }] });
    });

    const accounts = await discoverAdsAccounts();

    expect(accounts).toEqual([
      expect.objectContaining({ customerId: "222", loginCustomerId: "800", parentName: "MCC 800" }),
    ]);
  });
});

describe("fetchAdsPerformance", () => {
  const range = { since: "2026-09-01", until: "2026-09-30" };

  function performanceRoute(opts: { merchantFails?: boolean; landingFails?: boolean } = {}) {
    route((call) => {
      const q = call.query ?? "";
      if (q.includes("FROM product_link")) {
        if (opts.merchantFails) return json({ error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" } }, 400);
        return json({ results: [{ productLink: { type: "MERCHANT_CENTER" } }] });
      }
      if (q.includes("FROM customer")) {
        return json({ results: [{ customer: { currencyCode: "AUD" } }] });
      }
      if (q.includes("FROM campaign")) {
        expect(q).toContain("segments.date BETWEEN '2026-09-01' AND '2026-09-30'");
        return json({
          results: [
            {
              campaign: { id: "55", name: "PMax", advertisingChannelType: "PERFORMANCE_MAX", status: "ENABLED" },
              metrics: { costMicros: "12340000", conversions: 3.5, conversionsValue: 456.78 },
            },
          ],
        });
      }
      if (q.includes("FROM landing_page_view")) {
        if (opts.landingFails) return json({ error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" } }, 400);
        return json({
          results: [
            { landingPageView: { unexpandedFinalUrl: "https://shop.example/sofas" }, metrics: { costMicros: "5000000", conversionsValue: 20 } },
          ],
        });
      }
      if (q.includes("FROM asset_group")) {
        return json({
          results: [
            { assetGroup: { name: "Sofas AG", campaign: "customers/123/campaigns/55" }, metrics: { costMicros: "1005000", conversionsValue: 9.99 } },
          ],
        });
      }
      if (q.includes("FROM shopping_performance_view")) {
        return json({
          results: [
            { segments: { productTypeL1: "Furniture", productTypeL2: "Sofas" }, metrics: { costMicros: "2000000", conversionsValue: 10 } },
            { segments: { productTypeL1: "Furniture" }, metrics: { costMicros: "1000000", conversionsValue: 0 } },
          ],
        });
      }
      throw new Error(`unexpected query ${q}`);
    });
  }

  it("converts micros to cents and maps every section", async () => {
    performanceRoute();

    const perf = await fetchAdsPerformance("123", "900", range);

    expect(perf).toEqual({
      customerId: "123",
      currency: "AUD",
      merchantCenterLinked: true,
      campaigns: [
        { id: "55", name: "PMax", type: "PERFORMANCE_MAX", status: "ENABLED", costCents: 1234, conversions: 3.5, conversionValueCents: 45678 },
      ],
      landingPages: [{ url: "https://shop.example/sofas", costCents: 500, conversionValueCents: 2000 }],
      assetGroups: [{ name: "Sofas AG", campaignId: "55", costCents: 101, conversionValueCents: 999 }],
      shoppingCategories: [
        { productType: "Furniture > Sofas", costCents: 200, conversionValueCents: 1000 },
        { productType: "Furniture", costCents: 100, conversionValueCents: 0 },
      ],
    });
    for (const call of calls) expect(call.headers["login-customer-id"]).toBe("900");
  });

  it("a failing Merchant Center link query gives merchantCenterLinked: false", async () => {
    performanceRoute({ merchantFails: true });
    const perf = await fetchAdsPerformance("123", null, range);
    expect(perf.merchantCenterLinked).toBe(false);
    expect(perf.campaigns).toHaveLength(1);
  });

  it("a failing landing page query gives an empty list without throwing", async () => {
    performanceRoute({ landingFails: true });
    const perf = await fetchAdsPerformance("123", null, range);
    expect(perf.landingPages).toEqual([]);
    expect(perf.assetGroups).toHaveLength(1);
  });
});
