import { describe, expect, it, vi } from "vitest";
import type { MetaAdsProvider } from "@/lib/adspirer/provider";
import { buildOptimizeEvidence } from "@/lib/agent/optimize-evidence";
import { EMPTY_QUEUE, type RequestBrief } from "@/lib/agent/request-brief";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { resolveGoals } from "@/lib/clients/goals";
import { updateAdsetPlacementsSchema } from "@/lib/tools/execute/schemas";

const ACCOUNT = "act_1";
const PERIOD = { since: "2026-10-21", until: "2026-10-27", label: "last 7 days", explicit: false };

const brief = (over: Partial<RequestBrief> = {}): RequestBrief => ({
  intent: "optimize",
  mode: "analyse",
  focus: ["placements"],
  scope: { mentions: [] },
  exclude: [],
  period: PERIOD,
  queue: { ...EMPTY_QUEUE },
  optimizationAsk: true,
  source: "rules",
  ...over,
});

const MANUAL = {
  geo_locations: { countries: ["AU"] },
  publisher_platforms: ["facebook", "instagram", "audience_network"],
  facebook_positions: ["feed", "story"],
  instagram_positions: ["stream"],
  audience_network_positions: ["classic"],
};

const row = (adset: string, platform: string, position: string, spend: number, leads: number) => ({
  adset_id: adset,
  adset_name: adset,
  publisher_platform: platform,
  platform_position: position,
  spend,
  impressions: spend * 100,
  ...(leads > 0 ? { actions: { lead: leads } } : {}),
});

function stub(opts: { rows?: Array<Record<string, unknown>>; hasMore?: boolean; insightsThrows?: boolean; adsetExtra?: Record<string, unknown> } = {}) {
  const adsets = [
    { id: "as_1", campaign_id: "demo_campaign_1", account_id: ACCOUNT, name: "Implants Broad", status: "ACTIVE", daily_budget_cents: 3000, custom_event_type: "LEAD", optimization_goal: "OFFSITE_CONVERSIONS", targeting_summary: JSON.stringify(MANUAL), ...opts.adsetExtra },
    { id: "as_2", campaign_id: "demo_campaign_1", account_id: ACCOUNT, name: "Implants Advantage", status: "ACTIVE", daily_budget_cents: 3000, custom_event_type: "LEAD", optimization_goal: "OFFSITE_CONVERSIONS", targeting_summary: JSON.stringify({ geo_locations: { countries: ["AU"] } }) },
    { id: "as_4", campaign_id: "demo_campaign_3", account_id: ACCOUNT, name: "Brand Visitors", status: "ACTIVE", daily_budget_cents: 1500, custom_event_type: "LEAD", optimization_goal: "OFFSITE_CONVERSIONS", targeting_summary: JSON.stringify(MANUAL) },
  ];
  const getInsightsReport = vi.fn(async (_a: string, query: { campaign_ids?: string[]; adset_ids?: string[] }) => {
    if (opts.insightsThrows) throw new Error("breakdown unavailable");
    const rows = (opts.rows ?? []).filter((r) => {
      if (query.adset_ids?.length) return query.adset_ids.includes(String(r.adset_id));
      if (query.campaign_ids?.length) return query.campaign_ids.includes(adsets.find((a) => a.id === r.adset_id)?.campaign_id ?? "");
      return true;
    });
    return { currency: "USD", rows, has_more: opts.hasMore ?? false };
  });
  const getAuditSnapshot = vi.fn(async (_a: string, options: Record<string, unknown> = {}) => demoMetaAuditSnapshot(ACCOUNT, "Demo", options as never));
  const optimizeBudget = vi.fn();
  const provider = {
    listCampaigns: vi.fn(async () => [
      { id: "demo_campaign_1", account_id: ACCOUNT, name: "Implants | Leads | Broad | Oct", status: "ACTIVE", objective: "OUTCOME_LEADS" },
      { id: "demo_campaign_3", account_id: ACCOUNT, name: "Brand | Retargeting | Visitors", status: "ACTIVE", objective: "OUTCOME_LEADS" },
    ]),
    listAdSets: vi.fn(async () => adsets),
    listAds: vi.fn(async () => []),
    getInsightsReport,
    getAuditSnapshot,
    optimizeBudget,
  } as unknown as MetaAdsProvider;
  return { provider, getInsightsReport, optimizeBudget };
}

const run = (provider: MetaAdsProvider, b: RequestBrief) =>
  buildOptimizeEvidence({ provider, accountId: ACCOUNT, brief: b, currency: "USD", goals: resolveGoals({ goals_profile: {} }) });
const text = (e: { sections: string[] }) => e.sections.join("\n\n");

/** Facebook and Instagram convert at about $10 a lead; Audience Network is the odd one out. */
const base = [
  row("as_1", "facebook", "feed", 80, 8),
  row("as_1", "facebook", "story", 40, 4),
  row("as_1", "instagram", "stream", 60, 6),
];

