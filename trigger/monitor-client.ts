import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getProvider } from "@/lib/adspirer/client";
import { analyzeSnapshots } from "@/lib/monitoring/analyzer";
import { addDaysIso, nowIso } from "@/lib/utils";
import { logger } from "@/lib/observability/logger";
import type { MonitoringSnapshot, Recommendation } from "@/types";
import { defineJobTask } from "./optional-task";

export type MonitorClientPayload = {
  clientId: string;
  /** Same key within a window skips duplicate snapshot insert. */
  idempotencyKey?: string;
};

export type MonitorClientResult = {
  clientId: string;
  snapshotId: string | null;
  findingsCount: number;
  summary: string;
  skipped: boolean;
};

/**
 * Diagnose-only monitoring job. Never mutates campaigns/budgets.
 */
export async function runMonitorClient(
  payload: MonitorClientPayload,
): Promise<MonitorClientResult> {
  const { clientId } = payload;
  const idempotencyKey =
    payload.idempotencyKey ??
    `monitor:${clientId}:${new Date().toISOString().slice(0, 10)}`;
  const snapshotId = `snap_${idempotencyKey.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 48)}`;

  const config = getConfig();
  const store = getDemoStore();

  if (config.isDemoMode || !config.hasSupabase) {
    const already = store.monitoringSnapshots.find((s) => s.id === snapshotId);
    if (already) {
      const baseline = store.monitoringSnapshots
        .filter((s) => s.client_id === clientId && s.id !== already.id)
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        )[0];
      const analysis = analyzeSnapshots({ current: already, baseline });
      return {
        clientId,
        snapshotId: already.id,
        findingsCount: analysis.findings.length,
        summary: analysis.summary,
        skipped: true,
      };
    }
  }

  const provider = getProvider();
  const accounts =
    config.isDemoMode || !config.hasSupabase
      ? store.connectedMetaAccounts.filter((a) => a.client_id === clientId)
      : [];

  const metaAccountId =
    accounts[0]?.meta_account_id ??
    (await provider.listAccessibleAccounts())[0]?.meta_account_id;

  if (!metaAccountId) {
    return {
      clientId,
      snapshotId: null,
      findingsCount: 0,
      summary: "No connected Meta account to monitor.",
      skipped: true,
    };
  }

  const analysisResult = await provider.analyzeAccount(metaAccountId);
  const overview = analysisResult.overview;
  const prior =
    config.isDemoMode || !config.hasSupabase
      ? store.monitoringSnapshots
          .filter((s) => s.client_id === clientId)
          .sort(
            (a, b) =>
              new Date(b.created_at).getTime() -
              new Date(a.created_at).getTime(),
          )[0]
      : null;

  const ts = nowIso();
  const snapshot: MonitoringSnapshot = {
    id: snapshotId,
    client_id: clientId,
    meta_account_id: metaAccountId,
    period_start: addDaysIso(-7),
    period_end: ts,
    metrics: {
      spend: overview.spend_7d,
      impressions: prior?.metrics.impressions ?? 0,
      clicks: prior?.metrics.clicks ?? 0,
      ctr: prior?.metrics.ctr ?? 0,
      cpc: prior?.metrics.cpc ?? 0,
      leads: prior?.metrics.leads ?? 0,
      cpl: prior?.metrics.cpl ?? 0,
      frequency: prior?.metrics.frequency ?? 0,
      reach: prior?.metrics.reach ?? 0,
    },
    findings: [],
    created_at: ts,
  };

  const analysis = analyzeSnapshots({ current: snapshot, baseline: prior });
  snapshot.findings = analysis.findings;

  if (config.isDemoMode || !config.hasSupabase) {
    const idx = store.monitoringSnapshots.findIndex((s) => s.id === snapshotId);
    if (idx >= 0) store.monitoringSnapshots[idx] = snapshot;
    else store.monitoringSnapshots.push(snapshot);

    for (const finding of analysis.findings) {
      if (finding.severity === "info") continue;
      const recId = `rec_${snapshotId}_${finding.code}`.replace(
        /[^a-zA-Z0-9_]/g,
        "_",
      );
      if (store.recommendations.some((r) => r.id === recId)) continue;
      const rec: Recommendation = {
        id: recId,
        client_id: clientId,
        task_id: null,
        title: finding.title,
        description: finding.detail,
        category: "monitoring",
        status: "open",
        proposed_tool: null,
        proposed_args: null,
        created_by: null,
        created_at: ts,
        updated_at: ts,
      };
      store.recommendations.push(rec);
    }
  }

  logger.info("Monitor client completed", {
    clientId,
    snapshotId,
    findings: analysis.findings.length,
    idempotencyKey,
  });

  return {
    clientId,
    snapshotId,
    findingsCount: analysis.findings.length,
    summary: analysis.summary,
    skipped: false,
  };
}

export const monitorClientTask = defineJobTask(
  "monitor-client",
  runMonitorClient,
);
