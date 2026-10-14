import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import type { ResolvedGoals } from "@/lib/clients/goals";
import type { AccountHealth, TrackingSignal } from "@/lib/monitoring/health";
import {
  alertsFromAudit,
  alertsFromHealth,
  HOURLY_CODES,
  planAlertUpdates,
  trackingDropAlerts,
  type AlertState,
  type MonitorAlert,
} from "@/lib/monitoring/alerts";

/**
 * Scheduled monitoring: daily (everything) and hourly (delivery, tracking and
 * account status). Read-only on Meta — fixes are queued as draft approvals
 * for a person to approve.
 */
export type MonitorMode = "daily" | "hourly";

export type MonitorStore = {
  loadStates(clientId: string): Promise<AlertState[]>;
  saveStates(
    clientId: string,
    upserts: Array<AlertState & { title?: string; detail?: string }>,
    resolvedKeys: string[],
    now: Date,
  ): Promise<void>;
  setApproval(clientId: string, key: string, approvalId: string): Promise<void>;
  /** Returns how many people were notified. */
  notifyTeam(clientId: string, clientName: string, alerts: MonitorAlert[]): Promise<number>;
  /** Queues the alert's fix for approval; returns the approval id. */
  queueDraft(clientId: string, alert: MonitorAlert): Promise<string | null>;
};

const codeOf = (key: string) => key.split(":")[0]!;