describe("placement evidence and proposals", () => {
  it("offers dropping a platform that costs at least twice as much per result and takes at least a tenth of the spend", async () => {
    const s = stub({ rows: [...base, row("as_1", "audience_network", "an_classic", 40, 1)] });
    const e = await run(s.provider, brief());
    expect(e.offered).toHaveLength(1);
    const [p] = e.offered;
    expect(p).toMatchObject({ tool: "update_adset_placements", focus: "placements", entityIds: ["as_1"] });
    expect(p!.args).toMatchObject({ account_id: ACCOUNT, adset_id: "as_1", publisher_platforms: ["facebook", "instagram"] });
    expect(p!.label).toMatch(/Audience Network/);
    expect(p!.label).toMatch(/Implants Broad/);
    expect(updateAdsetPlacementsSchema.safeParse(p!.args).success).toBe(true);
  });

  it("offers dropping a platform that spent a meaningful amount with no results while others convert", async () => {
    const s = stub({ rows: [...base, row("as_1", "audience_network", "an_classic", 50, 0)] });
    const e = await run(s.provider, brief());
    expect(e.offered.map((o) => o.args.publisher_platforms)).toEqual([["facebook", "instagram"]]);
  });

  it("offers nothing when the weak platform is under the thresholds", async () => {
    const small = stub({ rows: [...base, row("as_1", "audience_network", "an_classic", 5, 0)] });
    expect((await run(small.provider, brief())).offered).toEqual([]);
    const notTwice = stub({ rows: [...base, row("as_1", "audience_network", "an_classic", 40, 3)] });
    expect((await run(notTwice.provider, brief())).offered).toEqual([]);
  });

  it("never offers a manual list for an ad set on automatic placements, and says so", async () => {
    const s = stub({ rows: [row("as_2", "facebook", "feed", 100, 10), row("as_2", "audience_network", "an_classic", 80, 0)] });
    const e = await run(s.provider, brief());
    expect(e.offered).toEqual([]);
    expect(text(e)).toMatch(/Implants Advantage/);
    expect(text(e)).toMatch(/automatic/i);
  });

  it("offers nothing when no placement converted at all: there is nothing to compare against", async () => {
    const s = stub({ rows: [row("as_1", "facebook", "feed", 100, 0), row("as_1", "audience_network", "an_classic", 80, 0)] });
    expect((await run(s.provider, brief())).offered).toEqual([]);
  });

  it("never drops every platform: the best one stays", async () => {
    const s = stub({
      rows: [row("as_1", "facebook", "feed", 100, 10), row("as_1", "instagram", "stream", 90, 0), row("as_1", "audience_network", "an_classic", 90, 0)],
    });
    const [p] = (await run(s.provider, brief())).offered;
    expect(p!.args.publisher_platforms).toEqual(["facebook"]);
  });

  it("does not judge an ad set whose result type it cannot read", async () => {
    const s = stub({
      rows: [...base, row("as_1", "audience_network", "an_classic", 50, 0)],
      adsetExtra: { custom_event_type: undefined, optimization_goal: "REACH" },
    });
    const e = await run(s.provider, brief());
    expect(e.offered).toEqual([]);
    expect(text(e)).toMatch(/can.t read results|cannot read results/i);
  });

  it("shows the weakest positions as evidence", async () => {
    const s = stub({ rows: [...base, row("as_1", "audience_network", "an_classic", 40, 1)] });
    expect(text(await run(s.provider, brief()))).toMatch(/an classic|an_classic/);
  });

  it("reads the period and stays on the scope named", async () => {
    const s = stub({ rows: [...base, row("as_1", "audience_network", "an_classic", 40, 1), row("as_4", "facebook", "feed", 50, 5), row("as_4", "audience_network", "an_classic", 50, 0)] });
    const e = await run(s.provider, brief({ scope: { mentions: ["Brand | Retargeting | Visitors"] } }));
    expect(s.getInsightsReport.mock.calls[0]![1]).toMatchObject({
      level: "adset",
      breakdowns: ["publisher_platform", "platform_position"],
      time_range: { since: "2026-10-21", until: "2026-10-27" },
      campaign_ids: ["demo_campaign_3"],
    });
    expect(e.offered.map((o) => o.entityIds)).toEqual([["as_4"]]);
  });

  it("leaves out ad sets the operator said not to touch", async () => {
    const s = stub({ rows: [...base, row("as_1", "audience_network", "an_classic", 40, 1)] });
    expect((await run(s.provider, brief({ exclude: ["Implants Broad"] }))).offered).toEqual([]);
  });

  it("is not read at all when the operator did not ask about placements", async () => {
    const s = stub({ rows: base });
    s.optimizeBudget.mockResolvedValue({ text: "### Budget optimize", structured: { proposals: [] } });
    await run(s.provider, brief({ focus: ["budget"] }));
    expect(s.getInsightsReport).not.toHaveBeenCalled();
  });

  it("says plainly when there is no breakdown data, or the read fails", async () => {
    const empty = await run(stub({ rows: [] }).provider, brief());
    expect(empty.offered).toEqual([]);
    expect(text(empty)).toMatch(/no placement data/i);
    const failed = await run(stub({ insightsThrows: true }).provider, brief());
    expect(text(failed)).toMatch(/Could not read placement performance/);
    expect(text(failed)).toContain("breakdown unavailable");
  });

  it("says when the data was cut short", async () => {
    const e = await run(stub({ rows: base, hasMore: true }).provider, brief());
    expect(text(e)).toMatch(/partial|more rows/i);
  });
});
