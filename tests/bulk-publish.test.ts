import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { prepareApprovalArgs } from "@/lib/approvals/validate-args";
import { buildBulkPublishArgs, isPrivateImageUrl, type BulkPublishAd, type BulkPublishPlan } from "@/lib/creatives/bulk/publish";

const ads = (n: number): BulkPublishAd[] =>
  Array.from({ length: n }, (_, i) => ({
    draftId: `d${i}`,
    headline: `Hook ${i + 1}`,
    primaryText: `Body ${i + 1}`,
    name: `Angle ${i + 1}`,
    imageUrl: `https://cdn.example.com/${i}.png`,
  }));

const newCampaign: BulkPublishPlan = {
  destination: {
    mode: "new",
    campaignName: "Acme — Spring",
    objective: "OUTCOME_LEADS",
    settings: { campaign_budget_optimization: false, conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS", pixel_id: "42", pixel_event_name: "LEAD", junk: "dropped" },
  },
  adSet: { name: "Broad AU", budget_daily: 40, targeting: { locations: ["AU"], age_min: 25, age_max: 55, nonsense: 1 } },
  ad: { landing_page_url: "https://acme.com/lp", call_to_action: "Book Now", facebook_page_id: "321", url_tags: "utm_source=meta" },
};

describe("building the one approval for a whole run", () => {
  it("makes the first image the main ad and every other image an extra ad, with its own copy", () => {
    const args = buildBulkPublishArgs({ accountId: "act_111", plan: newCampaign, ads: ads(15) });
    expect(args).toMatchObject({
      account_id: "act_111",
      campaign_name: "Acme — Spring",
      objective: "OUTCOME_LEADS",
      ad_set_name: "Broad AU",
      budget_daily: 40,
      primary_text: "Body 1",
      headline: "Hook 1",
      image_url: "https://cdn.example.com/0.png",
      call_to_action: "BOOK_NOW",
      landing_page_url: "https://acme.com/lp",
      facebook_page_id: "321",
      locations: ["AU"],
      age_min: 25,
      pixel_id: "42",
    });
    const extra = args.extra_ads as Array<Record<string, unknown>>;
    expect(extra).toHaveLength(14);
    expect(extra[0]).toEqual({ primary_text: "Body 2", headline: "Hook 2", image_url: "https://cdn.example.com/1.png", name: "Angle 2" });
    expect(extra[13]!.image_url).toBe("https://cdn.example.com/14.png");
  });

  it("applies the same settings to every ad: only one call to action, one landing page, one set of UTMs", () => {
    const args = buildBulkPublishArgs({ accountId: "act_111", plan: newCampaign, ads: ads(15) });
    expect(args.url_tags).toBe("utm_source=meta");
    for (const extra of args.extra_ads as Array<Record<string, unknown>>) {
      expect(extra.call_to_action).toBeUndefined();
      expect(extra.landing_page_url).toBeUndefined(); // falls back to the main ad's
    }
  });

  it("drops anything that is not a known setting", () => {
    const args = buildBulkPublishArgs({ accountId: "act_111", plan: newCampaign, ads: ads(2) });
    expect(args).not.toHaveProperty("junk");
    expect(args).not.toHaveProperty("nonsense");
  });

  it("points at the existing campaign instead of creating one", () => {
    const args = buildBulkPublishArgs({
      accountId: "act_111",
      plan: { ...newCampaign, destination: { mode: "existing", campaignId: "777", campaignName: "Evergreen", objective: "OUTCOME_LEADS" } },
      ads: ads(3),
    });
    expect(args.existing_campaign_id).toBe("777");
    expect(args.campaign_name).toBe("Evergreen");
  });

  it("refuses when Meta could not download the images", () => {
    expect(isPrivateImageUrl("http://localhost:3000/api/creatives/assets/x")).toBe(true);
    expect(isPrivateImageUrl("http://192.168.1.5/x.png")).toBe(true);
    expect(isPrivateImageUrl("https://res.cloudinary.com/x.png")).toBe(false);
    expect(() => buildBulkPublishArgs({ accountId: "act_111", plan: newCampaign, ads: [{ ...ads(1)[0]!, imageUrl: "http://localhost:3000/a.png" }] })).toThrow(/Meta has to download/);
  });

  it("refuses an empty run and more ads than one ad set takes", () => {
    expect(() => buildBulkPublishArgs({ accountId: "act_111", plan: newCampaign, ads: [] })).toThrow(/no finished images/);
    expect(() => buildBulkPublishArgs({ accountId: "act_111", plan: newCampaign, ads: ads(26) })).toThrow(/At most/);
  });

  it("passes the approval's own checks, all 15 ads included", async () => {
    const args = buildBulkPublishArgs({ accountId: "act_111", plan: newCampaign, ads: ads(15) });
    const prepared = await prepareApprovalArgs({
      toolName: "create_meta_image_campaign",
      clientId: "c1",
      args,
      loadAccounts: async () => [{ meta_account_id: "act_111", access_status: "granted", currency: "AUD" }],
    });
    expect((prepared.args.extra_ads as unknown[]).length).toBe(14);
  });
});

type Handler = (path: string, params: Record<string, unknown>) => unknown;
function providerWith(handlers: { get: Handler }) {
  const provider = new MetaGraphProviderV2("test-token");
  const posts: Array<[string, Record<string, unknown>]> = [];
  const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) => handlers.get(path, params));
  const post = vi.fn(async (path: string, body: Record<string, unknown> = {}) => {
    posts.push([path, body]);
    return { id: String(1000 + posts.length) };
  });
  (provider as unknown as { graph: unknown }).graph = { get, post };
  return { provider, posts, post };
}

