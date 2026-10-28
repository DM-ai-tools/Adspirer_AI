import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { MockMetaAdsProvider } from "@/lib/adspirer/mock-provider";

type Params = Record<string, unknown>;

/** Provider whose Graph client answers from in-memory rows and records every GET. */
function providerWith(routes: Record<string, (params: Params) => unknown>) {
  const provider = new MetaGraphProviderV2("test-token");
  const get = vi.fn(async (path: string, params: Params = {}) => {
    const route = routes[path];
    if (!route) throw new Error(`unexpected GET ${path}`);
    return route(params);
  });
  (provider as unknown as { graph: unknown }).graph = { get, post: vi.fn() };
  return { provider, get };
}

const insightCalls = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.filter(([path]) => String(path).endsWith("/insights")).map(([, params]) => params as Params);

const result = (n: number) => [{ indicator: "actions:lead", values: [{ value: String(n) }] }];

function budgetRoutes() {
  return {
    act_111: () => ({ currency: "USD" }),
    "act_111/campaigns": () => ({
      data: [
        { id: "c1", name: "Leads Brisbane", status: "ACTIVE", objective: "OUTCOME_LEADS" },
        { id: "c2", name: "Brand", status: "ACTIVE", objective: "OUTCOME_LEADS" },
      ],
    }),
    "act_111/adsets": () => ({
      data: [
        { id: "as1", name: "Leads A", status: "ACTIVE", campaign_id: "c1", daily_budget: "3000" },
        { id: "as2", name: "Brand A", status: "ACTIVE", campaign_id: "c2", daily_budget: "3000" },
        { id: "as3", name: "Leads B", status: "ACTIVE", campaign_id: "c1", daily_budget: "3000" },
      ],
    }),
    "act_111/insights": () => ({
      data: [
        { adset_id: "as1", adset_name: "Leads A", spend: "100", clicks: "50", ctr: "2", results: result(5) },
        { adset_id: "as2", adset_name: "Brand A", spend: "80", clicks: "40", ctr: "2", results: result(4) },
        { adset_id: "as3", adset_name: "Leads B", spend: "60", clicks: "10", ctr: "0.5", results: result(0) },
      ],
    }),
  };
}

const proposedAdSets = (out: { structured?: Record<string, unknown> | null }) =>
  ((out.structured?.proposals ?? []) as Array<{ args: { adset_id?: string } }>).map((p) => p.args.adset_id).sort();

describe("optimizeBudget period and scope", () => {
  it("reads the period it is given and names it", async () => {
    const { provider, get } = providerWith(budgetRoutes());
    const out = await provider.optimizeBudget("act_111", { since: "2026-10-01", until: "2026-10-15" });
    expect(JSON.parse(String(insightCalls(get)[0].time_range))).toEqual({ since: "2026-10-01", until: "2026-10-15" });
    expect(out.text).toContain("2026-10-01 → 2026-10-15");
    expect(out.structured).toMatchObject({ date_start: "2026-10-01", date_stop: "2026-10-15" });
  });

  it("an explicit period takes precedence over lookback_days", async () => {
    const { provider, get } = providerWith(budgetRoutes());
    await provider.optimizeBudget("act_111", { lookback_days: 30, since: "2026-10-01", until: "2026-10-15" });
    expect(JSON.parse(String(insightCalls(get)[0].time_range)).since).toBe("2026-10-01");
  });

  it("leaves the default 7-day behaviour alone", async () => {
    const { provider, get } = providerWith(budgetRoutes());
    const out = await provider.optimizeBudget("act_111");
    expect(out.structured?.lookback_days).toBe(7);
    expect(insightCalls(get)).toHaveLength(1);
    expect(proposedAdSets(out)).toEqual(["as1", "as2", "as3"]);
  });

  it("only ranks and proposes inside the campaigns it is restricted to", async () => {
    const { provider, get } = providerWith(budgetRoutes());
    const out = await provider.optimizeBudget("act_111", { campaign_ids: ["c1"] });
    expect(proposedAdSets(out)).toEqual(["as1", "as3"]);
    expect(String(insightCalls(get)[0].filtering)).toContain("c1");
  });

  it("only ranks and proposes the ad sets it is restricted to", async () => {
    const { provider } = providerWith(budgetRoutes());
    const out = await provider.optimizeBudget("act_111", { adset_ids: ["as2"] });
    expect(proposedAdSets(out)).toEqual(["as2"]);
  });
});

