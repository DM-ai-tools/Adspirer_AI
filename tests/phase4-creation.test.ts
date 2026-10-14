import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { prepareApprovalArgs } from "@/lib/approvals/validate-args";
import { campaignNameByConvention, DEFAULT_URL_TAGS } from "@/lib/meta/conventions";

type Handler = (path: string, params: Record<string, unknown>) => unknown;

function providerWith(handlers: { get: Handler; post?: Handler }) {
  const provider = new MetaGraphProviderV2("test-token");
  const posts: Array<[string, Record<string, unknown>]> = [];
  const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) => handlers.get(path, params));
  const post = vi.fn(async (path: string, body: Record<string, unknown> = {}) => {
    posts.push([path, body]);
    return handlers.post ? handlers.post(path, body) : { id: String(1000 + posts.length) };
  });
  (provider as unknown as { graph: unknown }).graph = { get, post };
  return { provider, post, posts };
}

const base = {
  account_id: "act_111",
  campaign_name: "Spring",
  objective: "OUTCOME_LEADS",
  budget_daily: 20,
  primary_text: "Book your consult today",
  headline: "Implants from $99",
  landing_page_url: "https://example.com/lp",
  image_url: "https://example.com/a.jpg",
  locations: ["GB"],
  pixel_id: "42",
  facebook_page_id: "321",
};
const body = (posts: Array<[string, Record<string, unknown>]>, path: string) => posts.find(([p]) => p === path)![1];

