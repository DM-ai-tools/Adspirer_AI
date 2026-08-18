import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { isAdmin } from "@/lib/security/roles";
import { APPROVAL_STATUSES, type Approval } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import { mapApprovalRow } from "@/lib/db/live-maps";

export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const url = new URL(request.url);
    const clientId = url.searchParams.get("clientId");

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
      return jsonOk({ approvals });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();
    let query = supabase
      .from("approvals")
      .select("*")
      .order("created_at", { ascending: false });
    if (clientId) query = query.eq("client_id", clientId);
    if (statuses.length === 1) query = query.eq("status", statuses[0]);
    else if (statuses.length > 1) query = query.in("status", statuses);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonOk({
      approvals: (data ?? []).map((row) =>
        mapApprovalRow(row as Record<string, unknown>),
      ) as Approval[],
    });
  });
}