function fatigueRoutes() {
  const row = (ad: string, adset: string, imps: number, clicks: number, freq: number) => ({
    ad_id: ad, ad_name: ad, adset_id: adset, spend: "50", impressions: String(imps), frequency: String(freq), inline_link_clicks: String(clicks),
  });
  return {
    act_111: () => ({ currency: "USD" }),
    "act_111/ads": () => ({
      data: [
        { id: "a1", name: "a1", status: "ACTIVE", adset_id: "s1", campaign_id: "c1" },
        { id: "a1b", name: "a1b", status: "ACTIVE", adset_id: "s1", campaign_id: "c1" },
        { id: "a2", name: "a2", status: "ACTIVE", adset_id: "s2", campaign_id: "c2" },
        { id: "a2b", name: "a2b", status: "ACTIVE", adset_id: "s2", campaign_id: "c2" },
      ],
    }),
    "act_111/insights": (params: Params) => {
      const fortnight =
        params.date_preset === "last_14d" ||
        (typeof params.time_range === "string" && JSON.parse(params.time_range).since === "2026-10-07");
      return {
        data: fortnight
          ? [row("a1", "s1", 4000, 40, 4), row("a2", "s2", 4000, 40, 4)]
          : [row("a1", "s1", 2000, 10, 4), row("a2", "s2", 2000, 10, 4)],
      };
    },
  };
}

const pausedAds = (out: { structured?: Record<string, unknown> | null }) =>
  ((out.structured?.proposals ?? []) as Array<{ args: { ad_id?: string } }>).map((p) => p.args.ad_id).sort();

describe("detectCreativeFatigue period and scope", () => {
  it("defaults to this week against the week before", async () => {
    const { provider, get } = providerWith(fatigueRoutes());
    const out = await provider.detectCreativeFatigue("act_111");
    expect(insightCalls(get).map((p) => p.date_preset)).toEqual(["last_7d", "last_14d"]);
    expect(pausedAds(out)).toEqual(["a1", "a2"]);
  });

  it("anchors the two weeks on the period end it is given", async () => {
    const { provider, get } = providerWith(fatigueRoutes());
    const out = await provider.detectCreativeFatigue("act_111", { until: "2026-10-20" });
    const ranges = insightCalls(get).map((p) => JSON.parse(String(p.time_range)));
    expect(ranges).toContainEqual({ since: "2026-10-14", until: "2026-10-20" });
    expect(ranges).toContainEqual({ since: "2026-10-07", until: "2026-10-20" });
    expect(insightCalls(get).every((p) => p.date_preset === undefined)).toBe(true);
    expect(out.text).toContain("2026-10-14 → 2026-10-20");
  });

  it("ignores ads outside the scope it is restricted to, but still protects an ad set's last live ad", async () => {
    const { provider } = providerWith(fatigueRoutes());
    expect(pausedAds(await provider.detectCreativeFatigue("act_111", { ad_ids: ["a1"] }))).toEqual(["a1"]);
    expect(pausedAds(await provider.detectCreativeFatigue("act_111", { campaign_ids: ["c2"] }))).toEqual(["a2"]);
    expect(pausedAds(await provider.detectCreativeFatigue("act_111", { adset_ids: ["s1"] }))).toEqual(["a1"]);
  });
});

describe("mock provider (demo mode) honours scope", () => {
  const ACCOUNT = "act_100200300";
  it("restricts budget proposals to the ad sets in scope", async () => {
    const mock = new MockMetaAdsProvider();
    const adsets = await mock.listAdSets(ACCOUNT);
    expect(adsets.length).toBeGreaterThan(1);
    const keep = adsets[adsets.length - 1]!;
    const out = await mock.optimizeBudget(ACCOUNT, { adset_ids: [keep.id] });
    const ids = ((out.structured?.proposals ?? []) as Array<{ args: { adset_id: string } }>).map((p) => p.args.adset_id);
    expect(ids.every((id) => id === keep.id)).toBe(true);
  });

  it("restricts fatigue proposals to the ads in scope and echoes the period", async () => {
    const mock = new MockMetaAdsProvider();
    const ads = await mock.listAds(ACCOUNT);
    const keep = ads[ads.length - 1]!;
    const out = await mock.detectCreativeFatigue(ACCOUNT, { ad_ids: [keep.id], since: "2026-10-01", until: "2026-10-07" });
    const ids = ((out.structured?.proposals ?? []) as Array<{ args: { ad_id: string } }>).map((p) => p.args.ad_id);
    expect(ids.every((id) => id === keep.id)).toBe(true);
    expect(out.text).toContain("2026-10-01 → 2026-10-07");
  });
});