describe("bid strategy on create", () => {
  it("sets a cost cap on the ad set (ad set budgets)", async () => {
    const { provider, posts } = providerWith({ get: () => ({ currency: "GBP" }) });
    await provider.createImageCampaign({ ...base, extra_args: { bid_strategy: "COST_CAP", bid_amount: 30 } });
    const adset = body(posts, "act_111/adsets");
    expect(adset.bid_strategy).toBe("COST_CAP");
    expect(adset.bid_amount).toBe("3000");
  });

  it("puts the strategy on the campaign under CBO and the ROAS floor on the ad set", async () => {
    const { provider, posts } = providerWith({ get: () => ({ currency: "GBP" }) });
    await provider.createImageCampaign({
      ...base,
      objective: "OUTCOME_SALES",
      pixel_event_name: "PURCHASE",
      campaign_budget_optimization: true,
      extra_args: { bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2.5 },
    });
    expect(body(posts, "act_111/campaigns").bid_strategy).toBe("LOWEST_COST_WITH_MIN_ROAS");
    const adset = body(posts, "act_111/adsets");
    expect(JSON.parse(String(adset.bid_constraints))).toEqual({ roas_average_floor: 25000 });
    expect(adset.optimization_goal).toBe("VALUE");
    expect(adset.bid_strategy).toBeUndefined();
  });

  it("refuses before any POST when the cap or floor is missing or the goal can't use it", async () => {
    const { provider, post } = providerWith({ get: () => ({ currency: "GBP" }) });
    await expect(provider.createImageCampaign({ ...base, extra_args: { bid_strategy: "COST_CAP" } })).rejects.toThrow(/bid_amount/);
    await expect(
      provider.createImageCampaign({ ...base, extra_args: { bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2 } }),
    ).rejects.toThrow(/Sales/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("attribution setting on create", () => {
  it("sends the attribution window on a conversion-optimised ad set", async () => {
    const { provider, posts } = providerWith({ get: () => ({ currency: "GBP" }) });
    await provider.createImageCampaign({ ...base, extra_args: { attribution: "7d_click" } });
    expect(JSON.parse(String(body(posts, "act_111/adsets").attribution_spec))).toEqual([
      { event_type: "CLICK_THROUGH", window_days: 7 },
    ]);
  });

  it("defaults to the client's attribution setting at proposal time", async () => {
    const prepared = await prepareApprovalArgs({
      toolName: "create_meta_image_campaign",
      clientId: "c1",
      args: { ...base, account_id: "act_111" },
      client: { id: "c1", budget_ceiling_cents: null, currency: "GBP", goals_profile: { attribution: "1d_click" } },
      loadAccounts: async () => [{ meta_account_id: "act_111", access_status: "granted", currency: "GBP" }],
    });
    expect(prepared.args.attribution).toBe("1d_click");
  });

  it("rejects an unknown bid strategy or attribution", async () => {
    const run = (extra: Record<string, unknown>) =>
      prepareApprovalArgs({
        toolName: "create_meta_image_campaign",
        clientId: "c1",
        args: { ...base, ...extra },
        loadAccounts: async () => [{ meta_account_id: "act_111", access_status: "granted", currency: "GBP" }],
      });
    await expect(run({ bid_strategy: "CHEAPEST" })).rejects.toThrow(/bid_strategy/);
    await expect(run({ attribution: "28d_click" })).rejects.toThrow(/attribution/);
  });
});

describe("UTMs and naming", () => {
  it("adds the standard UTM template when the ad has none", async () => {
    const { provider, posts } = providerWith({ get: () => ({ currency: "GBP" }) });
    await provider.createImageCampaign(base);
    expect(body(posts, "act_111/adcreatives").url_tags).toBe(DEFAULT_URL_TAGS);
  });

  it("keeps the operator's UTMs, and adds none when the link already has them", async () => {
    const a = providerWith({ get: () => ({ currency: "GBP" }) });
    await a.provider.createImageCampaign({ ...base, url_tags: "utm_source=meta" });
    expect(body(a.posts, "act_111/adcreatives").url_tags).toBe("utm_source=meta");
    const b = providerWith({ get: () => ({ currency: "GBP" }) });
    await b.provider.createImageCampaign({ ...base, landing_page_url: "https://example.com/lp?utm_source=fb" });
    expect(body(b.posts, "act_111/adcreatives").url_tags).toBeUndefined();
  });

  it("builds Client_Objective_Audience_Geo_YYYYMM names", () => {
    expect(
      campaignNameByConvention({
        client: "Modern Dental",
        objective: "OUTCOME_LEADS",
        audience: "Broad",
        geo: ["AU", "NZ"],
        date: new Date("2026-10-14T00:00:00Z"),
      }),
    ).toBe("ModernDental_Leads_Broad_AU-NZ_202610");
  });

  it("names ad sets and ads by convention when the proposal leaves them blank", async () => {
    const prepared = await prepareApprovalArgs({
      toolName: "create_meta_image_campaign",
      clientId: "c1",
      args: { ...base, advantage_audience: 1 },
      loadAccounts: async () => [{ meta_account_id: "act_111", access_status: "granted", currency: "GBP" }],
    });
    expect(prepared.args.ad_set_name).toBe("Broad_GB");
    expect(prepared.args.ad_name).toBe("ImplantsFrom99_Image_BookYourConsult");
  });
});

describe("several ads per ad set and text options", () => {
  const extraAds = [
    { headline: "Same-day crowns", image_url: "https://example.com/b.jpg" },
    { primary_text: "Free consult this month", image_url: "https://example.com/c.jpg", name: "Offer_Image_FreeConsult" },
  ];

  it("creates every extra ad in the same ad set", async () => {
    const { provider, posts } = providerWith({ get: () => ({ currency: "GBP" }) });
    const result = await provider.createImageCampaign({ ...base, extra_args: { extra_ads: extraAds } });
    const ads = posts.filter(([p]) => p === "act_111/ads").map(([, b]) => b);
    expect(ads).toHaveLength(3);
    expect(new Set(ads.map((a) => a.adset_id)).size).toBe(1);
    const creatives = posts.filter(([p]) => p === "act_111/adcreatives").map(([, b]) => JSON.parse(String(b.object_story_spec)).link_data);
    expect(creatives[1]).toMatchObject({ name: "Same-day crowns", message: "Book your consult today", picture: "https://example.com/b.jpg" });
    expect(creatives[2]).toMatchObject({ message: "Free consult this month", picture: "https://example.com/c.jpg" });
    expect(ads[2]!.name).toBe("Offer_Image_FreeConsult");
    expect(result.created.extra_ads).toHaveLength(2);
  });

  it("resumes without re-creating extra ads that already exist", async () => {
    const { provider, posts } = providerWith({ get: (path) => (path === "act_111" ? { currency: "GBP" } : { account_id: "act_111" }) });
    await provider.createImageCampaign({
      ...base,
      extra_args: { extra_ads: extraAds },
      resume: { campaign_id: "1", adset_id: "2", creative_id: "3", ad_id: "4", extra_ads: [{ creative_id: "5", ad_id: "6" }] },
    });
    expect(posts.filter(([p]) => p === "act_111/ads")).toHaveLength(1);
  });

  it("records the extra ads already made when a later one fails", async () => {
    let ads = 0;
    const { provider } = providerWith({
      get: () => ({ currency: "GBP" }),
      post: (path) => {
        if (path === "act_111/ads" && ++ads === 3) throw new Error("Meta said no");
        return { id: String(5000 + ads + Math.floor(Math.random() * 1000)) };
      },
    });
    const error = await provider.createImageCampaign({ ...base, extra_args: { extra_ads: extraAds } }).catch((e) => e);
    expect(error.progress.extra_ads?.[0]?.ad_id).toBeTruthy();
    expect(error.progress.extra_ads?.[1]?.ad_id).toBeUndefined();
  });

  it("sends extra primary texts and headlines as text options", async () => {
    const { provider, posts } = providerWith({ get: () => ({ currency: "GBP" }) });
    await provider.createImageCampaign({ ...base, extra_args: { primary_texts: ["Smile again", "Book your consult today"], headlines: ["Implants, done right"] } });
    const creative = body(posts, "act_111/adcreatives");
    expect(JSON.parse(String(creative.asset_feed_spec))).toEqual({
      bodies: [{ text: "Book your consult today" }, { text: "Smile again" }],
      titles: [{ text: "Implants from $99" }, { text: "Implants, done right" }],
      optimization_type: "DEGREES_OF_FREEDOM",
    });
  });

  it("accepts text options and extra ads at proposal time, within Meta's limits", async () => {
    const prep = (extra: Record<string, unknown>) =>
      prepareApprovalArgs({
        toolName: "create_meta_image_campaign",
        clientId: "c1",
        args: { ...base, ...extra },
        loadAccounts: async () => [{ meta_account_id: "act_111", access_status: "granted", currency: "GBP" }],
      });
    const ok = await prep({ primary_texts: ["A", "B"], extra_ads: [{ headline: "Two", image_url: "https://example.com/b.jpg" }] });
    expect((ok.args.extra_ads as Array<{ name: string }>)[0]!.name).toBe("Two_Image_BookYourConsult");
    await expect(prep({ primary_texts: ["1", "2", "3", "4", "5", "6"] })).rejects.toThrow(/primary_texts/);
    await expect(prep({ extra_ads: [{ headline: "No image" }] })).rejects.toThrow(/image/);
  });
});
