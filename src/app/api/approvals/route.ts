import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import {
  assertAuthenticated,
  assertClientAccess,
  getAccessibleClientIds,
} from "@/lib/authz/assert";
import { isAdmin } from "@/lib/security/roles";
import { APPROVAL_STATUSES, type Approval } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { mapApprovalRow } from "@/lib/db/live-maps";
import { reapStaleExecutingApprovals } from "@/lib/approvals/service";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");
    /** Only approvals raised in this chat (via its tasks). Requires clientId. */
    const conversationId = url.searchParams.get("conversationId");
    if (conversationId && !clientId) {
      throw new Error("conversationId requires clientId");
    }

    // Accept a comma list so a portal can ask for pending+edited in one round
    // trip instead of firing two parallel requests that each pay auth + query.
    const statuses = (url.searchParams.get("status") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const status of statuses) {
      if (
        !APPROVAL_STATUSES.includes(status as (typeof APPROVAL_STATUSES)[number])
      ) {
        throw new Error(`Invalid approval status: ${status}`);
      }
    }

    if (clientId) {
      await assertClientAccess(user.id, clientId);
    }
    // Approvals stuck in "executing" (function killed mid-run) become failed
    // so the list never shows a change as applying forever.
    await reapStaleExecutingApprovals(clientId ? { clientId } : undefined).catch(() => 0);

    const config = getConfig();
    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      let approvals = store.approvals;
      if (clientId) {
        approvals = approvals.filter((a) => a.client_id === clientId);
      } else if (!isAdmin(user.profile)) {
        const allowed = new Set(
          store.userClientAccess
            .filter((a) => a.user_id === user.id)
            .map((a) => a.client_id),
        );
        approvals = approvals.filter((a) => allowed.has(a.client_id));
      }
      if (statuses.length) {
        approvals = approvals.filter((a) => statuses.includes(a.status));
      }
      if (conversationId) {
        const taskIds = new Set(
          store.tasks.filter((t) => t.conversation_id === conversationId).map((t) => t.id),
        );
        approvals = approvals.filter((a) => a.task_id != null && taskIds.has(a.task_id));
      }
      return jsonOk({ approvals });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    let query = supabase
      .from("approvals")
      .select("*")
      .order("created_at", { ascending: false });
    if (clientId) {
      query = query.eq("client_id", clientId);
    } else {
      const allowed = await getAccessibleClientIds(user);
      if (allowed) query = query.in("client_id", allowed);
    }
    if (statuses.length === 1) query = query.eq("status", statuses[0]);
    else if (statuses.length > 1) query = query.in("status", statuses);
    if (conversationId) {
      const { data: tasks, error: taskError } = await supabase
        .from("tasks")
        .select("id")
        .eq("client_id", clientId!)
        .eq("conversation_id", conversationId);
      if (taskError) throw new Error(taskError.message);
      const taskIds = (tasks ?? []).map((t) => t.id as string);
      if (!taskIds.length) return jsonOk({ approvals: [] as Approval[] });
      query = query.in("task_id", taskIds);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({
      approvals: (data ?? []).map((row) =>
        mapApprovalRow(row as Record<string, unknown>),
      ) as Approval[],
    });
  });
}
