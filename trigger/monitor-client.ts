import { schedules } from "@trigger.dev/sdk";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { runWithWorkspaceContext } from "@/lib/runtime/workspace-context";
import type { AccountHealth } from "@/lib/monitoring/health";
import { getClientHealth, persistHealthSnapshot } from "@/lib/monitoring/service";
import { defineJobTask } from "./optional-task";

/**
 * Daily account health check. Read-only on Meta: it records a snapshot (so the
 * Monitoring page has a trend) and alerts the client's team when an account
 * turns "at risk". It never pauses, edits or spends anything.
 */

export type MonitorClientPayload = {
  clientId: string;
  /** Comparison window in days (7 by default). */
  days?: 7 | 14 | 30;
};

export type MonitorClientResult = {
  clientId: string;
  status: AccountHealth["status"] | null;
  score: number | null;
  findingsCount: number;
  alerted: boolean;
  skipped: boolean;
  message?: string;
};

/** Users with a stored Facebook token, most recently connected first. */
async function tokenHolders(): Promise<string[]> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data } = await createAdminClient()
    .from("meta_oauth_tokens")
    .select("user_id")
    .order("updated_at", { ascending: false })
    .limit(5);
  return (data ?? []).map((r) => r.user_id as string);
}

/** Admins plus everyone assigned to the client. */
async function clientTeam(clientId: string): Promise<string[]> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const [{ data: admins }, { data: assigned }] = await Promise.all([
    supabase.from("profiles").select("id").eq("role", "admin").eq("is_active", true),
    supabase.from("user_client_access").select("user_id").eq("client_id", clientId),
  ]);
  return [
    ...new Set([
      ...(admins ?? []).map((r) => r.id as string),
      ...(assigned ?? []).map((r) => r.user_id as string),
    ]),
  ];
}

/** One alert per client per day, only for accounts at risk. */
async function alertTeam(clientId: string, clientName: string, health: AccountHealth): Promise<boolean> {
  if (health.status !== "at_risk") return false;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("type", "monitoring_alert")
    .gte("created_at", `${today}T00:00:00Z`);
  if ((count ?? 0) > 0) return false;

  const critical = health.findings.filter((f) => f.severity === "critical").map((f) => f.title);
  const body =
    (critical.length ? critical : health.findings.map((f) => f.title)).slice(0, 3).join(" · ") ||
    "Account health dropped.";
  const users = await clientTeam(clientId);
  if (!users.length) return false;
  const { error } = await supabase.from("notifications").insert(
    users.map((user_id) => ({
      user_id,
      client_id: clientId,
      type: "monitoring_alert",
      title: `${clientName}: account at risk (score ${health.score})`,
      body,
      href: `/monitoring?clientId=${clientId}`,
    })),
  );
  if (error) throw new Error(error.message);
  return true;
}

export async function runMonitorClient(payload: MonitorClientPayload): Promise<MonitorClientResult> {
  const { clientId } = payload;
  const days = payload.days ?? 7;
  const base = { clientId, status: null, score: null, findingsCount: 0, alerted: false };
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    return { ...base, skipped: true, message: "Demo mode: monitoring uses sample data." };
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data: client } = await createAdminClient()
    .from("clients")
    .select("name")
    .eq("id", clientId)
    .maybeSingle();

  // Background jobs have no session: try each stored Facebook token until one
  // can read the client's ad account.
  let lastMessage = "No user has connected Facebook yet.";
  for (const userId of await tokenHolders()) {
    const result = await runWithWorkspaceContext(
      { version: "v2", backend: "meta_direct", actingUserId: userId },
      () => getClientHealth({ userId, clientId, days, fresh: true }),
    );
    if (result.state === "no_account") {
      return { ...base, skipped: true, message: result.message };
    }
    if (result.state !== "ok") {
      lastMessage = result.message;
      continue;
    }
    const health = result.health;
    await persistHealthSnapshot(clientId, health);
    const alerted = await alertTeam(clientId, String(client?.name ?? "Client"), health);
    logger.info("monitoring.client_checked", {
      clientId,
      score: health.score,
      status: health.status,
      findings: health.findings.length,
      alerted,
    });
    return {
      clientId,
      status: health.status,
      score: health.score,
      findingsCount: health.findings.length,
      alerted,
      skipped: false,
    };
  }
  return { ...base, skipped: true, message: lastMessage };
}

export const monitorClientTask = defineJobTask("monitor-client", runMonitorClient);

/** Every morning (08:00 Sydney, 21:00 UTC): check every mapped client. */
export const monitorAllClientsTask = schedules.task({
  id: "monitor-all-clients",
  cron: "0 21 * * *",
  run: async () => {
    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) return { checked: 0 };
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data } = await createAdminClient()
      .from("connected_meta_accounts")
      .select("mapped_client_id")
      .eq("access_status", "granted")
      .not("mapped_client_id", "is", null);
    const clientIds = [...new Set((data ?? []).map((r) => r.mapped_client_id as string))];
    const results: MonitorClientResult[] = [];
    // Sequential: one account at a time keeps well inside Meta rate limits.
    for (const clientId of clientIds) {
      try {
        results.push(await runMonitorClient({ clientId }));
      } catch (error) {
        logger.error("monitoring.client_failed", {
          clientId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      checked: results.filter((r) => !r.skipped).length,
      atRisk: results.filter((r) => r.status === "at_risk").length,
      alerted: results.filter((r) => r.alerted).length,
    };
  },
});
