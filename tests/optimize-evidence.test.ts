import { describe, expect, it, vi } from "vitest";
import type { MetaAdsProvider } from "@/lib/adspirer/provider";
import { buildOptimizeEvidence, type OptimizeEvidence } from "@/lib/agent/optimize-evidence";
import type { Focus } from "@/lib/agent/optimization-capabilities";
import { EMPTY_QUEUE, type RequestBrief } from "@/lib/agent/request-brief";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { resolveGoals } from "@/lib/clients/goals";

const ACCOUNT = "act_1";
const PERIOD = { since: "2026-10-21", until: "2026-10-27", label: "last 7 days", explicit: false };

const brief = (over: Partial<RequestBrief> & { focus?: Focus[] } = {}): RequestBrief => ({
  intent: "optimize",
  mode: "analyse",
  focus: [],
  scope: { mentions: [] },
  exclude: [],
  period: PERIOD,
  queue: { ...EMPTY_QUEUE },
  optimizationAsk: true,
  source: "rules",
  ...over,
});

type Options = { campaign_ids?: string[]; adset_ids?: string[]; ad_ids?: string[]; since?: string; until?: string };

/** Ids line up with the demo audit snapshot so scoping and tracking checks see real data. */
function stub(opts: { silentAdSet?: string; empty?: boolean; budgetThrows?: boolean } = {}) {
  const campaigns = opts.empty
    ? []
    : [
        { id: "demo_campaign_1", account_id: ACCOUNT, name: "Implants | Leads | Broad | Oct", status: "ACTIVE", objective: "OUTCOME_LEADS" },
        { id: "demo_campaign_2", account_id: ACCOUNT, name: "Veneers Advantage+", status: "ACTIVE", objective: "OUTCOME_LEADS", daily_budget_cents: 7000 },
        { id: "demo_campaign_3", account_id: ACCOUNT, name: "Brand | Retargeting | Visitors", status: "ACTIVE", objective: "OUTCOME_LEADS" },
        { id: "c_old", account_id: ACCOUNT, name: "Old winner", status: "PAUSED", objective: "OUTCOME_LEADS", daily_budget_cents: 3000 },
      ];
  const adsets = opts.empty
    ? []
    : [
        { id: "as_1", campaign_id: "demo_campaign_1", account_id: ACCOUNT, name: "Implants Broad", status: "ACTIVE", daily_budget_cents: 2000, pixel_id: "42", custom_event_type: "LEAD", targeting_summary: JSON.stringify({ geo_locations: { countries: ["AU"] } }) },
        { id: "as_2", campaign_id: "demo_campaign_1", account_id: ACCOUNT, name: "Implants Interests", status: "ACTIVE", daily_budget_cents: 2000 },
        { id: "as_3", campaign_id: "demo_campaign_2", account_id: ACCOUNT, name: "Veneers ASC", status: "ACTIVE", daily_budget_cents: 0 },
        { id: "as_4", campaign_id: "demo_campaign_3", account_id: ACCOUNT, name: "Brand Visitors", status: "ACTIVE", daily_budget_cents: 1500 },
      ];
  const ads = opts.empty
    ? []
    : [
        { id: "ad_1", adset_id: "as_1", campaign_id: "demo_campaign_1", account_id: ACCOUNT, name: "Implants Video", status: "ACTIVE" },
        { id: "ad_2", adset_id: "as_1", campaign_id: "demo_campaign_1", account_id: ACCOUNT, name: "Doctor Intro", status: "ACTIVE" },
        { id: "ad_3", adset_id: "as_2", campaign_id: "demo_campaign_1", account_id: ACCOUNT, name: "Static Offer", status: "ACTIVE" },
        { id: "ad_4", adset_id: "as_3", campaign_id: "demo_campaign_2", account_id: ACCOUNT, name: "Veneers Reveal", status: "ACTIVE" },
        { id: "ad_6", adset_id: "as_4", campaign_id: "demo_campaign_3", account_id: ACCOUNT, name: "Testimonial", status: "ACTIVE" },
      ];
  const adsetCampaign: Record<string, string> = { as_1: "demo_campaign_1", as_2: "demo_campaign_1", as_4: "demo_campaign_3" };

  const optimizeBudget = vi.fn(async (_account: string, options: Options = {}) => {
    if (opts.budgetThrows) throw new Error("insights unavailable");
    const all = [
      { tool: "update_adset_budget", adset: "as_1", args: { account_id: ACCOUNT, adset_id: "as_1", daily_budget_cents: 2400, previous_daily_budget_cents: 2000 }, rationale: "Scale Implants Broad: 5 conv · +20% daily budget." },
      { tool: "update_adset_budget", adset: "as_2", args: { account_id: ACCOUNT, adset_id: "as_2", daily_budget_cents: 1600, previous_daily_budget_cents: 2000 }, rationale: "Trim Implants Interests: spend with 0 conversions · −20% daily budget." },
      { tool: "update_campaign_budget", campaign: "demo_campaign_2", args: { account_id: ACCOUNT, campaign_id: "demo_campaign_2", daily_budget_cents: 8400, previous_daily_budget_cents: 7000 }, rationale: "Scale Veneers Advantage+: 8 conv · +20% campaign daily budget." },
      { tool: "pause_adset", adset: "as_4", args: { account_id: ACCOUNT, adset_id: "as_4" }, rationale: "Pause Brand Visitors: spend with 0 conversions." },
    ];
    const kept = all.filter((p) => {
      const campaign = p.campaign ?? adsetCampaign[p.adset!];
      if (options.adset_ids?.length) return p.adset ? options.adset_ids.includes(p.adset) : false;
      if (options.campaign_ids?.length) return options.campaign_ids.includes(campaign!);
      return true;
    });
    return {
      text: `### Budget optimize (${ACCOUNT}) · ${options.since} → ${options.until}\n${kept.map((p) => `- ${p.rationale}`).join("\n")}`,
      structured: { proposals: kept.map((p) => ({ tool: p.tool, args: p.args, rationale: p.rationale })) },
    };
  });
  const detectCreativeFatigue = vi.fn(async (_account: string, options: Options = {}) => {
    const keep = !options.campaign_ids?.length || options.campaign_ids.includes("demo_campaign_1");
    const adOk = !options.ad_ids?.length || options.ad_ids.includes("ad_2");
    const proposals =
      keep && adOk
        ? [{ tool: "pause_ad", args: { account_id: ACCOUNT, ad_id: "ad_2" }, rationale: "Pause fatigued ad Doctor Intro: frequency 4.0 and CTR down 40%." }]
        : [];
    return { text: `### Creative fatigue (${ACCOUNT}) · ${options.until}\n${proposals.map((p) => `- ${p.rationale}`).join("\n")}`, structured: { proposals } };
  });
  const getAuditSnapshot = vi.fn(async (_account: string, options: Record<string, unknown> = {}) => {
    const snap = demoMetaAuditSnapshot(ACCOUNT, "Demo", options as never);
    if (opts.silentAdSet) {
      snap.adSets = snap.adSets.map((a) => (a.id === opts.silentAdSet ? { ...a, customEventType: "COMPLETE_REGISTRATION" } : a));
    }
    return snap;
  });
  const getAdCreatives = vi.fn(async () => [
    { ad_id: "ad_1", campaign_id: "demo_campaign_1", landing_page_url: "https://example.com/lp", primary_text: "Book a consult", headline: "Consults" },
  ]);
  const getCampaignInsights = vi.fn(async (_a: string, id: string) => ({
    account_id: ACCOUNT, entity_id: id, entity_type: "campaign" as const, date_start: "2026-07-01", date_stop: "2026-10-01",
    spend: 140, impressions: 10_000, clicks: 200, ctr: 2, cpc: 0.7, conversions: id === "c_old" ? 7 : 0,
  }));

  const provider = {
    listCampaigns: vi.fn(async () => campaigns),
    listAdSets: vi.fn(async () => adsets),
    listAds: vi.fn(async () => ads),
    optimizeBudget,
    detectCreativeFatigue,
    getAuditSnapshot,
    getAdCreatives,
    getCampaignInsights,
  } as unknown as MetaAdsProvider;
  return { provider, optimizeBudget, detectCreativeFatigue, getAuditSnapshot, getAdCreatives, getCampaignInsights };
}

