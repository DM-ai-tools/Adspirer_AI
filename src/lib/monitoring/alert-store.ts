import { getConfig } from "@/lib/config";
import { NotFoundError } from "@/lib/errors";
import type { AlertState } from "@/lib/monitoring/alerts";

/** An open scheduled-monitoring alert as the Monitoring page shows it. */
export type AlertRow = AlertState & { title: string | null; detail: string | null };

export type AlertUpdate = { action: "acknowledge"; userId: string } | { action: "snooze"; days: number; userId: string };

/** Demo mode: today's sample alerts, with acknowledge/snooze kept in memory. */
const demoState = new Map<string, Partial<AlertRow>>();

async function demoAlerts(clientId: string): Promise<AlertRow[]> {
  const { alertsFromAudit, alertsFromHealth } = await import("@/lib/monitoring/alerts");
  const { demoHealthSnapshot, evaluateHealth } = await import("@/lib/monitoring/health");
  const { demoMetaAuditSnapshot } = await import("@/lib/audit/meta-audit-data");
  const { resolveGoals } = await import("@/lib/clients/goals");
  const { getClient } = await import("@/lib/approvals/service");
  const goals = resolveGoals(await getClient(clientId).catch(() => ({ goals_profile: {} })));
  const alerts = [
    ...alertsFromHealth(evaluateHealth(demoHealthSnapshot("act_demo", "Demo", 7))),
    ...alertsFromAudit(demoMetaAuditSnapshot("act_demo", "Demo", 7), goals),
  ];
  const today = new Date().toISOString().slice(0, 10);
  return alerts.map((a) => ({
    key: a.key,
    severity: a.severity,
    title: a.title,
    detail: a.detail,
    first_seen_at: `${today}T00:00:00Z`,
    last_seen_at: `${today}T00:00:00Z`,
    notified_at: `${today}T00:00:00Z`,
    acknowledged_at: null,
    snoozed_until: null,
    resolved_at: null,
    approval_id: null,
    ...demoState.get(`${clientId}:${a.key}`),
  }));
}

const isLive = () => {
  const config = getConfig();
  return !config.isDemoMode && config.hasSupabase;
};

/** Open alerts, critical first, newest first. */
export async function listOpenAlerts(clientId: string): Promise<AlertRow[]> {
  const rows = isLive()
    ? await (async () => {
        const { createAdminClient } = await import("@/lib/supabase/admin");
        const { data, error } = await createAdminClient()
          .from("monitoring_alerts")
          .select("key, severity, title, detail, first_seen_at, last_seen_at, notified_at, acknowledged_at, snoozed_until, resolved_at, approval_id")
          .eq("client_id", clientId)
          .is("resolved_at", null)
          .order("last_seen_at", { ascending: false })
          .limit(100);
        if (error) throw new Error(error.message);
        return (data ?? []) as AlertRow[];
      })()
    : await demoAlerts(clientId);
  return rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
}

/** Acknowledge (quiet until it resolves) or snooze (quiet for N days). */
export async function updateAlert(clientId: string, key: string, update: AlertUpdate): Promise<void> {
  const now = new Date();
  const patch =
    update.action === "acknowledge"
      ? { acknowledged_at: now.toISOString(), acknowledged_by: update.userId }
      : { snoozed_until: new Date(now.getTime() + Math.min(30, Math.max(1, update.days)) * 86_400_000).toISOString() };
  if (!isLive()) {
    if (!(await demoAlerts(clientId)).some((a) => a.key === key)) throw new NotFoundError("Alert not found.");
    const rest: Partial<AlertRow> = "acknowledged_at" in patch ? { acknowledged_at: patch.acknowledged_at } : { snoozed_until: patch.snoozed_until };
    demoState.set(`${clientId}:${key}`, { ...demoState.get(`${clientId}:${key}`), ...rest });
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("monitoring_alerts")
    .update(patch)
    .eq("client_id", clientId)
    .eq("key", key)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new NotFoundError("Alert not found.");
}
