import { describe, expect, it, vi } from "vitest";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";
import { ExecutionVerificationError } from "@/lib/errors";

type Handler = (path: string, params: Record<string, unknown>) => unknown;

function providerWith(handlers: { get: Handler; post?: Handler }) {
  const provider = new MetaGraphProviderV2("test-token");
  const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) => handlers.get(path, params));
  const post = vi.fn(async (path: string, body: Record<string, unknown> = {}) =>
    handlers.post ? handlers.post(path, body) : { success: true },
  );
  (provider as unknown as { graph: unknown }).graph = { get, post };
  return { provider, get, post };
}

describe("updateAdSetBid", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "777",
    name: "Prospecting",
    status: "ACTIVE",
    account_id: "111",
    campaign_id: "999",
    optimization_goal: "OFFSITE_CONVERSIONS",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    campaign: { id: "999", objective: "OUTCOME_LEADS", daily_budget: "0", lifetime_budget: "0" },
    ...over,
  });

  function setup(opts: { current?: Record<string, unknown>; after?: Record<string, unknown>; readFails?: boolean } = {}) {
    let written: Record<string, unknown> = {};
    return providerWith({
      get: (path, params) => {
        if (path === "act_111") return { currency: "USD" };
        if (path !== "777") throw new Error(`unexpected GET ${path}`);
        if (String(params.fields).includes("account_id")) return row(opts.current);
        if (opts.readFails) throw new Error("read-back unavailable");
        return { ...row(opts.current), ...written, ...opts.after };
      },
      post: (_p, body) => {
        written = body;
        return { success: true };
      },
    });
  }

  it("posts a cost cap in minor units and verifies the strategy and amount", async () => {
    const { provider, post } = setup();
    const result = await provider.updateAdSetBid({ adset_id: "777", bid_strategy: "COST_CAP", bid_amount: 30 });
    expect(post).toHaveBeenCalledWith("777", { bid_strategy: "COST_CAP", bid_amount: "3000" });
    expect(result).toMatchObject({
      account_id: "act_111",
      bid_strategy: "COST_CAP",
      bid_amount_cents: 3000,
      previous_bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      previous_bid_amount_cents: null,
      verified: true,
    });
  });

  it("fails when Meta accepted it but reads back a different strategy", async () => {
    const { provider } = setup({ after: { bid_strategy: "LOWEST_COST_WITHOUT_CAP" } });
    await expect(provider.updateAdSetBid({ adset_id: "777", bid_strategy: "COST_CAP", bid_amount: 30 })).rejects.toBeInstanceOf(
      ExecutionVerificationError,
    );
  });

  it("fails when the cap amount reads back differently", async () => {
    const { provider } = setup({ after: { bid_amount: "9999" } });
    await expect(provider.updateAdSetBid({ adset_id: "777", bid_strategy: "COST_CAP", bid_amount: 30 })).rejects.toBeInstanceOf(
      ExecutionVerificationError,
    );
  });

  it("reads the previous cap so it can be restored", async () => {
    const { provider } = setup({ current: { bid_strategy: "COST_CAP", bid_amount: "2500" } });
    const result = await provider.updateAdSetBid({ adset_id: "777", bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    expect(result.previous_bid_strategy).toBe("COST_CAP");
    expect(result.previous_bid_amount_cents).toBe(2500);
  });

  it("verifies a minimum ROAS from bid_constraints", async () => {
    const { provider, post } = setup({
      current: { optimization_goal: "VALUE", campaign: { id: "999", objective: "OUTCOME_SALES", daily_budget: "0", lifetime_budget: "0" } },
      after: { bid_constraints: { roas_average_floor: 25000 } },
    });
    const result = await provider.updateAdSetBid({ adset_id: "777", bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2.5 });
    expect(JSON.parse(String((post.mock.calls[0]![1] as Record<string, unknown>).bid_constraints))).toEqual({ roas_average_floor: 25000 });
    expect(result).toMatchObject({ roas_average_floor: 2.5, verified: true });
  });

  it("refuses an ad set under a campaign budget and posts nothing", async () => {
    const { provider, post } = setup({
      current: { campaign: { id: "999", objective: "OUTCOME_LEADS", daily_budget: "5000", lifetime_budget: "0" } },
    });
    await expect(provider.updateAdSetBid({ adset_id: "777", bid_strategy: "COST_CAP", bid_amount: 30 })).rejects.toThrow(
      /campaign budget.*Nothing was changed/,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses another account's ad set and posts nothing", async () => {
    const { provider, post } = setup();
    await expect(
      provider.updateAdSetBid({ account_id: "act_222", adset_id: "777", bid_strategy: "COST_CAP", bid_amount: 30 }),
    ).rejects.toThrow(/belongs to ad account act_111, not act_222. Nothing was changed/);
    expect(post).not.toHaveBeenCalled();
  });

  it("reports unverified, without failing, when the read-back fails", async () => {
    const { provider } = setup({ readFails: true });
    const result = await provider.updateAdSetBid({ adset_id: "777", bid_strategy: "COST_CAP", bid_amount: 30 });
    expect(result.verified).toBe(false);
  });
});