const run = (provider: MetaAdsProvider, b: RequestBrief): Promise<OptimizeEvidence> =>
  buildOptimizeEvidence({ provider, accountId: ACCOUNT, brief: b, currency: "USD", goals: resolveGoals({ goals_profile: {} }) });

const text = (e: OptimizeEvidence) => e.sections.join("\n\n");
const tools = (e: OptimizeEvidence) => e.offered.map((o) => o.tool);

describe("focus decides what is fetched", () => {
  it("budget focus reads budget evidence, not fatigue, creatives or the checkpoint table", async () => {
    const s = stub();
    const e = await run(s.provider, brief({ focus: ["budget"] }));
    expect(s.optimizeBudget).toHaveBeenCalledTimes(1);
    expect(s.detectCreativeFatigue).not.toHaveBeenCalled();
    expect(s.getAdCreatives).not.toHaveBeenCalled();
    expect(text(e)).not.toContain("Optimisation signals");
    expect(new Set(tools(e))).toEqual(new Set(["update_adset_budget", "update_campaign_budget", "pause_adset"]));
  });

  it("budget focus still checks tracking before it offers an increase (read, not shown)", async () => {
    const s = stub();
    await run(s.provider, brief({ focus: ["budget"] }));
    expect(s.getAuditSnapshot).toHaveBeenCalledTimes(1);
    const none = stub();
    none.optimizeBudget.mockResolvedValueOnce({ text: "### Budget optimize", structured: { proposals: [] } });
    await run(none.provider, brief({ focus: ["budget"] }));
    expect(none.getAuditSnapshot).not.toHaveBeenCalled();
  });

  it("no focus builds the core set: budget, creative and tracking, nothing else", async () => {
    const s = stub();
    const e = await run(s.provider, brief());
    expect(s.optimizeBudget).toHaveBeenCalled();
    expect(s.detectCreativeFatigue).toHaveBeenCalled();
    expect(text(e)).toContain("Optimisation signals");
    expect(tools(e)).not.toContain("resume_campaign");
    expect(tools(e)).not.toContain("create_adset");
    expect(s.getCampaignInsights).not.toHaveBeenCalled();
  });

  it("reactivation and structure only when asked", async () => {
    const s = stub();
    expect(tools(await run(s.provider, brief({ focus: ["reactivation"] })))).toEqual(["resume_campaign"]);
    expect(tools(await run(stub().provider, brief({ focus: ["structure"] })))).toEqual(["create_adset"]);
    expect(tools(await run(stub().provider, brief({ focus: ["budget"] })))).not.toContain("resume_campaign");
  });

  it("the period reaches every read", async () => {
    const s = stub();
    await run(s.provider, brief());
    expect(s.optimizeBudget.mock.calls[0]![1]).toMatchObject({ since: "2026-10-21", until: "2026-10-27" });
    expect(s.detectCreativeFatigue.mock.calls[0]![1]).toMatchObject({ until: "2026-10-27" });
    expect(s.getAuditSnapshot.mock.calls[0]![1]).toMatchObject({ since: "2026-10-21", until: "2026-10-27", compare: false });
  });

  it("states the period and scope it used", async () => {
    const e = await run(stub().provider, brief());
    expect(text(e)).toMatch(/Period: 2026-10-21 → 2026-10-27/);
    expect(text(e)).toMatch(/last 7 days/);
    expect(text(e)).toMatch(/whole account/);
  });
});

