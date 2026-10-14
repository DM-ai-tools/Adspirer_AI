import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { formatGraphError } from "@/lib/meta/graph-client";
import { ExecutionVerificationError } from "@/lib/errors";
import { PartialCreateError } from "@/lib/meta/create-progress";

type Handler = (path: string, params: Record<string, unknown>) => unknown;

/** Provider with its Graph client replaced by in-memory GET/POST handlers. */
function providerWith(handlers: { get: Handler; post?: Handler }) {
  const provider = new MetaGraphProviderV2("test-token");
  const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) =>
    handlers.get(path, params),
  );
  const post = vi.fn(async (path: string, body: Record<string, unknown> = {}) =>
    handlers.post ? handlers.post(path, body) : { success: true },
  );
  (provider as unknown as { graph: unknown }).graph = { get, post };
  return { provider, get, post };
}

function adSetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "777",
    name: "Prospecting",
    status: "ACTIVE",
    account_id: "111",
    campaign_id: "999",
    daily_budget: "3000",
    lifetime_budget: "0",
    campaign: { id: "999", name: "Spring", daily_budget: "0", lifetime_budget: "0" },
    ...overrides,
  };
}

describe("updateAdSetBudget", () => {
  it("uses the JPY offset (1) and verifies the read-back", async () => {
    let written: string | undefined;
    const { provider, post } = providerWith({
      get: (path, params) => {
        if (path === "act_111") return { currency: "JPY" };
        if (path === "777" && String(params.fields).includes("campaign{")) return adSetRow();
        if (path === "777") return { daily_budget: written, status: "ACTIVE" };
        throw new Error(`unexpected GET ${path}`);
      },
      post: (_path, body) => {
        written = String(body.daily_budget);
        return { success: true };
      },
    });

    // ¥5,000/day = 500_000 app cents → Meta minor units 5000 (not 500000).
    const result = await provider.updateAdSetBudget({
      adset_id: "777",
      daily_budget_cents: 500_000,
    });
    expect(post).toHaveBeenCalledWith("777", { daily_budget: "5000" });
    expect(result).toMatchObject({
      account_id: "act_111",
      currency: "JPY",
      daily_budget_cents: 500_000,
      previous_daily_budget_cents: 300_000,
      verified: true,
    });
  });

  it("fails closed when the account currency cannot be read", async () => {
    const { provider, post } = providerWith({
      get: (path) => {
        if (path === "777") return adSetRow();
        throw new Error("(#100) Unsupported get request");
      },
    });
    await expect(
      provider.updateAdSetBudget({ adset_id: "777", daily_budget_cents: 5000 }),
    ).rejects.toThrow(/Could not read the currency/);
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses ad sets under a CBO campaign or with a lifetime budget", async () => {
    const cbo = providerWith({
      get: () =>
        adSetRow({
          campaign: { id: "999", name: "Spring", daily_budget: "10000", lifetime_budget: "0" },
        }),
    });
    await expect(
      cbo.provider.updateAdSetBudget({ adset_id: "777", daily_budget_cents: 5000 }),
    ).rejects.toThrow(/campaign budget/);
    expect(cbo.post).not.toHaveBeenCalled();

    const lifetime = providerWith({
      get: () => adSetRow({ daily_budget: "0", lifetime_budget: "90000" }),
    });
    await expect(
      lifetime.provider.updateAdSetBudget({ adset_id: "777", daily_budget_cents: 5000 }),
    ).rejects.toThrow(/lifetime budget/);
    expect(lifetime.post).not.toHaveBeenCalled();
  });

  it("refuses when the proposal's account does not own the ad set", async () => {
    const { provider, post } = providerWith({ get: () => adSetRow() });
    await expect(
      provider.updateAdSetBudget({
        account_id: "act_222",
        adset_id: "777",
        daily_budget_cents: 5000,
      }),
    ).rejects.toThrow(/belongs to ad account act_111/);
    expect(post).not.toHaveBeenCalled();
  });

  it("raises a verification error when the read-back differs", async () => {
    const { provider } = providerWith({
      get: (path, params) => {
        if (path === "act_111") return { currency: "USD" };
        if (String(params.fields).includes("campaign{")) return adSetRow();
        return { daily_budget: "3000", status: "ACTIVE" };
      },
    });
    await expect(
      provider.updateAdSetBudget({ adset_id: "777", daily_budget_cents: 5500 }),
    ).rejects.toBeInstanceOf(ExecutionVerificationError);
  });
});

function campaignRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "999",
    name: "TR | Lead Gen",
    status: "ACTIVE",
    account_id: "111",
    daily_budget: "3000",
    lifetime_budget: "0",
    ...overrides,
  };
}

describe("updateCampaignBudget", () => {
  it("writes the campaign (CBO) daily budget and verifies the read-back", async () => {
    let written: string | undefined;
    const { provider, post } = providerWith({
      get: (path, params) => {
        if (path === "act_111") return { currency: "USD" };
        if (path === "999" && String(params.fields).includes("account_id")) return campaignRow();
        if (path === "999") return { daily_budget: written, status: "ACTIVE" };
        throw new Error(`unexpected GET ${path}`);
      },
      post: (_path, body) => {
        written = String(body.daily_budget);
        return { success: true };
      },
    });
    const result = await provider.updateCampaignBudget({ campaign_id: "999", daily_budget_cents: 3600 });
    expect(post).toHaveBeenCalledWith("999", { daily_budget: "3600" });
    expect(result).toMatchObject({
      id: "999",
      account_id: "act_111",
      currency: "USD",
      daily_budget_cents: 3600,
      previous_daily_budget_cents: 3000,
      verified: true,
    });
  });

  it("refuses campaigns without a campaign daily budget", async () => {
    const abo = providerWith({ get: () => campaignRow({ daily_budget: "0" }) });
    await expect(
      abo.provider.updateCampaignBudget({ campaign_id: "999", daily_budget_cents: 5000 }),
    ).rejects.toThrow(/ad set budgets/);
    expect(abo.post).not.toHaveBeenCalled();

    const lifetime = providerWith({ get: () => campaignRow({ daily_budget: "0", lifetime_budget: "90000" }) });
    await expect(
      lifetime.provider.updateCampaignBudget({ campaign_id: "999", daily_budget_cents: 5000 }),
    ).rejects.toThrow(/lifetime budget/);
    expect(lifetime.post).not.toHaveBeenCalled();
  });

  it("refuses when the proposal's account does not own the campaign", async () => {
    const { provider, post } = providerWith({ get: () => campaignRow() });
    await expect(
      provider.updateCampaignBudget({ account_id: "act_222", campaign_id: "999", daily_budget_cents: 5000 }),
    ).rejects.toThrow(/belongs to ad account act_111/);
    expect(post).not.toHaveBeenCalled();
  });

  it("raises a verification error when the read-back differs", async () => {
    const { provider } = providerWith({
      get: (path, params) => {
        if (path === "act_111") return { currency: "USD" };
        if (String(params.fields).includes("account_id")) return campaignRow();
        return { daily_budget: "3000", status: "ACTIVE" };
      },
    });
    await expect(
      provider.updateCampaignBudget({ campaign_id: "999", daily_budget_cents: 3600 }),
    ).rejects.toBeInstanceOf(ExecutionVerificationError);
  });
});

