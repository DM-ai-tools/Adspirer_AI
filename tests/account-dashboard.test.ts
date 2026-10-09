import { describe, expect, it } from "vitest";
import {
  buildAccountDashboard,
  resultLabelFor,
} from "@/lib/meta/account-dashboard";
import type { MetaGraphClient } from "@/lib/meta/graph-client";

type Params = Record<string, unknown>;

/** Minimal Graph stub keyed by path (+ level / time_increment for insights). */
function fakeGraph(
  currency: string,
  overrides: Partial<Record<string, unknown>> = {},
): MetaGraphClient {
  const responses: Record<string, unknown> = {
    account: {
      name: "Dental Co",
      currency,
      timezone_name: "Asia/Tokyo",
      account_status: 1,
      disable_reason: 0,
      amount_spent: "120000",
      spend_cap: "200000",
      balance: "5000",
    },
    totals: {
      data: [
        {
          spend: "35000",
          impressions: "100000",
          reach: "60000",
          frequency: "1.67",
          clicks: "900",
          inline_link_clicks: "700",
          ctr: "0.9",
          cpc: "38.8",
          cpm: "350",
          actions: [
            { action_type: "link_click", value: "700" },
            { action_type: "lead", value: "14" },
          ],
          date_start: "2026-10-01",
          date_stop: "2026-10-07",
        },
      ],
    },
    daily: {
      data: [
        { date_start: "2026-10-02", spend: "5000" },
        { date_start: "2026-10-01", spend: "4000" },
      ],
    },
    campaignInsights: {
      data: [
        {
          campaign_id: "c1",
          campaign_name: "Implants",
          spend: "30000",
          inline_link_click_ctr: "1.1",
          // Meta's own Results for the campaign's optimisation goal.
          results: [{ indicator: "actions:lead", values: [{ value: "12" }] }],
          cost_per_result: [
            { indicator: "actions:lead", values: [{ value: "2500" }] },
          ],
        },
      ],
    },
    // CBO campaign with a ¥4,000 daily budget (offset 1 → "4000").
    campaigns: {
      data: [
        { id: "c1", name: "Implants", objective: "OUTCOME_LEADS", effective_status: "ACTIVE", daily_budget: "4000" },
      ],
    },
    // ABO ad set with ¥1,000/day, plus one under the CBO campaign (no budget).
    adsets: {
      data: [
        { id: "a1", campaign_id: "c2", daily_budget: "1000" },
        { id: "a2", campaign_id: "c1" },
      ],
    },
    ...overrides,
  };

  return {
    async get(path: string, params: Params = {}) {
      if (path.endsWith("/insights")) {
        if (params.date_preset === "maximum") {
          return responses.lifetime ?? { data: [] };
        }
        if (params.time_increment) return responses.daily;
        if (params.level === "campaign") return responses.campaignInsights;
        return responses.totals;
      }
      if (path.endsWith("/campaigns")) return responses.campaigns;
      if (path.endsWith("/adsets")) return responses.adsets;
      if (responses.account instanceof Error) throw responses.account;
      return responses.account;
    },
  } as unknown as MetaGraphClient;
}

