import type { Approval } from "@/types";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { mapApprovalRow, toApprovalInsert } from "@/lib/db/live-maps";
import { nowIso } from "@/lib/utils";

const IMAGE_TOOLS = new Set([
  "create_ad",
  "create_meta_image_campaign",
  "create_adset",
  "create_campaign",
]);

export async function bindImageToPendingApprovals(input: {
  clientId: string;
  imageUrl: string;
  taskId?: string | null;
  reviewedBy?: string;
}): Promise<Approval[]> {
  const config = getConfig();
  let approvals: Approval[] = [];

  if (config.isDemoMode || !config.hasSupabase) {
    approvals = getDemoStore().approvals.filter(
      (a) =>
        a.client_id === input.clientId &&
        ["pending", "edited"].includes(a.status) &&
        IMAGE_TOOLS.has(a.tool_name) &&
        (input.taskId ? a.task_id === input.taskId : true),
    );
  } else {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    let query = supabase
      .from("approvals")
      .select("*")
      .eq("client_id", input.clientId)
      .in("status", ["pending", "edited"])
      .in("tool_name", Array.from(IMAGE_TOOLS));
    if (input.taskId) query = query.eq("task_id", input.taskId);
    const { data } = await query;
    approvals = (data ?? []).map((row) =>
      mapApprovalRow(row as Record<string, unknown>),
    );
  }

  const updated: Approval[] = [];
  for (const approval of approvals) {
    const mergedArgs = {
      ...approval.proposed_args,
      ...(approval.edited_args ?? {}),
      image_url: input.imageUrl,
    };
    const ts = nowIso();
    const patched: Approval = {
      ...approval,
      edited_args: mergedArgs,
      status: approval.status === "pending" ? "edited" : approval.status,
      reviewed_by: input.reviewedBy ?? approval.reviewed_by,
      reviewed_at: ts,
      updated_at: ts,
    };
    await persistApprovalRow(patched);
    updated.push(patched);
  }
  return updated;
}

export async function listActionableApprovals(input: {
  clientId: string;
  taskId?: string | null;
}): Promise<Approval[]> {
  const config = getConfig();
  const statuses = ["pending", "edited"];
  if (config.isDemoMode || !config.hasSupabase) {
    return getDemoStore().approvals.filter(
      (a) =>
        a.client_id === input.clientId &&
        statuses.includes(a.status) &&
        (input.taskId ? a.task_id === input.taskId : true),
    );
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  let query = supabase
    .from("approvals")
    .select("*")
    .eq("client_id", input.clientId)
    .in("status", statuses);
  if (input.taskId) query = query.eq("task_id", input.taskId);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) =>
    mapApprovalRow(row as Record<string, unknown>),
  );
}

export async function completeTaskIfApprovalsTerminal(taskId: string): Promise<void> {
  const config = getConfig();
  let task:
    | {
        id: string;
        status: string;
        agent_state?: Record<string, unknown> | null;
      }
    | undefined;
  let approvals: Approval[] = [];

  if (config.isDemoMode || !config.hasSupabase) {
    task = getDemoStore().tasks.find((t) => t.id === taskId);
    approvals = getDemoStore().approvals.filter((a) => a.task_id === taskId);
  } else {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    const { data: taskRow } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .maybeSingle();
    if (!taskRow) return;
    task = taskRow as typeof task;
    const { data } = await supabase
      .from("approvals")
      .select("*")
      .eq("task_id", taskId);
    approvals = (data ?? []).map((row) =>
      mapApprovalRow(row as Record<string, unknown>),
    );
  }

  if (!task || task.status !== "waiting_approval") return;
  const pending = approvals.filter((a) =>
    ["pending", "edited", "approved", "executing"].includes(a.status),
  );
  if (pending.length > 0) return;

  const ts = nowIso();
  const settledState = settleApprovalTaskState(task.agent_state ?? {}, approvals);
  if (config.isDemoMode || !config.hasSupabase) {
    const t = getDemoStore().tasks.find((x) => x.id === taskId);
    if (!t) return;
    t.status = "done";
    t.completed_at = ts;
    t.updated_at = ts;
    t.agent_state = { ...(t.agent_state ?? {}), ...settledState };
    return;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  await supabase
    .from("tasks")
    .update({
      status: "done",
      completed_at: ts,
      updated_at: ts,
      agent_state: { ...(task.agent_state ?? {}), ...settledState },
    })
    .eq("id", taskId);
}

type StepLike = { id: string; label: string; state: string };

/**
 * Final agent_state once every approval for a task is resolved: an honest
 * label (applied vs rejected), and no step left spinning or "waiting".
 */
export function settleApprovalTaskState(
  agentState: Record<string, unknown>,
  approvals: Pick<Approval, "status">[],
): Record<string, unknown> {
  const executed = approvals.filter((a) => a.status === "executed").length;
  const declined = approvals.filter((a) =>
    ["rejected", "cancelled"].includes(a.status),
  ).length;
  const statusLabel =
    approvals.length > 0 && executed === approvals.length
      ? "Changes applied"
      : approvals.length > 0 && declined === approvals.length
        ? "Changes rejected"
        : "Approvals resolved";

  const steps = Array.isArray(agentState.steps)
    ? (agentState.steps as StepLike[]).map((s) => {
        if (s.id === "approval" || s.id === "complete") {
          return { ...s, state: "done" };
        }
        if (s.state === "active" || s.state === "waiting") {
          return { ...s, state: "done" };
        }
        if (s.state === "pending") return { ...s, state: "skipped" };
        return s;
      })
    : undefined;

  return {
    phase: "completed",
    statusLabel,
    awaitingOperator: false,
    ...(steps ? { steps } : {}),
  };
}

export async function persistApprovalRow(approval: Approval): Promise<void> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const store = getDemoStore();
    const idx = store.approvals.findIndex((a) => a.id === approval.id);
    if (idx >= 0) store.approvals[idx] = approval;
    else store.approvals.push(approval);
    return;
  }
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("approvals")
    .update(toApprovalInsert(approval))
    .eq("id", approval.id);
  if (error) throw new Error(error.message);
}
