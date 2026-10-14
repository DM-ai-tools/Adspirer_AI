import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFullOptimizeProposals, holdIncreasesOnSilentTracking } from "@/lib/agent/optimize-proposals";
import { demoMetaAuditSnapshot, scopeAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { resolveGoals, parseGoalsProfile, type GoalsProfile } from "@/lib/clients/goals";
import { parseMatchWord } from "@/lib/landing/analyze-page";
import { approve, createPendingApproval } from "@/lib/approvals/service";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { getProviderForBackend } from "@/lib/adspirer/client";
import type { MetaAdsProvider } from "@/lib/adspirer/provider";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";

const run = (snap: ReturnType<typeof demoMetaAuditSnapshot>, goals: GoalsProfile = {}) =>
  evaluateCheckpoints(snap, { goals: resolveGoals({ goals_profile: goals }) }).checkpoints;
const get = (cps: ReturnType<typeof run>, id: string) => cps.find((c) => c.id === id);

// ---------------------------------------------------------------- Phase 1

describe("optimize: held budget increases and the hold rule", () => {
  function silentSnap() {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 7);
    snap.adSets = snap.adSets.map((a) => (a.id === "as_1" ? { ...a, customEventType: "COMPLETE_REGISTRATION" } : a));
    return snap;
  }

  it("names the ad set or campaign in each BUDGET line, so a held one can be taken out of Queueable", async () => {
    const provider = {
      listCampaigns: async () => [],
      listAdSets: async () => [],
      getCampaignInsights: async () => ({}),
      optimizeBudget: async () => ({
        text: "",
        structured: {
          proposals: [
            {
              tool: "update_adset_budget",
              args: { account_id: "act_1", adset_id: "as_9", daily_budget_cents: 1200, previous_daily_budget_cents: 1000 },
              rationale: "Scale Broad AU",
            },
          ],
        },
      }),
    } as unknown as MetaAdsProvider;
    const bundle = await buildFullOptimizeProposals({ provider, accountId: "act_1" });
    expect(bundle.queueableLines.find((l) => l.startsWith("- BUDGET"))).toMatch(/as_9/);
  });

  it("doesn't hold a campaign increase because of a PAUSED ad set's silent tracking", () => {
    const snap = silentSnap();
    snap.adSets = snap.adSets.map((a) => (a.id === "as_1" ? { ...a, status: "PAUSED" } : a));
    const { kept } = holdIncreasesOnSilentTracking(
      [{ name: "update_campaign_budget", args: { campaign_id: "demo_campaign_1", previous_daily_budget_cents: 1000, daily_budget_cents: 1200 } }],
      snap,
    );
    expect(kept).toHaveLength(1);
  });

  it("holds an increase even when the proposal doesn't say the current budget", () => {
    const { kept } = holdIncreasesOnSilentTracking(
      [{ name: "update_adset_budget", args: { adset_id: "as_1", daily_budget_cents: 999_999 } }],
      silentSnap(),
    );
    expect(kept).toHaveLength(0);
  });

  it("states resumed-campaign spend in the client's currency", async () => {
    const provider = {
      listCampaigns: async () => [{ id: "c_old", account_id: "act_1", name: "Old winner", status: "PAUSED", objective: "OUTCOME_LEADS", daily_budget_cents: 3000 }],
      listAdSets: async () => [],
      getCampaignInsights: async () => ({ spend: 420, conversions: 12 }),
    } as unknown as MetaAdsProvider;
    const bundle = await buildFullOptimizeProposals({ provider, accountId: "act_1", currency: "EUR" });
    const resume = bundle.proposals.find((p) => p.name === "resume_campaign")!;
    expect(resume.rationale).toMatch(/€420/);
  });

  it("proposes the broad Advantage+ ad set in demo mode", async () => {
    const bundle = await buildFullOptimizeProposals({ provider: getProviderForBackend(null), accountId: "act_100200300" });
    expect(bundle.proposals.some((p) => p.name === "create_adset")).toBe(true);
  });
});