describe("scope is what the operator named", () => {
  it("a named campaign narrows reads, proposals and the scope ids", async () => {
    const s = stub();
    const e = await run(s.provider, brief({ focus: ["budget"], scope: { mentions: ["Veneers Advantage+"] } }));
    expect(new Set(e.scopeEntityIds)).toEqual(new Set(["demo_campaign_2", "as_3", "ad_4"]));
    expect(s.optimizeBudget.mock.calls[0]![1]).toMatchObject({ campaign_ids: ["demo_campaign_2"] });
    expect(e.offered.map((o) => o.args.campaign_id)).toEqual(["demo_campaign_2"]);
  });

  it("a mention can name an ad set", async () => {
    const s = stub();
    const e = await run(s.provider, brief({ focus: ["budget"], scope: { mentions: ["Implants Interests"] } }));
    expect(new Set(e.scopeEntityIds)).toEqual(new Set(["as_2", "ad_3"]));
    expect(s.optimizeBudget.mock.calls[0]![1]).toMatchObject({ adset_ids: ["as_2"] });
  });

  it("an unknown name is reported and never widened to the account", async () => {
    const s = stub();
    const e = await run(s.provider, brief({ scope: { mentions: ["Nonexistent Campaign"] } }));
    expect(e.unresolvedMentions).toEqual(["Nonexistent Campaign"]);
    expect(e.offered).toEqual([]);
    expect(e.scopeEntityIds).toEqual([]);
    expect(text(e)).toMatch(/Nonexistent Campaign/);
    expect(text(e)).toMatch(/wasn.t found|not found/i);
    expect(text(e)).toMatch(/Veneers Advantage\+/);
    expect(s.optimizeBudget).not.toHaveBeenCalled();
    expect(s.detectCreativeFatigue).not.toHaveBeenCalled();
    expect(s.getAuditSnapshot).not.toHaveBeenCalled();
  });

  it("one found and one unknown: stays on the one found, still reports the other", async () => {
    const e = await run(
      stub().provider,
      brief({ focus: ["budget"], scope: { mentions: ["Veneers Advantage+", "Nope"] } }),
    );
    expect(e.unresolvedMentions).toEqual(["Nope"]);
    expect(new Set(e.scopeEntityIds)).toEqual(new Set(["demo_campaign_2", "as_3", "ad_4"]));
  });

  it("names the operator said not to touch are never proposed", async () => {
    const e = await run(stub().provider, brief({ focus: ["budget"], exclude: ["Brand"] }));
    expect(e.offered.some((o) => o.entityIds.includes("as_4"))).toBe(false);
    expect(e.offered.length).toBeGreaterThan(0);
  });

  it("lists campaigns, ad sets and ads by name for later steps", async () => {
    const e = await run(stub().provider, brief({ focus: ["budget"] }));
    expect(e.entityIndex).toContainEqual({ id: "demo_campaign_2", name: "Veneers Advantage+", type: "campaign" });
    expect(e.entityIndex).toContainEqual({ id: "as_2", name: "Implants Interests", type: "adset" });
    expect(e.entityIndex).toContainEqual({ id: "ad_3", name: "Static Offer", type: "ad" });
  });
});