describe("buildAccountDashboard", () => {
  it("sums allotted daily budgets across CBO campaigns and ABO ad sets", async () => {
    const dash = await buildAccountDashboard(fakeGraph("JPY"), "123", "7d");
    // ¥4,000 + ¥1,000 per day, in app cents.
    expect(dash.budget.dailyAllottedCents).toBe(500_000);
    expect(dash.budget.activeCampaigns).toBe(1);
    expect(dash.range.days).toBe(7);
    expect(dash.budget.expectedSpendCents).toBe(3_500_000);
    // Spent ¥35,000 of ¥35,000 allotted.
    expect(dash.totals.spendCents).toBe(3_500_000);
    expect(dash.budget.pacing).toBeCloseTo(1);
  });

  it("converts billing figures with the account currency offset", async () => {
    const dash = await buildAccountDashboard(fakeGraph("JPY"), "act_123", "7d");
    expect(dash.account.id).toBe("act_123");
    expect(dash.account.amountSpentCents).toBe(12_000_000); // ¥120,000
    expect(dash.account.spendCapCents).toBe(20_000_000);
    const usd = await buildAccountDashboard(fakeGraph("USD"), "act_123", "7d");
    expect(usd.account.amountSpentCents).toBe(120_000); // $1,200.00
  });

  it("uses Meta's Results per campaign and sorts daily rows", async () => {
    const dash = await buildAccountDashboard(fakeGraph("USD"), "1", "30d");
    // One goal across campaigns → the account total is their sum.
    expect(dash.totals.resultLabel).toBe("Leads");
    expect(dash.totals.results).toBe(12);
    expect(dash.daily.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(dash.campaigns[0]).toMatchObject({
      id: "c1",
      results: 12,
      resultLabel: "Leads",
      costPerResultCents: 250_000,
      linkCtr: 1.1,
      status: "ACTIVE",
    });
    expect(dash.activeCampaigns.map((c) => c.id)).toEqual(["c1"]);
  });

  it("never invents results: no indicator → none, mixed goals → no total", async () => {
    const dash = await buildAccountDashboard(
      fakeGraph("USD", {
        campaignInsights: {
          data: [
            {
              campaign_id: "c1",
              campaign_name: "Implants",
              spend: "300",
              results: [{ indicator: "actions:lead", values: [{ value: "3" }] }],
            },
            {
              campaign_id: "c9",
              campaign_name: "Video views",
              spend: "200",
              results: [
                { indicator: "video_thruplay_watched_actions", values: [{ value: "900" }] },
              ],
            },
            // Goal set but nothing converted: Ads Manager shows 0, not clicks.
            {
              campaign_id: "c8",
              campaign_name: "Registrations",
              spend: "100",
              results: [
                { indicator: "actions:offsite_conversion.fb_pixel_complete_registration" },
              ],
            },
          ],
        },
      }),
      "1",
      "30d",
    );
    expect(dash.totals.results).toBeNull();
    expect(dash.totals.resultLabel).toBe("Mixed goals");
    const reg = dash.campaigns.find((c) => c.id === "c8")!;
    expect(reg).toMatchObject({ results: 0, resultLabel: "Registrations", costPerResultCents: null });
  });

  it("labels Meta result indicators the way Ads Manager names them", () => {
    expect(resultLabelFor("actions:lead")).toBe("Leads");
    expect(resultLabelFor("actions:onsite_conversion.lead_grouped")).toBe("Leads");
    expect(resultLabelFor("actions:offsite_conversion.custom.1051623299883637")).toBe(
      "Custom conversions",
    );
    expect(resultLabelFor("conversions:offsite_conversion.fb_pixel_custom.Ecomm_Lead")).toBe(
      "Ecomm Lead",
    );
    expect(resultLabelFor("video_thruplay_watched_actions")).toBe("ThruPlays");
  });

  it("reports lifetime spend from insights, not the lagging billing counter", async () => {
    const dash = await buildAccountDashboard(
      fakeGraph("USD", {
        lifetime: { data: [{ spend: "1234.56" }] },
      }),
      "1",
      "7d",
    );
    expect(dash.account.lifetimeSpendCents).toBe(123_456);
    expect(dash.account.amountSpentCents).toBe(120_000);
  });

  it("keeps rendering when a secondary call fails", async () => {
    const graph = fakeGraph("USD");
    const original = graph.get.bind(graph);
    (graph as unknown as { get: typeof graph.get }).get = (async (
      path: string,
      params?: Params,
    ) => {
      if (path.endsWith("/adsets")) throw new Error("rate limited");
      return original(path, params as never);
    }) as typeof graph.get;
    const dash = await buildAccountDashboard(graph, "1", "7d");
    expect(dash.warnings.some((w) => w.includes("Ad set budgets"))).toBe(true);
    expect(dash.totals.spendCents).toBeGreaterThan(0);
  });
});
