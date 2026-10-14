import { describe, expect, it, vi } from "vitest";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { demoHealthSnapshot, evaluateHealth } from "@/lib/monitoring/health";
import { resolveGoals } from "@/lib/clients/goals";
import type { AlertState, MonitorAlert } from "@/lib/monitoring/alerts";
import { evaluateClientAlerts, type MonitorStore } from "@/lib/monitoring/scheduled";

function memoryStore(): MonitorStore & { states: Map<string, AlertState>; notified: MonitorAlert[][]; drafts: MonitorAlert[] } {
  const states = new Map<string, AlertState>();
  const notified: MonitorAlert[][] = [];
  const drafts: MonitorAlert[] = [];
  return {
    states,
    notified,
    drafts,
    loadStates: async () => [...states.values()],
    saveStates: async (_clientId, upserts, resolved, now) => {
      for (const s of upserts) states.set(s.key, { ...states.get(s.key), ...s });
      for (const key of resolved) states.set(key, { ...states.get(key)!, resolved_at: now.toISOString() });
    },
    setApproval: async (_clientId, key, approvalId) => {
      states.set(key, { ...states.get(key)!, approval_id: approvalId });
    },
    notifyTeam: vi.fn(async (_clientId: string, _name: string, alerts: MonitorAlert[]) => {
      notified.push(alerts);
      return alerts.length ? 2 : 0;
    }),
    queueDraft: vi.fn(async (_clientId: string, alert: MonitorAlert) => {
      drafts.push(alert);
      return `appr_${drafts.length}`;
    }),
  };
}

const health = () => evaluateHealth(demoHealthSnapshot("act_1", "Demo", 7));
const audit = () => demoMetaAuditSnapshot("act_1", "Demo", 7);
const goals = resolveGoals({ goals_profile: { target_cpa_cents: 8000 } });

describe("scheduled monitoring run", () => {
  it("notifies new alerts once and queues their fixes as draft approvals", async () => {
    const store = memoryStore();
    const run = () =>
      evaluateClientAlerts({ clientId: "c1", clientName: "Demo", mode: "daily", health: health(), audit: audit(), goals, baseline: [], store, now: new Date("2026-10-14T09:00:00Z") });
    const first = await run();
    expect(first.notified).toBeGreaterThan(0);
    expect(store.drafts.some((a) => a.key === "WINNER_CAPPED:as_2")).toBe(true);
    expect(store.states.get("WINNER_CAPPED:as_2")?.approval_id).toMatch(/^appr_/);

    const second = await run();
    expect(second.notified).toBe(0);
    expect(second.queued).toBe(0);
  });

  it("hourly runs check only delivery and tracking, and leave daily alerts open", async () => {
    const store = memoryStore();
    const at = new Date("2026-10-14T09:00:00Z");
    await evaluateClientAlerts({ clientId: "c1", clientName: "Demo", mode: "daily", health: health(), audit: audit(), goals, baseline: [], store, now: at });
    const hourly = await evaluateClientAlerts({ clientId: "c1", clientName: "Demo", mode: "hourly", health: health(), audit: null, goals, baseline: [], store, now: new Date(at.getTime() + 3_600_000) });
    expect(hourly.alerts.every((a) => /^(ACCOUNT_STATUS|SPEND_CAP|NO_DELIVERY|TRACKING_STOPPED|AD_ISSUES):/.test(a.key))).toBe(true);
    expect(store.states.get("WINNER_CAPPED:as_2")?.resolved_at).toBeNull();
  });

  it("still notifies when a draft can't be queued", async () => {
    const store = memoryStore();
    store.queueDraft = vi.fn(async () => {
      throw new Error("over the budget ceiling");
    });
    const result = await evaluateClientAlerts({ clientId: "c1", clientName: "Demo", mode: "daily", health: health(), audit: audit(), goals, baseline: [], store, now: new Date() });
    expect(result.notified).toBeGreaterThan(0);
    expect(result.queued).toBe(0);
  });
});

describe("health fetch follows Meta's paging", () => {
  it("reads every page of campaign insights and ad sets instead of stopping at the first", async () => {
    const { fetchHealthSnapshot } = await import("@/lib/monitoring/health");
    const calls: Array<[string, Record<string, unknown>]> = [];
    const graph = {
      get: vi.fn(async (path: string, params: Record<string, unknown> = {}) => {
        calls.push([path, params]);
        if (path === "act_1") return { name: "A", currency: "USD", timezone_name: "UTC", account_status: 1 };
        const paged = (path === "act_1/insights" && params.level === "campaign") || path === "act_1/adsets";
        if (paged && !params.after) return { data: [], paging: { cursors: { after: "c2" }, next: "https://graph/next" } };
        return { data: [] };
      }),
    };
    await fetchHealthSnapshot(graph as never, "act_1", 7);
    expect(calls.some(([p, q]) => p === "act_1/insights" && q.level === "campaign" && q.after === "c2")).toBe(true);
    expect(calls.some(([p, q]) => p === "act_1/adsets" && q.after === "c2")).toBe(true);
  });
});

describe("cron route", () => {
  it("refuses without the CRON_SECRET bearer token", async () => {
    const { POST } = await import("@/app/api/cron/monitoring/route");
    process.env.CRON_SECRET = "s3cret-value";
    const denied = await POST(new Request("http://x/api/cron/monitoring", { method: "POST", headers: { authorization: "Bearer nope" } }));
    expect(denied.status).toBe(401);
    const ok = await POST(new Request("http://x/api/cron/monitoring?mode=hourly", { method: "POST", headers: { authorization: "Bearer s3cret-value" } }));
    expect(ok.status).toBe(200);
    delete process.env.CRON_SECRET;
    const unset = await POST(new Request("http://x/api/cron/monitoring", { method: "POST", headers: { authorization: "Bearer " } }));
    expect(unset.status).toBe(401);
  });
});
