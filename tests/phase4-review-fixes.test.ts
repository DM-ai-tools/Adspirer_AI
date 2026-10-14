import { describe, expect, it, vi } from "vitest";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { demoHealthSnapshot, evaluateHealth } from "@/lib/monitoring/health";
import { resolveGoals } from "@/lib/clients/goals";
import { alertsFromAudit, type AlertState } from "@/lib/monitoring/alerts";
import { evaluateClientAlerts, teamTokenHolders, type MonitorStore } from "@/lib/monitoring/scheduled";
import { prepareApprovalArgs } from "@/lib/approvals/validate-args";
import { MetaGraphProviderV2 } from "@/lib/meta/provider-v2";

const goals = resolveGoals({ goals_profile: { target_cpa_cents: 8000 } });

function store(initial: AlertState[] = [], openApprovals = new Set<string>()): MonitorStore & { states: Map<string, AlertState>; drafts: string[] } {
  const states = new Map(initial.map((s) => [s.key, s]));
  const drafts: string[] = [];
  return {
    states,
    drafts,
    loadStates: async () => [...states.values()],
    saveStates: async (_c, upserts, resolved, now) => {
      for (const s of upserts) states.set(s.key, { ...states.get(s.key), ...s });
      for (const k of resolved) states.set(k, { ...states.get(k)!, resolved_at: now.toISOString() });
    },
    setApproval: async (_c, key, id) => void states.set(key, { ...states.get(key)!, approval_id: id }),
    notifyTeam: async (_c, _n, alerts) => alerts.length,
    queueDraft: async (_c, alert) => {
      drafts.push(alert.key);
      return `appr_${alert.key}`;
    },
    isApprovalOpen: async (id) => openApprovals.has(id),
    pendingPauseAdIds: async () => new Set<string>(),
  };
}

describe("phase 4 review fixes", () => {
  it("a daily run whose audit fetch failed doesn't resolve ad set and ad alerts", async () => {
    const s = store();
    const health = evaluateHealth(demoHealthSnapshot("act_1", "Demo", 7));
    const at = new Date("2026-10-14T09:00:00Z");
    await evaluateClientAlerts({ clientId: "c1", clientName: "D", mode: "daily", health, audit: demoMetaAuditSnapshot("act_1", "Demo", 7), goals, baseline: [], store: s, now: at });
    await evaluateClientAlerts({ clientId: "c1", clientName: "D", mode: "daily", health, audit: null, goals, baseline: [], store: s, now: new Date(at.getTime() + 86_400_000) });
    expect(s.states.get("WINNER_CAPPED:as_2")?.resolved_at).toBeNull();
  });

  it("doesn't queue a second draft while the alert's earlier one is still waiting", async () => {
    const s = store(
      [{ key: "WINNER_CAPPED:as_2", severity: "warning", first_seen_at: "x", last_seen_at: "x", notified_at: "x", acknowledged_at: null, snoozed_until: null, resolved_at: "2026-10-13T00:00:00Z", approval_id: "appr_old" }],
      new Set(["appr_old"]),
    );
    await evaluateClientAlerts({ clientId: "c1", clientName: "D", mode: "daily", health: evaluateHealth(demoHealthSnapshot("act_1", "Demo", 7)), audit: demoMetaAuditSnapshot("act_1", "Demo", 7), goals, baseline: [], store: s, now: new Date() });
    expect(s.drafts).not.toContain("WINNER_CAPPED:as_2");
  });

  it("an ad already waiting to be paused doesn't count as the live sibling", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 7);
    snap.ads = snap.ads.map((a) => (a.id === "ad_2" && a.performance ? { ...a, frequency7d: 3.6, performance: { ...a.performance, impressions: 5000, linkCtr: 0.5 } } : a));
    const alerts = alertsFromAudit(snap, goals, { pendingPauses: new Set(["ad_1"]) });
    expect(alerts.find((a) => a.key === "AD_FATIGUE:ad_2")!.action).toBeUndefined();
  });

  it("each extra ad on a video campaign needs its own video", async () => {
    await expect(
      prepareApprovalArgs({
        toolName: "create_meta_video_campaign",
        clientId: "c1",
        args: { account_id: "act_1", campaign_name: "V", objective: "OUTCOME_LEADS", budget_daily: 20, primary_text: "Hi", landing_page_url: "https://example.com", video_url: "https://example.com/v.mp4", locations: ["AU"], pixel_id: "1", extra_ads: [{ primary_text: "Two" }] },
        loadAccounts: async () => [{ meta_account_id: "act_1", access_status: "granted", currency: "AUD" }],
      }),
    ).rejects.toThrow(/Extra ad 1 needs a video/);
  });

  it("monitoring only uses the client's own team's Facebook logins", () => {
    expect(teamTokenHolders(["u_other", "u_team2", "u_team1"], ["u_team1", "u_team2"])).toEqual(["u_team2", "u_team1"]);
  });

  it("refuses a bid strategy that differs from an existing campaign-budget campaign's", async () => {
    const p = new MetaGraphProviderV2("t");
    const post = vi.fn();
    (p as unknown as { graph: unknown }).graph = {
      get: vi.fn(async (path: string) =>
        path === "c1" ? { account_id: "act_1", objective: "OUTCOME_LEADS", daily_budget: "5000", bid_strategy: "LOWEST_COST_WITHOUT_CAP" } : { currency: "USD" },
      ),
      post,
    };
    await expect(
      p.createAdSet({ account_id: "act_1", campaign_id: "c1", landing_page_url: "https://e.com", primary_text: "x", locations: ["US"], pixel_id: "1", extra_args: { bid_strategy: "COST_CAP", bid_amount: 30 } }),
    ).rejects.toThrow(/campaign/i);
    expect(post).not.toHaveBeenCalled();
  });

  it("a non-ASCII bearer token gets 401, not a crash", async () => {
    const { POST } = await import("@/app/api/cron/monitoring/route");
    process.env.CRON_SECRET = "abcdef";
    const res = await POST(new Request("http://x/api/cron/monitoring", { method: "POST", headers: { authorization: "Bearer abcdé" + "f".slice(0, 0) + "x" } }));
    expect(res.status).toBe(401);
    delete process.env.CRON_SECRET;
  });
});