describe("optimizeBudget with a campaign budget (CBO)", () => {
  type AdSetIn = { id: string; status?: string; spend: number; leads: number };
  function cboAccount(campaign: { daily_budget: string }, adsets: AdSetIn[]) {
    return providerWith({
      get: (path) => {
        if (path === "act_111") return { currency: "USD" };
        if (path === "act_111/campaigns") {
          return { data: [{ id: "999", name: "TR | Lead Gen", status: "ACTIVE", objective: "OUTCOME_LEADS", ...campaign }] };
        }
        if (path === "act_111/adsets") {
          return {
            data: adsets.map((a) => ({
              id: a.id,
              name: `Ad set ${a.id}`,
              status: a.status ?? "ACTIVE",
              campaign_id: "999",
              daily_budget: "0",
            })),
          };
        }
        if (path === "act_111/insights") {
          return {
            data: adsets.map((a) => ({
              adset_id: a.id,
              adset_name: `Ad set ${a.id}`,
              spend: String(a.spend),
              clicks: "40",
              ctr: "1.2",
              actions: a.leads ? [{ action_type: "lead", value: String(a.leads) }] : [],
            })),
          };
        }
        throw new Error(`unexpected GET ${path}`);
      },
    });
  }
  const proposalsOf = async (provider: MetaGraphProviderV2) =>
    ((await provider.optimizeBudget("act_111")).structured?.proposals ?? []) as Array<{
      tool: string;
      args: Record<string, unknown>;
    }>;

  it("scales a converting CBO campaign and pauses its ad set that spent with no results", async () => {
    const { provider } = cboAccount({ daily_budget: "3000" }, [
      { id: "777", spend: 80, leads: 4 },
      { id: "778", spend: 40, leads: 0 },
    ]);
    const proposals = await proposalsOf(provider);
    expect(proposals).toContainEqual(
      expect.objectContaining({
        tool: "update_campaign_budget",
        args: expect.objectContaining({ campaign_id: "999", daily_budget_cents: 3600, previous_daily_budget_cents: 3000 }),
      }),
    );
    expect(proposals).toContainEqual(
      expect.objectContaining({ tool: "pause_adset", args: { account_id: "act_111", adset_id: "778" } }),
    );
    expect(proposals.some((p) => p.tool === "update_adset_budget")).toBe(false);
  });

  it("trims a CBO campaign that spent with no results, without pausing its ad sets", async () => {
    const { provider } = cboAccount({ daily_budget: "3000" }, [
      { id: "777", spend: 60, leads: 0 },
      { id: "778", spend: 40, leads: 0 },
    ]);
    const proposals = await proposalsOf(provider);
    expect(proposals).toEqual([
      expect.objectContaining({
        tool: "update_campaign_budget",
        args: expect.objectContaining({ campaign_id: "999", daily_budget_cents: 2400 }),
      }),
    ]);
  });

  it("never proposes pausing the campaign's last live ad set", async () => {
    const { provider } = cboAccount({ daily_budget: "3000" }, [
      { id: "777", spend: 80, leads: 4 },
      { id: "778", status: "PAUSED", spend: 0, leads: 0 },
      { id: "779", spend: 40, leads: 0 },
    ]);
    const pauses = (await proposalsOf(provider)).filter((p) => p.tool === "pause_adset");
    expect(pauses.map((p) => p.args.adset_id)).toEqual(["779"]);

    const single = cboAccount({ daily_budget: "3000" }, [{ id: "777", spend: 60, leads: 0 }]);
    expect((await proposalsOf(single.provider)).some((p) => p.tool === "pause_adset")).toBe(false);
  });
});

describe("status changes", () => {
  it("pauses and resumes ad sets with a verified read-back", async () => {
    let status = "ACTIVE";
    const { provider, post } = providerWith({
      get: (_path, params) =>
        String(params.fields) === "account_id"
          ? { account_id: "111" }
          : { name: "Broad AU", status, effective_status: status, campaign_id: "999" },
      post: (_path, body) => {
        status = String(body.status);
        return { success: true };
      },
    });
    await expect(provider.pauseAdSet("act_111", "777")).resolves.toMatchObject({
      id: "777",
      status: "PAUSED",
      campaign_id: "999",
      verified: true,
    });
    await expect(provider.resumeAdSet("act_111", "777")).resolves.toMatchObject({ status: "ACTIVE", verified: true });
    expect(post).toHaveBeenCalledWith("777", { status: "ACTIVE" });
  });

  it("refuses to change an ad set in another account", async () => {
    const { provider, post } = providerWith({ get: () => ({ account_id: "222" }) });
    await expect(provider.pauseAdSet("act_111", "777")).rejects.toThrow(/belongs to ad account act_222/);
    expect(post).not.toHaveBeenCalled();
  });

  it("resumes an ad", async () => {
    const { provider } = providerWith({
      get: (_path, params) =>
        String(params.fields) === "account_id"
          ? { account_id: "111" }
          : { name: "Ad 1", status: "ACTIVE", adset_id: "777", campaign_id: "999" },
    });
    await expect(provider.resumeAd("act_111", "555")).resolves.toMatchObject({ status: "ACTIVE", verified: true });
  });

  it("verifies resume_campaign reads back ACTIVE", async () => {
    const { provider } = providerWith({
      get: (_path, params) =>
        String(params.fields) === "account_id"
          ? { account_id: "111" }
          : { name: "Spring", status: "PAUSED" },
    });
    await expect(provider.resumeCampaign("act_111", "999")).rejects.toBeInstanceOf(
      ExecutionVerificationError,
    );
  });

  it("returns verified status for pause_ad", async () => {
    const { provider } = providerWith({
      get: (_path, params) =>
        String(params.fields) === "account_id"
          ? { account_id: "111" }
          : { name: "Ad 1", status: "PAUSED", effective_status: "PAUSED", adset_id: "777" },
    });
    await expect(provider.pauseAd("act_111", "555")).resolves.toMatchObject({
      status: "PAUSED",
      verified: true,
      adset_id: "777",
    });
  });
});