const base = {
  account_id: "act_111",
  campaign_name: "Evergreen",
  existing_campaign_id: "777",
  primary_text: "Body 1",
  headline: "Hook 1",
  landing_page_url: "https://acme.com/lp",
  image_url: "https://cdn.example.com/0.png",
  locations: ["AU"],
  pixel_id: "42",
  facebook_page_id: "321",
  extra_args: { extra_ads: ads(3).slice(1).map((a) => ({ primary_text: a.primaryText, headline: a.headline, image_url: a.imageUrl, name: a.name })) },
};

describe("adding the ads to a campaign that already exists", () => {
  const live = (over: Record<string, unknown> = {}) => (path: string) =>
    path === "777"
      ? { account_id: "111", objective: "OUTCOME_LEADS", status: "PAUSED", ...over }
      : { currency: "AUD", account_id: "111" };

  it("creates no campaign: a new ad set and all the ads go into it", async () => {
    const { provider, posts } = providerWith({ get: live({ daily_budget: "5000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" }) });
    await provider.createImageCampaign({ ...base, pixel_event_name: "LEAD" });
    expect(posts.some(([p]) => p === "act_111/campaigns")).toBe(false);
    const adset = posts.find(([p]) => p === "act_111/adsets")![1];
    expect(adset.campaign_id).toBe("777");
    expect(adset.daily_budget).toBeUndefined(); // the campaign owns the budget
    expect(posts.filter(([p]) => p === "act_111/ads")).toHaveLength(3);
    expect(new Set(posts.filter(([p]) => p === "act_111/ads").map(([, b]) => b.adset_id)).size).toBe(1);
  });

  it("needs an ad set budget when the campaign has none", async () => {
    const { provider, post } = providerWith({ get: live() });
    await expect(provider.createImageCampaign({ ...base, pixel_event_name: "LEAD" })).rejects.toThrow(/budget is required/);
    expect(post).not.toHaveBeenCalled();
    const ok = providerWith({ get: live() });
    await ok.provider.createImageCampaign({ ...base, pixel_event_name: "LEAD", budget_daily: 25 });
    expect(ok.posts.find(([p]) => p === "act_111/adsets")![1].daily_budget).toBe("2500");
  });

  it("refuses another account's campaign or an archived one, before anything is created", async () => {
    const other = providerWith({ get: live({ account_id: "999" }) });
    await expect(other.provider.createImageCampaign({ ...base, budget_daily: 25 })).rejects.toThrow(/belongs to/);
    expect(other.post).not.toHaveBeenCalled();
    const archived = providerWith({ get: live({ status: "ARCHIVED" }) });
    await expect(archived.provider.createImageCampaign({ ...base, budget_daily: 25 })).rejects.toThrow(/archived/);
    expect(archived.post).not.toHaveBeenCalled();
  });

  it("will not pretend a bid cap applies under a campaign budget that bids differently", async () => {
    const { provider, post } = providerWith({ get: live({ daily_budget: "5000" }) });
    await expect(
      provider.createImageCampaign({ ...base, pixel_event_name: "LEAD", extra_args: { ...base.extra_args, bid_strategy: "COST_CAP", bid_amount: 30 } }),
    ).rejects.toThrow(/can't use COST_CAP/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("an existing campaign through the approval's own checks", () => {
  it("needs no budget of its own, since the campaign may hold it", async () => {
    const plan: BulkPublishPlan = {
      destination: { mode: "existing", campaignId: "777", campaignName: "Evergreen", objective: "OUTCOME_TRAFFIC" },
      adSet: { name: "New ad set", targeting: { locations: ["AU"] } },
      ad: { landing_page_url: "https://acme.com/lp", facebook_page_id: "321" },
    };
    const args = buildBulkPublishArgs({ accountId: "act_111", plan, ads: ads(15) });
    const prepared = await prepareApprovalArgs({
      toolName: "create_meta_image_campaign",
      clientId: "c1",
      args,
      loadAccounts: async () => [{ meta_account_id: "act_111", access_status: "granted", currency: "AUD" }],
    });
    expect(prepared.args.existing_campaign_id).toBe("777");
    expect((prepared.args.extra_ads as unknown[]).length).toBe(14);
  });
});
