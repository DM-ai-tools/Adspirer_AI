import { describe, expect, it } from "vitest";
import { assessRisk } from "@/lib/approvals/risk";
import { approve, createPendingApproval, edit } from "@/lib/approvals/service";

const goals = (max_budget_change_pct?: number) => ({ goals_profile: max_budget_change_pct ? { max_budget_change_pct } : {} });
const budget = (prev: number | undefined, next: number) => ({
  daily_budget_cents: next,
  ...(prev != null ? { previous_daily_budget_cents: prev } : {}),
});

describe("assessRisk", () => {
  it("rates pauses and budget decreases low", () => {
    expect(assessRisk("pause_campaign", {}, goals()).level).toBe("low");
    expect(assessRisk("pause_adset", {}, goals()).level).toBe("low");
    expect(assessRisk("update_adset_budget", budget(5000, 4000), goals()).level).toBe("low");
  });

  it("rates an increase within the client's max change medium, above it high", () => {
    expect(assessRisk("update_campaign_budget", budget(5000, 6000), goals()).level).toBe("medium"); // +20%
    const big = assessRisk("update_campaign_budget", budget(5000, 6100), goals()); // +22%
    expect(big.level).toBe("high");
    expect(big.reason).toMatch(/22%.*20%/);
    expect(assessRisk("update_campaign_budget", budget(5000, 7000), goals(50)).level).toBe("medium");
  });

  it("rates an increase with an unknown current budget high", () => {
    expect(assessRisk("update_adset_budget", budget(undefined, 6000), goals()).reason).toMatch(/current budget/);
    expect(assessRisk("update_adset_budget", budget(undefined, 6000), goals()).level).toBe("high");
  });

  it("rates anything that restarts spend high, and paused creates medium", () => {
    expect(assessRisk("resume_campaign", {}, goals()).level).toBe("high");
    expect(assessRisk("resume_adset", {}, goals()).level).toBe("high");
    expect(assessRisk("resume_ad", {}, goals()).level).toBe("medium");
    expect(assessRisk("create_meta_image_campaign", {}, goals()).level).toBe("medium");
    expect(assessRisk("create_campaign", { status: "ACTIVE" }, goals()).level).toBe("high");
  });
});

describe("risk level on approvals", () => {
  const CLIENT_ID = "client_modern_dental";
  const args = (next: number) => ({
    account_id: "act_100200300",
    adset_id: "adset_mdc_npl_1",
    daily_budget_cents: next,
    previous_daily_budget_cents: 4000,
  });

  it("stores the risk level and reason when queued, and recomputes it on edit", async () => {
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "update_adset_budget", proposedArgs: args(4400) });
    expect(queued.risk_level).toBe("medium");
    const edited = await edit({ approvalId: queued.id, reviewedBy: "profile_admin_demo", editedArgs: args(6000) });
    expect(edited.risk_level).toBe("high");
    expect(edited.risk_reason).toMatch(/50%/);
  });

  it("keeps the risk level through approval", async () => {
    const queued = await createPendingApproval({ clientId: CLIENT_ID, toolName: "pause_campaign", proposedArgs: { account_id: "act_100200300", campaign_id: "camp_mdc_npl" } });
    const approved = await approve({ approvalId: queued.id, reviewedBy: "profile_admin_demo" });
    expect(approved.risk_level).toBe("low");
  });
});
