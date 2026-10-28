import { describe, expect, it } from "vitest";
import { planBidChange, type BidCurrent } from "@/lib/meta/adset-edits";

const abo: BidCurrent = {
  cbo: false,
  objective: "OUTCOME_SALES",
  optimization_goal: "VALUE",
  bid_strategy: "LOWEST_COST_WITHOUT_CAP",
  bid_amount_minor: null,
  roas_floor: null,
  currency: "USD",
};
const bid = (current: Partial<BidCurrent>, change: Parameters<typeof planBidChange>[1]) =>
  planBidChange({ ...abo, ...current }, change);

describe("planBidChange", () => {
  it("sets a cost cap in the account's minor units", () => {
    expect(bid({}, { bid_strategy: "COST_CAP", bid_amount: 30 }).body).toEqual({ bid_strategy: "COST_CAP", bid_amount: "3000" });
    expect(bid({}, { bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: 12.5 }).body).toEqual({
      bid_strategy: "LOWEST_COST_WITH_BID_CAP",
      bid_amount: "1250",
    });
  });

  it("uses the currency's own offset (JPY has none)", () => {
    expect(bid({ currency: "JPY" }, { bid_strategy: "COST_CAP", bid_amount: 3000 }).body.bid_amount).toBe("3000");
  });

  it("sets a minimum ROAS for a Sales ad set optimising for value", () => {
    const out = bid({}, { bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2.5 });
    expect(out.body.bid_strategy).toBe("LOWEST_COST_WITH_MIN_ROAS");
    expect(JSON.parse(out.body.bid_constraints!)).toEqual({ roas_average_floor: 25000 });
  });

  it("refuses a minimum ROAS unless it is a Sales ad set optimising for value", () => {
    expect(() => bid({ objective: "OUTCOME_LEADS" }, { bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2 })).toThrow(
      /Sales.*Nothing was changed/,
    );
    expect(() =>
      bid({ optimization_goal: "OFFSITE_CONVERSIONS" }, { bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2 }),
    ).toThrow(/purchase value.*Nothing was changed/);
  });

  it("refuses an ad set under a campaign budget: that bid strategy lives on the campaign", () => {
    expect(() => bid({ cbo: true }, { bid_strategy: "COST_CAP", bid_amount: 30 })).toThrow(
      /campaign budget.*Ads Manager.*Nothing was changed/,
    );
  });

  it("going uncapped sends no amount and says whether a control was removed", () => {
    const out = bid({ bid_strategy: "COST_CAP", bid_amount_minor: 3000 }, { bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    expect(out.body).toEqual({ bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
    expect(out.fromCapped).toBe(true);
    expect(out.toUncapped).toBe(true);
    expect(bid({}, { bid_strategy: "COST_CAP", bid_amount: 30 }).toUncapped).toBe(false);
  });

  it("refuses values that do not belong to the strategy", () => {
    expect(() => bid({}, { bid_strategy: "COST_CAP" })).toThrow(/needs bid_amount/);
    expect(() => bid({}, { bid_strategy: "LOWEST_COST_WITHOUT_CAP", bid_amount: 30 })).toThrow(/only applies/);
    expect(() => bid({}, { bid_strategy: "COST_CAP", bid_amount: 30, roas_average_floor: 2 })).toThrow(/only applies/);
    expect(() => bid({}, { bid_strategy: "NOT_A_STRATEGY" })).toThrow(/Unknown bid_strategy/);
  });

  it("refuses a change that changes nothing", () => {
    expect(() => bid({ bid_strategy: "COST_CAP", bid_amount_minor: 3000 }, { bid_strategy: "COST_CAP", bid_amount: 30 })).toThrow(/already/);
    expect(() => bid({}, { bid_strategy: "LOWEST_COST_WITHOUT_CAP" })).toThrow(/already/);
  });
});