describe("numbered proposals", () => {
  it("refs are 1-based, ordered by focus then amount, and stable", async () => {
    const a = await run(stub().provider, brief());
    const b = await run(stub().provider, brief());
    expect(a.offered.map((o) => o.ref)).toEqual(a.offered.map((_, i) => i + 1));
    expect(a.offered[0]).toMatchObject({ tool: "update_campaign_budget", focus: "budget" });
    const focuses = a.offered.map((o) => o.focus);
    expect(focuses.lastIndexOf("budget")).toBeLessThan(focuses.indexOf("creative"));
    expect(b.offered).toEqual(a.offered);
  });

  it("each proposal carries what the queue step needs", async () => {
    const e = await run(stub().provider, brief({ focus: ["budget"] }));
    const first = e.offered[0]!;
    expect(first.entityIds).toEqual(["demo_campaign_2"]);
    expect(first.label).toMatch(/Scale Veneers/);
    expect(first.spendAtStakeCents).toBe(1400);
  });

  it("the evidence lists them for the writer", async () => {
    const e = await run(stub().provider, brief({ focus: ["budget"] }));
    expect(text(e)).toMatch(/#1\b/);
    expect(text(e)).toMatch(/#2\b/);
  });
});

describe("tracking holds", () => {
  it("a budget increase on an ad set with silent tracking is not offered and says why", async () => {
    const e = await run(stub({ silentAdSet: "as_1" }).provider, brief({ focus: ["budget"] }));
    expect(e.offered.some((o) => o.entityIds.includes("as_1"))).toBe(false);
    expect(text(e)).toMatch(/Held back/);
  });
});

describe("who does what", () => {
  it("tags every offered step and every failing check with its owner, without vendor names", async () => {
    const e = await run(stub({ silentAdSet: "as_1" }).provider, brief());
    for (const o of e.offered) expect(e.appendix).toContain(`#${o.ref}`);
    expect(e.appendix).toMatch(/this app/);
    expect(e.appendix).toMatch(/a developer/);
    expect(e.appendix).not.toMatch(/adspirer/i);
    expect(e.appendix.split("\n").filter((l) => l.startsWith("|")).every((l) => l.trim().endsWith("|"))).toBe(true);
  });

  it("is empty when there is nothing to say", async () => {
    const e = await run(stub({ empty: true }).provider, brief({ focus: ["budget"] }));
    expect(e.appendix).toBe("");
  });
});

describe("degraded accounts", () => {
  it("an account with nothing in it says so", async () => {
    const e = await run(stub({ empty: true }).provider, brief());
    expect(e.offered).toEqual([]);
    expect(text(e)).toMatch(/nothing to optimi[sz]e/i);
  });

  it("a failing read becomes a plain statement and the rest still runs", async () => {
    const s = stub({ budgetThrows: true });
    const e = await run(s.provider, brief());
    expect(text(e)).toMatch(/Could not read budgets/);
    expect(text(e)).toContain("insights unavailable");
    expect(s.detectCreativeFatigue).toHaveBeenCalled();
  });
});
