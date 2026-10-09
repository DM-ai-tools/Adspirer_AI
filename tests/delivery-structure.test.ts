import { describe, expect, it } from "vitest";
import type { MetaAd, MetaAdSet, MetaCampaign } from "@/lib/adspirer/provider";
import {
  asksAboutDeliveryStructure,
  formatDeliveryStructure,
  pickStructureCampaigns,
} from "@/lib/agent/delivery-structure";

const campaign = (id: string, name: string, status: MetaCampaign["status"], daily?: number): MetaCampaign => ({
  id,
  account_id: "act_1",
  name,
  status,
  objective: "OUTCOME_LEADS",
  daily_budget_cents: daily,
});

const CAMPAIGNS = [
  campaign("111", "TR | Lead Gen Traffic Radius | Sep 2026", "ACTIVE", 3000),
  campaign("222", "Brand awareness", "PAUSED"),
  campaign("333", "Retargeting 30d", "ACTIVE"),
];

const adSet = (id: string, name: string, effective: string, daily = 0): MetaAdSet => ({
  id,
  campaign_id: "111",
  account_id: "act_1",
  name,
  status: effective === "ACTIVE" ? "ACTIVE" : "PAUSED",
  effective_status: effective,
  daily_budget_cents: daily,
});

const ad = (id: string, name: string, adsetId: string, effective: string): MetaAd => ({
  id,
  adset_id: adsetId,
  campaign_id: "111",
  account_id: "act_1",
  name,
  status: effective === "ACTIVE" ? "ACTIVE" : "PAUSED",
  effective_status: effective,
});

const money = (n: number) => `$${n.toFixed(2)}`;

describe("asksAboutDeliveryStructure", () => {
  it("catches status questions about campaigns, ad sets and ads", () => {
    expect(asksAboutDeliveryStructure("under this campaign are there any ad sets active")).toBe(true);
    expect(asksAboutDeliveryStructure("Are there any active campaigns running right now")).toBe(true);
    expect(asksAboutDeliveryStructure("which ads are paused?")).toBe(true);
    expect(asksAboutDeliveryStructure("what does CPM mean")).toBe(false);
  });
});

describe("pickStructureCampaigns", () => {
  it("uses campaigns named or ID'd in the question", () => {
    expect(pickStructureCampaigns("ad sets in Retargeting 30d?", CAMPAIGNS).map((c) => c.id)).toEqual(["333"]);
    expect(pickStructureCampaigns("status of 222", CAMPAIGNS).map((c) => c.id)).toEqual(["222"]);
  });

  it("resolves 'this campaign' from the previous reply", () => {
    const history = [
      { role: "user" as const, content: "any active campaigns?" },
      { role: "assistant" as const, content: "Yes: TR | Lead Gen Traffic Radius | Sep 2026 (111)" },
    ];
    expect(
      pickStructureCampaigns("under this campaign are there any ad sets active", CAMPAIGNS, history).map((c) => c.id),
    ).toEqual(["111"]);
  });

  it("falls back to every campaign that is switched on", () => {
    expect(pickStructureCampaigns("is anything running?", CAMPAIGNS).map((c) => c.id)).toEqual(["111", "333"]);
  });
});

describe("formatDeliveryStructure", () => {
  it("reports an ACTIVE campaign whose ad sets are all off as not delivering", () => {
    const text = formatDeliveryStructure(
      [
        {
          campaign: CAMPAIGNS[0]!,
          adSets: [
            adSet("a1", "Broad - Job title | Google Scale", "PAUSED"),
            adSet("a2", "Broad - Job title | Google consult", "PAUSED"),
          ],
          ads: [
            ad("x1", "Vision Text Testimonial | Video | Sep 2026", "a1", "ADSET_PAUSED"),
            ad("x2", "Video Ad | Consult | Oct 2026", "a2", "DISAPPROVED"),
          ],
        },
      ],
      money,
    );
    expect(text).toContain("AD SETS: 2 total, 0 ACTIVE");
    expect(text).toContain('AD SET "Broad - Job title | Google Scale" (ad set ID a1) · OFF (paused) · uses the campaign budget');
    expect(text).toContain('AD "Vision Text Testimonial | Video | Sep 2026" (ad ID x1) · OFF (its ad set is paused)');
    expect(text).toContain("REJECTED by Meta review");
    expect(text).toContain("NOT DELIVERING: the campaign is switched on but every ad set is off");
    expect(text).toContain("campaign budget $30.00/day");
  });

  it("says when ad sets could not be loaded instead of inventing them", () => {
    const text = formatDeliveryStructure(
      [{ campaign: CAMPAIGNS[2]!, adSets: null, ads: null, error: "rate limited" }],
      money,
    );
    expect(text).toContain("could not be loaded: rate limited");
  });

  it("marks a campaign with active ad sets and ads as able to deliver", () => {
    const text = formatDeliveryStructure(
      [
        {
          campaign: CAMPAIGNS[2]!,
          adSets: [adSet("b1", "Visitors", "ACTIVE", 2500)],
          ads: [ad("y1", "Offer video", "b1", "ACTIVE")],
        },
      ],
      money,
    );
    expect(text).toContain("own budget $25.00/day");
    expect(text).toContain("Can deliver: 1 active ad set, 1 active ad");
  });
});
