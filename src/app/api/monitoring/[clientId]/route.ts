import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { HEALTH_WINDOWS, type HealthWindow } from "@/lib/monitoring/health";
import { getClientHealth, loadHealthHistory } from "@/lib/monitoring/service";
import type { Approval, Recommendation, Task } from "@/types";
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

export async function GET(request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { clientId } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, clientId);

    const url = new URL(request.url);
    const requested = Number(url.searchParams.get("window") ?? 7);
    const days: HealthWindow = (HEALTH_WINDOWS as readonly number[]).includes(requested)
      ? (requested as HealthWindow)
      : 7;

    const config = getConfig();
    let recommendations: Recommendation[] = [];
    let approvals: Approval[] = [];
    let tasks: Task[] = [];

    const activity = (async () => {
      if (config.isDemoMode || !config.hasSupabase) {
        const store = getDemoStore();
        recommendations = store.recommendations.filter((r) => r.client_id === clientId);
        approvals = store.approvals.filter((a) => a.client_id === clientId);
        tasks = store.tasks.filter((t) => t.client_id === clientId);
        return;
      }
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const [{ data: recs }, { data: approvalRows }, { data: taskRows }] = await Promise.all([
        supabase
          .from("recommendations")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(50),
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
      recommendations = (recs ?? []) as Recommendation[];
      approvals = (approvalRows ?? []) as Approval[];
      tasks = (taskRows ?? []) as Task[];
    })();

    const [health, history] = await Promise.all([
      getClientHealth({
        userId: user.id,
        clientId,
        days,
        accountId: url.searchParams.get("accountId"),
        fresh: url.searchParams.get("refresh") === "1",
      }),
      loadHealthHistory(clientId, days).catch(() => []),
      activity,
    ]);

    return jsonOk({
      clientId,
      window: days,
      health,
      history,
      recommendations,
      accountUpdates: buildAccountUpdates({ approvals, recommendations, tasks }),
    });
  });
}