describe("executor fails closed when the entity is gone", () => {
  const provider = getProviderForBackend(null);
  afterEach(() => vi.restoreAllMocks());

  it("refuses a budget change whose ad set Meta no longer has, even with no recorded before-state", async () => {
    const spy = vi.spyOn(provider, "getEntityState").mockRejectedValueOnce(new Error("Meta unavailable"));
    const queued = await createPendingApproval({
      clientId: "client_modern_dental",
      toolName: "update_adset_budget",
      proposedArgs: { account_id: "act_100200300", adset_id: "adset_mdc_npl_1", daily_budget_cents: 4100, previous_daily_budget_cents: 4000 },
    });
    expect(queued.proposed_args.__before).toBeUndefined();
    await approve({ approvalId: queued.id, reviewedBy: "profile_admin_demo" });
    spy.mockResolvedValueOnce(null);
    const write = vi.spyOn(provider, "updateAdSetBudget");
    await expect(executeApprovedAction({ approvalId: queued.id, executedBy: "profile_admin_demo" })).rejects.toThrow(
      /can no longer be found/,
    );
    expect(write).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- Phase 3

describe("audit minors", () => {
  it("F5 is skipped when no ad set sends people to a website", () => {
    const s = demoMetaAuditSnapshot("act_1", "Demo", 7);
    s.totals = { ...s.totals!, linkClicks: 1000, landingPageViews: 100 };
    s.adSets = s.adSets.map((a) => ({ ...a, optimizationGoal: "LEAD_GENERATION", pixelId: null }));
    expect(get(run(s), "F5")).toBeUndefined();
  });

  it("S5: a grace period is a warning and 'any active' passes", () => {
    const s = demoMetaAuditSnapshot("act_1", "Demo", 7);
    s.account = { ...s.account, statusCode: 9 };
    expect(get(run(s), "S5")?.status).toBe("warn");
    s.account = { ...s.account, statusCode: 201 };
    expect(get(run(s), "S5")?.status).toBe("pass");
  });

  it("B6 is not checked when there are no live ad sets", () => {
    const s = demoMetaAuditSnapshot("act_1", "Demo", 7);
    s.adSets = s.adSets.map((a) => ({ ...a, status: "PAUSED" }));
    expect(get(run(s, { target_cpa_cents: 500 }), "B6")?.status).toBe("not_checked");
  });

  it("B7 isn't compared with a CPA target when results are mixed or aren't conversions", () => {
    const s = demoMetaAuditSnapshot("act_1", "Demo", 7);
    s.totals = { ...s.totals!, resultLabel: "Link clicks", costPerResultCents: 50 };
    expect(get(run(s, { target_cpa_cents: 6000 }), "B7")?.status).toBe("not_checked");
    s.totals = { ...s.totals!, resultLabel: "Mixed goals", results: null, costPerResultCents: null };
    expect(get(run(s, { target_cpa_cents: 6000 }), "B7")?.evidence).toMatch(/different/);
  });

  it("scoped audits keep link clicks, landing page views and video plays in the totals", () => {
    const s = demoMetaAuditSnapshot("act_1", "Demo", 7);
    s.campaigns = s.campaigns.map((c, i) =>
      c.performance ? { ...c, performance: { ...c.performance, linkClicks: 100 * (i + 1), landingPageViews: 50 * (i + 1), videoViews3s: 10, thruplays: 4 } } : c,
    );
    const ids = s.campaigns.slice(0, 2).map((c) => c.id);
    const scoped = scopeAuditSnapshot(s, ids);
    expect(scoped.totals?.linkClicks).toBe(300);
    expect(scoped.totals?.landingPageViews).toBe(150);
    expect(scoped.totals?.videoViews3s).toBe(20);
    expect(scoped.totals?.thruplays).toBe(8);
  });
});

describe("goals: one bad policy field drops only itself", () => {
  it("keeps the valid policy fields", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const parsed = parseGoalsProfile({ policy: { scale_step_pct: 15, prospecting_frequency_max: "lots" } });
    expect(parsed.policy?.scale_step_pct).toBe(15);
    expect(resolveGoals({ goals_profile: parsed }).policy.prospecting_frequency_max).toBe(3);
    warn.mockRestore();
  });
});

describe("message-match answer parsing", () => {
  it("reads the verdict word from a longer or punctuated answer", () => {
    expect(parseMatchWord("Partial.")).toBe("partial");
    expect(parseMatchWord("Answer: mismatch")).toBe("mismatch");
    expect(parseMatchWord("")).toBeNull();
  });
});

describe("detectCreativeFatigue reads Meta's own weeks and every page", () => {
  it("uses last_7d / last_14d presets and follows paging", async () => {
    const p = new MetaGraphProviderV2("t");
    const calls: Array<Record<string, unknown>> = [];
    const row = (id: string, impressions: number, clicks: number, freq: number) => ({
      ad_id: id, ad_name: `Ad ${id}`, adset_id: "s1", impressions: String(impressions), inline_link_clicks: String(clicks), frequency: String(freq), spend: "10",
    });
    const get = vi.fn(async (path: string, params: Record<string, unknown> = {}) => {
      if (path === "act_1") return { currency: "USD" };
      if (path === "act_1/ads") return { data: ["a1", "a2", "a3"].map((id) => ({ id, name: id, adset_id: "s1", campaign_id: "c", status: "ACTIVE", effective_status: "ACTIVE" })) };
      if (path === "act_1/insights") {
        calls.push(params);
        if (params.date_preset === "last_7d") {
          // a3 is on the second page
          return params.after
            ? { data: [row("a3", 5000, 25, 3.9)] }
            : { data: [row("a1", 5000, 60, 2.0), row("a2", 5000, 60, 2.0)], paging: { cursors: { after: "p2" }, next: "x" } };
        }
        // 14 days = this week + a week before with CTR 1.0%
        return { data: [row("a1", 10_000, 110, 2.0), row("a2", 10_000, 110, 2.0), row("a3", 10_000, 75, 3.5)] };
      }
      throw new Error(`unexpected ${path}`);
    });
    (p as unknown as { graph: unknown }).graph = { get, post: vi.fn() };
    const result = await p.detectCreativeFatigue("act_1");
    expect(calls.every((c) => !c.time_range)).toBe(true);
    const proposals = (result.structured?.proposals ?? []) as Array<{ args: { ad_id: string } }>;
    expect(proposals.map((x) => x.args.ad_id)).toEqual(["a3"]); // 0.5% now vs 1.0% before, freq 3.9
  });
});
