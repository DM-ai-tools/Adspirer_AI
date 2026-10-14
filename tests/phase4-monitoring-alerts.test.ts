import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { demoHealthSnapshot, evaluateHealth } from "@/lib/monitoring/health";
import { resolveGoals } from "@/lib/clients/goals";
import {
  alertsFromAudit,
  alertsFromHealth,
  planAlertUpdates,
  trackingDropAlerts,
  type AlertState,
  type MonitorAlert,
} from "@/lib/monitoring/alerts";

const goals = (g: Record<string, unknown> = {}) => resolveGoals({ goals_profile: g });
const byKey = (alerts: MonitorAlert[], key: string) => alerts.find((a) => a.key === key);

describe("alerts from account health", () => {
  it("turns critical and warning findings into keyed alerts, not info", () => {
    const health = evaluateHealth(demoHealthSnapshot("act_1", "Demo", 7));
    const alerts = alertsFromHealth(health);
    const serious = health.findings.filter((f) => f.severity !== "info");
    expect(alerts).toHaveLength(serious.length);
    expect(alerts[0]!.key).toMatch(/^[A-Z_]+:/);
  });
});

describe("ad set and ad alerts (judged against the client's target)", () => {
  it("flags learning limited ad sets and disapproved ads in live ad sets", () => {
    const alerts = alertsFromAudit(demoMetaAuditSnapshot("act_1", "Demo", 7), goals());
    expect(byKey(alerts, "LEARNING_LIMITED:as_2")).toBeDefined();
    expect(byKey(alerts, "DISAPPROVED_AD:ad_5")?.severity).toBe("warning");
  });

  it("drafts a budget raise for a winning ad set its budget caps", () => {
    const alert = byKey(alertsFromAudit(demoMetaAuditSnapshot("act_1", "Demo", 7), goals({ target_cpa_cents: 8000 })), "WINNER_CAPPED:as_2")!;
    expect(alert.action).toMatchObject({
      tool: "update_adset_budget",
      args: { account_id: "act_1", adset_id: "as_2", daily_budget_cents: 2400, previous_daily_budget_cents: 2000 },
    });
  });

  it("drafts a pause for a fatigued ad only when another ad keeps the ad set running", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 7);
    snap.ads = snap.ads.map((a) =>
      (a.id === "ad_2" || a.id === "ad_3") && a.performance
        ? { ...a, frequency7d: 3.6, performance: { ...a.performance, impressions: 5000, linkCtr: 0.5 } }
        : a,
    );
    const alerts = alertsFromAudit(snap, goals());
    expect(byKey(alerts, "AD_FATIGUE:ad_2")?.action).toMatchObject({ tool: "pause_ad", args: { ad_id: "ad_2" } });
    expect(byKey(alerts, "AD_FATIGUE:ad_3")).toBeDefined();
    expect(byKey(alerts, "AD_FATIGUE:ad_3")!.action).toBeUndefined();
  });

  it("alerts when cost per result is over target, trims the worst and pauses one with no results", () => {
    const snap = demoMetaAuditSnapshot("act_1", "Demo", 7);
    snap.adSets = snap.adSets.map((a) =>
      a.id === "as_4" && a.performance ? { ...a, dailyBudgetCents: 3000, performance: { ...a.performance, results: 0, costPerResultCents: null } } : a,
    );
    const alerts = alertsFromAudit(snap, goals({ target_cpa_cents: 2000 }));
    expect(byKey(alerts, "CPR_OVER_TARGET:account")?.severity).toBe("critical");
    expect(byKey(alerts, "ADSET_NO_RESULTS:as_4")?.action).toMatchObject({ tool: "pause_adset", args: { adset_id: "as_4" } });
    const trim = alerts.find((a) => a.key.startsWith("ADSET_OVER_TARGET:"));
    expect(trim?.action?.tool).toBe("update_adset_budget");
    expect(Number(trim!.action!.args.daily_budget_cents)).toBeLessThan(Number(trim!.action!.args.previous_daily_budget_cents));
    expect(byKey(alertsFromAudit(snap, goals({ target_cpa_cents: 8000 })), "CPR_OVER_TARGET:account")).toBeUndefined();
  });
});

describe("tracking quality", () => {
  const signal = (events7d: number) => [{ pixelId: "p1", eventName: "Lead", events7d, adSetNames: ["A"] }];
  it("alerts when the optimisation event's weekly count halves, not on small numbers", () => {
    expect(trackingDropAlerts(signal(10), signal(40))[0]?.key).toBe("TRACKING_DROP:p1:Lead");
    expect(trackingDropAlerts(signal(5), signal(15))).toHaveLength(0);
    expect(trackingDropAlerts(signal(30), signal(40))).toHaveLength(0);
  });
});

describe("de-duplication, acknowledge and snooze", () => {
  const now = new Date("2026-10-14T09:00:00Z");
  const alert = (key: string, severity: "critical" | "warning" = "warning"): MonitorAlert => ({ key, severity, title: key, detail: "" });
  const state = (key: string, patch: Partial<AlertState> = {}): AlertState => ({
    key,
    severity: "warning",
    first_seen_at: "2026-10-10T00:00:00Z",
    last_seen_at: "2026-10-13T00:00:00Z",
    notified_at: "2026-10-10T00:00:00Z",
    acknowledged_at: null,
    snoozed_until: null,
    resolved_at: null,
    approval_id: null,
    ...patch,
  });

  it("notifies a new alert once, and stays quiet while it's open, snoozed or acknowledged", () => {
    const plan = planAlertUpdates(
      [alert("NEW:1"), alert("OPEN:1"), alert("SNOOZED:1"), alert("ACK:1")],
      [state("OPEN:1"), state("SNOOZED:1", { snoozed_until: "2026-10-20T00:00:00Z" }), state("ACK:1", { acknowledged_at: "2026-10-11T00:00:00Z" })],
      now,
    );
    expect(plan.notify.map((a) => a.key)).toEqual(["NEW:1"]);
  });

  it("notifies again when it gets worse or comes back after resolving", () => {
    const plan = planAlertUpdates(
      [alert("WORSE:1", "critical"), alert("BACK:1")],
      [state("WORSE:1"), state("BACK:1", { resolved_at: "2026-10-12T00:00:00Z" })],
      now,
    );
    expect(plan.notify.map((a) => a.key).sort()).toEqual(["BACK:1", "WORSE:1"]);
  });

  it("resolves open alerts that are gone, but only those this run checks", () => {
    const plan = planAlertUpdates([], [state("NO_DELIVERY:account"), state("AD_FATIGUE:ad_2")], now, (key) => key.startsWith("NO_DELIVERY"));
    expect(plan.resolved).toEqual(["NO_DELIVERY:account"]);
  });
});