export async function evaluateClientAlerts(input: {
  clientId: string;
  clientName: string;
  mode: MonitorMode;
  health: AccountHealth;
  audit: MetaAuditSnapshot | null;
  goals: ResolvedGoals;
  /** The tracking counts from about a week ago. */
  baseline: TrackingSignal[];
  store: MonitorStore;
  now: Date;
}): Promise<{ alerts: MonitorAlert[]; notified: number; queued: number; resolved: number }> {
  const { clientId, store, now } = input;
  const hourly = input.mode === "hourly";
  const alerts = [
    ...alertsFromHealth(input.health).filter((a) => !hourly || HOURLY_CODES.has(codeOf(a.key))),
    ...(hourly ? [] : input.audit ? alertsFromAudit(input.audit, input.goals) : []),
    ...(hourly ? [] : trackingDropAlerts(input.health.tracking ?? [], input.baseline)),
  ];
  const inScope = hourly ? (key: string) => HOURLY_CODES.has(codeOf(key)) : () => true;
  const plan = planAlertUpdates(alerts, await store.loadStates(clientId), now, inScope);
  const byKey = new Map(alerts.map((a) => [a.key, a]));
  await store.saveStates(
    clientId,
    plan.upsert.map((s) => ({ ...s, title: byKey.get(s.key)?.title, detail: byKey.get(s.key)?.detail })),
    plan.resolved,
    now,
  );

  let queued = 0;
  for (const alert of plan.notify) {
    if (!alert.action) continue;
    try {
      const approvalId = await store.queueDraft(clientId, alert);
      if (approvalId) {
        await store.setApproval(clientId, alert.key, approvalId);
        queued += 1;
      }
    } catch (error) {
      // The alert still goes out; the fix just isn't pre-filled.
      logger.warn("monitoring.draft_failed", {
        clientId,
        key: alert.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const notified = plan.notify.length ? await store.notifyTeam(clientId, input.clientName, plan.notify) : 0;
  return { alerts, notified, queued, resolved: plan.resolved.length };
}

// ---------------------------------------------------------------------------
// Supabase-backed store
// ---------------------------------------------------------------------------

/** Admins plus everyone assigned to the client. */
async function clientTeam(clientId: string): Promise<string[]> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const [{ data: admins }, { data: assigned }] = await Promise.all([
    supabase.from("profiles").select("id").eq("role", "admin").eq("is_active", true),
    supabase.from("user_client_access").select("user_id").eq("client_id", clientId),
  ]);
  return [...new Set([...(admins ?? []).map((r) => r.id as string), ...(assigned ?? []).map((r) => r.user_id as string)])];
}

async function postToSlack(text: string): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    logger.warn("monitoring.slack_failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

export function supabaseMonitorStore(): MonitorStore {
  const admin = async () => (await import("@/lib/supabase/admin")).createAdminClient();
  return {
    async loadStates(clientId) {
      const { data, error } = await (await admin())
        .from("monitoring_alerts")
        .select("key, severity, first_seen_at, last_seen_at, notified_at, acknowledged_at, snoozed_until, resolved_at, approval_id")
        .eq("client_id", clientId);
      if (error) throw new Error(error.message);
      return (data ?? []) as AlertState[];
    },
    async saveStates(clientId, upserts, resolvedKeys, now) {
      const supabase = await admin();
      if (upserts.length) {
        const { error } = await supabase
          .from("monitoring_alerts")
          .upsert(upserts.map((s) => ({ ...s, client_id: clientId })), { onConflict: "client_id,key" });
        if (error) throw new Error(error.message);
      }
      if (resolvedKeys.length) {
        const { error } = await supabase
          .from("monitoring_alerts")
          .update({ resolved_at: now.toISOString() })
          .eq("client_id", clientId)
          .in("key", resolvedKeys);
        if (error) throw new Error(error.message);
      }
    },
    async setApproval(clientId, key, approvalId) {
      await (await admin()).from("monitoring_alerts").update({ approval_id: approvalId }).eq("client_id", clientId).eq("key", key);
    },
    async notifyTeam(clientId, clientName, alerts) {
      const users = await clientTeam(clientId);
      const critical = alerts.filter((a) => a.severity === "critical").length;
      const title = `${clientName}: ${alerts.length} new alert${alerts.length === 1 ? "" : "s"}${critical ? ` (${critical} critical)` : ""}`;
      const drafts = alerts.filter((a) => a.action).length;
      const body =
        alerts.slice(0, 3).map((a) => a.title).join(" · ") +
        (drafts ? ` — ${drafts} fix${drafts === 1 ? "" : "es"} waiting in Approvals.` : "");
      if (users.length) {
        const { error } = await (await admin()).from("notifications").insert(
          users.map((user_id) => ({
            user_id,
            client_id: clientId,
            type: "monitoring_alert",
            title,
            body,
            href: drafts ? "/approvals" : `/monitoring?clientId=${clientId}`,
          })),
        );
        if (error) throw new Error(error.message);
      }
      await postToSlack(`*${title}*\n${alerts.map((a) => `• ${a.title} — ${a.detail}`).join("\n")}`);
      return users.length;
    },
    async queueDraft(clientId, alert) {
      if (!alert.action) return null;
      const { createPendingApproval } = await import("@/lib/approvals/service");
      const approval = await createPendingApproval({
        clientId,
        toolName: alert.action.tool,
        proposedArgs: alert.action.args,
        rationale: `${alert.action.rationale} (from monitoring)`,
        idempotencyKey: `monitor:${clientId}:${alert.key}:${new Date().toISOString().slice(0, 10)}`,
      });
      return approval.id;
    },
  };
}

// ---------------------------------------------------------------------------
// One client / all clients
// ---------------------------------------------------------------------------

export type MonitorClientResult = {
  clientId: string;
  status: AccountHealth["status"] | null;
  score: number | null;
  alerts: number;
  notified: number;
  queued: number;
  skipped: boolean;
  message?: string;
};

/** Users with a stored Facebook token: the client's team first, then the rest. */
async function tokenHolders(clientId: string): Promise<string[]> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data } = await createAdminClient()
    .from("meta_oauth_tokens")
    .select("user_id")
    .order("updated_at", { ascending: false })
    .limit(20);
  const holders = (data ?? []).map((r) => r.user_id as string);
  const team = new Set(await clientTeam(clientId));
  return [...holders.filter((u) => team.has(u)), ...holders.filter((u) => !team.has(u))].slice(0, 5);
}

/** Tracking counts from the snapshot taken about a week ago. */
async function baselineTracking(clientId: string): Promise<TrackingSignal[]> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
  const { data } = await createAdminClient()
    .from("monitoring_snapshots")
    .select("raw_metrics")
    .eq("client_id", clientId)
    .eq("date_range", "health_7d")
    .lte("captured_at", weekAgo)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const tracking = (data?.raw_metrics as { tracking?: TrackingSignal[] } | null)?.tracking;
  return Array.isArray(tracking) ? tracking : [];
}

export async function runMonitorClient(input: { clientId: string; mode?: MonitorMode }): Promise<MonitorClientResult> {
  const { clientId } = input;
  const mode = input.mode ?? "daily";
  const base = { clientId, status: null, score: null, alerts: 0, notified: 0, queued: 0 };
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return { ...base, skipped: true, message: "Demo mode: monitoring uses sample data." };
  }
  const { getClient } = await import("@/lib/approvals/service");
  const { resolveGoals } = await import("@/lib/clients/goals");
  const { getClientHealth, persistHealthSnapshot } = await import("@/lib/monitoring/service");
  const { runWithWorkspaceContext } = await import("@/lib/runtime/workspace-context");
  const client = await getClient(clientId);
  const goals = resolveGoals(client);

  const check = async (userId: string, token: string): Promise<MonitorClientResult | { retry: string }> => {
    const result = await getClientHealth({ userId, clientId, days: 7, fresh: true, token });
    if (result.state === "no_account") return { ...base, skipped: true, message: result.message };
    if (result.state !== "ok") return { retry: result.message };
    const health = result.health;
    let audit: MetaAuditSnapshot | null = null;
    if (mode === "daily") {
      await persistHealthSnapshot(clientId, health);
      try {
        const { MetaGraphClient } = await import("@/lib/meta/graph-client");
        const { fetchMetaAuditSnapshot } = await import("@/lib/audit/meta-audit-data");
        audit = await fetchMetaAuditSnapshot(new MetaGraphClient(token), health.account.id, { days: 7 });
      } catch (error) {
        logger.warn("monitoring.audit_snapshot_failed", { clientId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const outcome = await evaluateClientAlerts({
      clientId,
      clientName: String(client.name ?? "Client"),
      mode,
      health,
      audit,
      goals,
      baseline: mode === "daily" ? await baselineTracking(clientId) : [],
      store: supabaseMonitorStore(),
      now: new Date(),
    });
    logger.info("monitoring.client_checked", { clientId, mode, score: health.score, alerts: outcome.alerts.length, notified: outcome.notified, queued: outcome.queued });
    return {
      clientId,
      status: health.status,
      score: health.score,
      alerts: outcome.alerts.length,
      notified: outcome.notified,
      queued: outcome.queued,
      skipped: false,
    };
  };

  // A system-user token (Meta's recommendation for automation) when set;
  // otherwise each stored Facebook token until one can read the account.
  const systemToken = process.env.META_SYSTEM_USER_TOKEN?.trim();
  if (systemToken) {
    const result = await runWithWorkspaceContext({ version: "v2", backend: "meta_direct" }, () => check("system", systemToken));
    return "retry" in result ? { ...base, skipped: true, message: result.retry } : result;
  }
  let lastMessage = "No user has connected Facebook yet.";
  for (const userId of await tokenHolders(clientId)) {
    const result = await runWithWorkspaceContext({ version: "v2", backend: "meta_direct", actingUserId: userId }, async () => {
      const { getUserMetaToken } = await import("@/lib/meta/get-user-token");
      const token = await getUserMetaToken().then((t) => t.accessToken).catch(() => null);
      return token ? check(userId, token) : { retry: "Stored Facebook token could not be read." };
    });
    if ("retry" in result) {
      lastMessage = result.retry;
      continue;
    }
    return result;
  }
  return { ...base, skipped: true, message: lastMessage };
}

/** Every client with a granted ad account, one at a time (Meta rate limits). */
export async function runMonitorAllClients(mode: MonitorMode = "daily") {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) return { checked: 0, notified: 0, queued: 0 };
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data } = await createAdminClient()
    .from("connected_meta_accounts")
    .select("mapped_client_id")
    .eq("access_status", "granted")
    .not("mapped_client_id", "is", null);
  const clientIds = [...new Set((data ?? []).map((r) => r.mapped_client_id as string))];
  const results: MonitorClientResult[] = [];
  for (const clientId of clientIds) {
    try {
      results.push(await runMonitorClient({ clientId, mode }));
    } catch (error) {
      logger.error("monitoring.client_failed", { clientId, mode, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    checked: results.filter((r) => !r.skipped).length,
    notified: results.reduce((s, r) => s + r.notified, 0),
    queued: results.reduce((s, r) => s + r.queued, 0),
  };
}