describe("create flows", () => {
  const baseCampaign = {
    account_id: "act_111",
    campaign_name: "Spring",
    objective: "OUTCOME_LEADS",
    budget_daily: 20,
    primary_text: "Hello",
    headline: "Hi",
    landing_page_url: "https://example.com",
    image_url: "https://example.com/a.jpg",
    locations: ["GB"],
    pixel_id: "42",
    facebook_page_id: "321",
  };

  it("validates before any POST (no location → nothing created)", async () => {
    const { provider, post } = providerWith({ get: () => ({ currency: "GBP" }) });
    await expect(
      provider.createImageCampaign({ ...baseCampaign, locations: [] }),
    ).rejects.toThrow(/No targeting location/);
    expect(post).not.toHaveBeenCalled();
  });

  it("leaves Advantage+ audience off for a Special Ad Category campaign", async () => {
    const posts: Array<[string, Record<string, unknown>]> = [];
    let n = 0;
    const { provider } = providerWith({
      get: () => ({ currency: "GBP" }),
      post: (path, body) => {
        posts.push([path, body]);
        n += 1;
        return { id: String(2000 + n) };
      },
    });
    await provider.createImageCampaign({ ...baseCampaign, special_ad_categories: ["HOUSING"] });
    const adset = posts.find(([p]) => p === "act_111/adsets")![1];
    expect(JSON.parse(String(adset.targeting)).targeting_automation).toEqual({ advantage_audience: 0 });
  });

  it("passes lifetime budget + end_time through and builds a valid creative", async () => {
    const posts: Array<[string, Record<string, unknown>]> = [];
    let n = 0;
    const { provider } = providerWith({
      get: () => ({ currency: "GBP" }),
      post: (path, body) => {
        posts.push([path, body]);
        n += 1;
        return { id: String(1000 + n) };
      },
    });
    const end = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await provider.createImageCampaign({
      ...baseCampaign,
      budget_daily: undefined,
      budget_lifetime: 140,
      end_time: end,
      call_to_action: "sign up",
      instagram_account_id: "888",
    });
    const adset = posts.find(([p]) => p === "act_111/adsets")![1];
    expect(adset.lifetime_budget).toBe("14000");
    expect(adset.end_time).toBe(end);
    expect(adset.daily_budget).toBeUndefined();
    expect(JSON.parse(String(adset.promoted_object))).toEqual({
      pixel_id: "42",
      custom_event_type: "LEAD",
      page_id: "321",
    });
    expect(JSON.parse(String(adset.targeting)).targeting_automation).toEqual({
      advantage_audience: 1,
    });

    const creative = posts.find(([p]) => p === "act_111/adcreatives")![1];
    const spec = JSON.parse(String(creative.object_story_spec));
    expect(spec.instagram_user_id).toBe("888");
    expect(spec.instagram_actor_id).toBeUndefined();
    expect(spec.link_data.picture).toBe("https://example.com/a.jpg");
    expect(spec.link_data.image_url).toBeUndefined();
    expect(spec.link_data.call_to_action.type).toBe("SIGN_UP");
  });

  it("does not hard-code an ad set bid strategy or budget under CBO", async () => {
    const posts: Array<[string, Record<string, unknown>]> = [];
    const { provider } = providerWith({
      get: () => ({ currency: "GBP" }),
      post: (path, body) => {
        posts.push([path, body]);
        return { id: String(posts.length + 10) };
      },
    });
    await provider.createImageCampaign({ ...baseCampaign, campaign_budget_optimization: true });
    const campaign = posts.find(([p]) => p === "act_111/campaigns")![1];
    expect(campaign.daily_budget).toBe("2000");
    expect(campaign.bid_strategy).toBe("LOWEST_COST_WITHOUT_CAP");
    const adset = posts.find(([p]) => p === "act_111/adsets")![1];
    expect(adset.daily_budget).toBeUndefined();
    expect(adset.bid_strategy).toBeUndefined();
  });

  it("standalone create_adset under an existing CBO campaign sends no budget", async () => {
    const { provider, post } = providerWith({
      get: (path) =>
        path === "999"
          ? { account_id: "111", objective: "OUTCOME_TRAFFIC", daily_budget: "5000" }
          : { currency: "USD" },
      post: () => ({ id: "4242" }),
    });
    const res = await provider.createAdSet({
      account_id: "act_111",
      campaign_id: "999",
      budget_daily: 10,
      landing_page_url: "https://example.com",
      primary_text: "x",
      locations: ["US"],
    });
    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.daily_budget).toBeUndefined();
    expect(body.bid_strategy).toBeUndefined();
    expect(res.budget_note).toMatch(/campaign budget/);
  });

  it("reports created IDs on a mid-run failure and resumes without duplicates", async () => {
    let failCreative = true;
    const posts: string[] = [];
    const { provider } = providerWith({
      get: (_path, params) =>
        String(params.fields) === "account_id" ? { account_id: "111" } : { currency: "GBP" },
      post: (path) => {
        posts.push(path);
        if (path === "act_111/campaigns") return { id: "501" };
        if (path === "act_111/adsets") return { id: "502" };
        if (path === "act_111/adcreatives") {
          if (failCreative) throw new Error("Invalid image");
          return { id: "503" };
        }
        return { id: "504" };
      },
    });
    const progress: unknown[] = [];
    let caught: unknown;
    try {
      await provider.createImageCampaign({
        ...baseCampaign,
        onProgress: (p) => {
          progress.push(p);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PartialCreateError);
    const partial = caught as PartialCreateError;
    expect(partial.progress).toEqual({ campaign_id: "501", adset_id: "502" });
    expect(partial.message).toMatch(/campaign 501, ad set 502/);
    expect(progress.length).toBe(2);

    failCreative = false;
    posts.length = 0;
    const done = await provider.createImageCampaign({
      ...baseCampaign,
      resume: partial.progress,
    });
    expect(posts).toEqual(["act_111/adcreatives", "act_111/ads"]);
    expect(done.campaign.id).toBe("501");
    expect(done.adset?.id).toBe("502");
  });
});

describe("formatGraphError", () => {
  it("leads with Meta's user message, then the hint and fbtrace_id", () => {
    const message = formatGraphError(
      {
        message: "Invalid parameter",
        error_user_title: "Budget too low",
        error_user_msg: "Your budget must be at least £1.00",
        code: 100,
        error_subcode: 1487061,
        fbtrace_id: "AbC123",
      },
      "fallback",
    );
    expect(message.indexOf("Your budget must be at least")).toBeLessThan(
      message.indexOf("Missing daily ad set budget"),
    );
    expect(message).toMatch(/fbtrace_id AbC123/);
  });

  it("never tells the operator to simply retry a temporary error", () => {
    const message = formatGraphError({ message: "Service temporarily unavailable", code: 2 }, "x");
    expect(message).toMatch(/duplicate/);
    expect(message).not.toMatch(/retry helps/);
  });
});
