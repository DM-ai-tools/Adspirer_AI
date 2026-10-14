import { describe, expect, it } from "vitest";
import { buildFullOptimizeProposals } from "@/lib/agent/optimize-proposals";
import type { MetaAdsProvider, MetaInsights } from "@/lib/adspirer/provider";

const ACCOUNT = "act_1";

function provider(opts: { siblingTargeting?: Record<string, unknown> } = {}): MetaAdsProvider {
  const insights = (id: string, conversions: number, spend: number): MetaInsights => ({
    account_id: ACCOUNT,
    entity_id: id,
    entity_type: "campaign",
    date_start: "2026-07-01",
    date_stop: "2026-10-01",
    spend,
    impressions: 10_000,
    clicks: 200,
    ctr: 2,
    cpc: 0.5,
    conversions,
  });
  return {
    listCampaigns: async () => [
      { id: "c_live", account_id: ACCOUNT, name: "Live leads", status: "ACTIVE", objective: "OUTCOME_LEADS" },
      { id: "c_proven", account_id: ACCOUNT, name: "Old winner", status: "PAUSED", objective: "OUTCOME_LEADS", daily_budget_cents: 3000 },
      { id: "c_dud", account_id: ACCOUNT, name: "Old dud", status: "PAUSED", objective: "OUTCOME_LEADS", daily_budget_cents: 5000 },
    ],
    listAdSets: async () => [
      {
        id: "as_live",
        campaign_id: "c_live",
        account_id: ACCOUNT,
        name: "Broad AU",
        status: "ACTIVE",
        daily_budget_cents: 2000,
        targeting_summary: JSON.stringify(opts.siblingTargeting ?? { geo_locations: { countries: ["AU", "NZ"] } }),
      },
    ],
    getAdCreatives: async () => [
      {
        ad_id: "ad1",
        campaign_id: "c_live",
        landing_page_url: "https://example.com/lp",
        primary_text: "Book a consult",
        headline: "Consults",
      },
    ],
    getCampaignInsights: async (_a: string, id: string) =>
      id === "c_proven" ? insights(id, 7, 140) : insights(id, 0, 90),
  } as unknown as MetaAdsProvider;
}

describe("buildFullOptimizeProposals", () => {
  it("proposes resuming a paused campaign only when it produced results", async () => {
    const bundle = await buildFullOptimizeProposals({ provider: provider(), accountId: ACCOUNT });
    const resumes = bundle.proposals.filter((p) => p.name === "resume_campaign");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.args).toMatchObject({ campaign_id: "c_proven", daily_budget_cents: 3000 });
    expect(resumes[0]!.rationale).toMatch(/7 results/);
    expect(bundle.blockedLines.join("\n")).toMatch(/Old dud/);
  });

  it("proposes a broad ad set with Advantage+ audience and the sibling's countries", async () => {
    const bundle = await buildFullOptimizeProposals({ provider: provider(), accountId: ACCOUNT });
    const adset = bundle.proposals.find((p) => p.name === "create_adset");
    expect(adset?.args).toMatchObject({ campaign_id: "c_live", advantage_audience: true, locations: ["AU", "NZ"] });
    // It is created without an ad, and says so.
    expect(bundle.queueableLines.join("\n")).toMatch(/no ad yet/);
  });

  it("does not propose a broad ad set when no location can be taken from a sibling", async () => {
    const bundle = await buildFullOptimizeProposals({
      provider: provider({ siblingTargeting: { geo_locations: { cities: [{ key: "123" }] } } }),
      accountId: ACCOUNT,
    });
    expect(bundle.proposals.some((p) => p.name === "create_adset")).toBe(false);
    expect(bundle.blockedLines.join("\n")).toMatch(/needs a location/);
  });
});
