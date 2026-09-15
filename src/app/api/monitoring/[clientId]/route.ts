import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { analyzeSnapshots } from "@/lib/monitoring/analyzer";
import type { Approval, MonitoringSnapshot, Recommendation, Task } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import {
  humanApprovalStatus,
  humanRecommendationStatus,
  humanToolLabel,
} from "@/lib/tools/display-labels";

type RouteContext = { params: Promise<{ clientId: string }> };

export type AccountUpdate = {
  id: string;
  at: string;
  kind: "optimization" | "recommendation" | "task";
  title: string;
  detail: string;
  status: string;
};

function summarizeApprovalArgs(args: Record<string, unknown> | null): string {
  if (!args) return "";
  const bits: string[] = [];
  if (typeof args.campaign_id === "string") bits.push(`campaign ${args.campaign_id}`);
  if (typeof args.adset_id === "string") bits.push(`ad set ${args.adset_id}`);
  if (typeof args.ad_id === "string") bits.push(`ad ${args.ad_id}`);
  if (typeof args.daily_budget_cents === "number") {
    const prev =
      typeof args.previous_daily_budget_cents === "number"
        ? `$${(args.previous_daily_budget_cents / 100).toFixed(0)} → `
        : "";
    bits.push(`${prev}$${(args.daily_budget_cents / 100).toFixed(0)}/day`);
  }
  if (typeof args.campaign_name === "string") bits.push(args.campaign_name);
  return bits.join(" · ");
}

function buildAccountUpdates(input: {
  approvals: Approval[];
  recommendations: Recommendation[];
  tasks: Task[];
}): AccountUpdate[] {
  const updates: AccountUpdate[] = [];

  for (const a of input.approvals) {
    // Track meaningful account-change states — not cancelled noise.
    if (
      !["executed", "approved", "pending", "failed", "rejected", "edited"].includes(
        a.status,
      )
    ) {
      continue;
    }
    const argSummary = summarizeApprovalArgs(
      (a.edited_args ?? a.proposed_args) as Record<string, unknown>,
    );
    updates.push({
      id: `approval_${a.id}`,
      at: a.executed_at ?? a.reviewed_at ?? a.updated_at ?? a.created_at,
      kind: "optimization",
      title: humanToolLabel(a.tool_name),
      detail:
        [a.rationale, argSummary].filter(Boolean).join(" · ") ||
        "Account change from Approvals",
      status: humanApprovalStatus(a.status),
    });
  }

  for (const r of input.recommendations) {
    updates.push({
      id: `rec_${r.id}`,
      at: r.updated_at ?? r.created_at,
      kind: "recommendation",
      title: r.title,
      detail: r.description,
      status: humanRecommendationStatus(r.status),
    });
  }

  for (const t of input.tasks) {
    if (!["done", "error", "waiting_approval"].includes(t.status)) continue;
    updates.push({
      id: `task_${t.id}`,
      at: t.updated_at ?? t.created_at,
      kind: "task",
      title: t.title || "Workspace task",
      detail:
        t.error_message ||
        (t.status === "done"
          ? "Completed in workspace"
          : t.status === "waiting_approval"
            ? "Waiting on Approvals"
            : "Task ended with an error"),
      status:
        t.status === "done"
          ? "Completed"
          : t.status === "waiting_approval"
            ? "Waiting on Approvals"
            : "Error",
    });
  }

  return updates.sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );
}

export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { clientId } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, clientId);

    const config = getConfig();
    let snapshots: MonitoringSnapshot[] = [];
    let recommendations: Recommendation[] = [];
    let approvals: Approval[] = [];
    let tasks: Task[] = [];

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      snapshots = store.monitoringSnapshots
        .filter((s) => s.client_id === clientId)
        .slice()
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );
      recommendations = store.recommendations.filter(
        (r) => r.client_id === clientId,
      );
      approvals = store.approvals.filter((a) => a.client_id === clientId);
      tasks = store.tasks.filter((t) => t.client_id === clientId);
    } else {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const [
        { data: snaps },
        { data: recs },
        { data: approvalRows },
        { data: taskRows },
      ] = await Promise.all([
        supabase
          .from("monitoring_snapshots")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
        supabase.from("recommendations").select("*").eq("client_id", clientId),
        supabase
          .from("approvals")
          .select("*")
          .eq("client_id", clientId)
          .order("updated_at", { ascending: false })
          .limit(50),
        supabase
          .from("tasks")
          .select("*")
          .eq("client_id", clientId)
          .order("updated_at", { ascending: false })
          .limit(30),
      ]);
      snapshots = (snaps ?? []) as MonitoringSnapshot[];
      recommendations = (recs ?? []) as Recommendation[];
      approvals = (approvalRows ?? []) as Approval[];
      tasks = (taskRows ?? []) as Task[];
    }

    const current = snapshots[0] ?? null;
    const baseline = snapshots[1] ?? null;
    const analysis = current
      ? analyzeSnapshots({ current, baseline })
      : { findings: [] as ReturnType<typeof analyzeSnapshots>["findings"], summary: "" };

    const accountUpdates = buildAccountUpdates({
      approvals,
      recommendations,
      tasks,
    });
    const optimizations = accountUpdates.filter((u) => u.kind === "optimization");

    const summaryParts: string[] = [];
    if (analysis.summary) summaryParts.push(analysis.summary);
    if (!current) {
      summaryParts.push(
        accountUpdates.length
          ? `Tracking ${accountUpdates.length} account update${accountUpdates.length === 1 ? "" : "s"} from workspace activity (no metric snapshots yet).`
          : "No monitoring snapshots yet. Applied optimizations and recommendations will appear here as you work the account.",
      );
    } else if (optimizations.length) {
      summaryParts.push(
        `${optimizations.length} optimization${optimizations.length === 1 ? "" : "s"} recorded for this account.`,
      );
    }

    return jsonOk({
      clientId,
      snapshots,
      findings: analysis.findings,
      summary: summaryParts.filter(Boolean).join(" ") || "Account monitoring.",
      recommendations,
      accountUpdates,
      optimizations,
    });
  });
}
