import { describe, expect, it } from "vitest";
import { assessRisk } from "@/lib/approvals/risk";

/**
 * A cap is a ceiling on what a result may cost. Moving it up lets the ad set pay more per
 * result, so a big raise (or a big drop in a ROAS floor) needs an admin, like going uncapped.
 */
const bid = (args: Record<string, unknown>, before?: Record<string, unknown>) =>
  assessRisk("update_adset_bid", { adset_id: "as_1", ...args, ...(before ? { __before: before } : {}) }, {});

const wasCostCap30 = { bid_strategy: "COST_CAP", bid_amount_cents: 3000 };

describe("a bid cap raise", () => {
  it("a large raise is high risk and says by how much", () => {
    const risk = bid({ bid_strategy: "COST_CAP", bid_amount: 40 }, wasCostCap30);
    expect(risk.level).toBe("high");
    expect(risk.reason).toMatch(/33%/);
  });

  it("a small raise is medium", () => {
    expect(bid({ bid_strategy: "COST_CAP", bid_amount: 35 }, wasCostCap30).level).toBe("medium");
  });

  it("exactly a quarter is still medium; just over is high", () => {
    expect(bid({ bid_strategy: "COST_CAP", bid_amount: 37.5 }, wasCostCap30).level).toBe("medium");
    expect(bid({ bid_strategy: "COST_CAP", bid_amount: 37.6 }, wasCostCap30).level).toBe("high");
  });

  it("lowering the cap is medium, however far", () => {
    expect(bid({ bid_strategy: "COST_CAP", bid_amount: 10 }, wasCostCap30).level).toBe("medium");
  });

  it("a cap that cannot be compared (a different strategy, or no current cap) stays medium", () => {
    expect(bid({ bid_strategy: "LOWEST_COST_WITH_BID_CAP", bid_amount: 90 }, wasCostCap30).level).toBe("medium");
    expect(bid({ bid_strategy: "COST_CAP", bid_amount: 90 }, { bid_strategy: "COST_CAP", bid_amount_cents: null }).level).toBe("medium");
    expect(bid({ bid_strategy: "COST_CAP", bid_amount: 90 }).level).toBe("medium");
  });
});

describe("a minimum ROAS drop", () => {
  const wasFloor = { bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2.5 };

  it("a large drop is high risk", () => {
    const risk = bid({ bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 1.5 }, wasFloor);
    expect(risk.level).toBe("high");
    expect(risk.reason).toMatch(/40%/);
  });

  it("a small drop, or a raise, is medium", () => {
    expect(bid({ bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 2.2 }, wasFloor).level).toBe("medium");
    expect(bid({ bid_strategy: "LOWEST_COST_WITH_MIN_ROAS", roas_average_floor: 4 }, wasFloor).level).toBe("medium");
  });
});

describe("going uncapped is still high", () => {
  it("from a cap, or from a state that could not be read", () => {
    expect(bid({ bid_strategy: "LOWEST_COST_WITHOUT_CAP" }, wasCostCap30).level).toBe("high");
    expect(bid({ bid_strategy: "LOWEST_COST_WITHOUT_CAP" }).level).toBe("high");
  });
});
