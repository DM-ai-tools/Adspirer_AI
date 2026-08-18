import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated } from "@/lib/authz/assert";
import { isAdmin } from "@/lib/security/roles";
import { mapApprovalRow, mapTaskRow } from "@/lib/db/live-maps";
import { jsonOk, withApiHandler } from "@/lib/api/response";

export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const config = getConfig();

    if (config.isDemoMode || !config.hasSupabase) {
      const store = getDemoStore();
      const allowedClientIds = isAdmin(user.profile)
        ? new Set(store.clients.map((c) => c.id))
        : new Set(
            store.userClientAccess
              .filter((a) => a.user_id === user.id)
              .map((a) => a.client_id),
          );

      const clients = store.clients.filter((c) => allowedClientIds.has(c.id));
      const tasks = store.tasks.filter((t) => allowedClientIds.has(t.client_id));
      const approvals = store.approvals.filter((a) =>
        allowedClientIds.has(a.client_id),
      );
      const pendingApprovals = approvals.filter((a) => a.status === "pending");
      const openRecommendations = store.recommendations.filter(
        (r) => allowedClientIds.has(r.client_id) && r.status === "open",
      );
      const unreadNotifications = store.notifications.filter(
        (n) => n.user_id === user.id && !n.read_at,
      );
      const accessRequests = store.clientAccessRequests.filter((r) =>
        allowedClientIds.has(r.client_id),
      );

      return jsonOk({
        stats: {
          clients: clients.length,
          activeTasks: tasks.filter((t) =>
            ["queued", "running", "waiting_approval", "paused"].includes(
              t.status,
            ),
          ).length,
          pendingApprovals: pendingApprovals.length,
          openRecommendations: openRecommendations.length,
          unreadNotifications: unreadNotifications.length,
          accessRequestsOpen: accessRequests.filter((r) =>
            ["not_requested", "requested", "stale"].includes(r.status),
          ).length,
          connectedAccounts: store.connectedMetaAccounts.filter(
            (a) => a.client_id && allowedClientIds.has(a.client_id),
          ).length,
          staleAccess: accessRequests.filter((r) => r.status === "stale")
            .length,
        },
        recentTasks: tasks
          .slice()
          .sort(
            (a, b) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
          )
          .slice(0, 5),
        pendingApprovals: pendingApprovals.slice(0, 10),
      });
    }

    const { createAdminClient } = await import("@/lib/supabase/admin");
    const supabase = createAdminClient();

    // Connected = synced Meta accounts that are mapped to a client.
    // Also count unmapped synced accounts so Adspirer sync shows up on the dashboard.
    const [
      { count: clients },
      { count: mappedAccounts },
      { count: syncedAccounts },
      { count: pendingApprovalsCount },
      { count: activeTasks },
      { data: taskRows },
      { data: approvalRows },
      { count: unreadNotifications },
    ] = await Promise.all([
      supabase.from("clients").select("id", { count: "exact", head: true }),
      supabase
        .from("connected_meta_accounts")
        .select("id", { count: "exact", head: true })
        .not("mapped_client_id", "is", null),
      supabase
        .from("connected_meta_accounts")
        .select("id", { count: "exact", head: true }),
      supabase
        .from("approvals")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "running", "waiting_approval", "paused"]),
      supabase
        .from("tasks")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(5),
      supabase
        .from("approvals")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .is("read_at", null),
    ]);

    return jsonOk({
      stats: {
        clients: clients ?? 0,
        activeTasks: activeTasks ?? 0,
        pendingApprovals: pendingApprovalsCount ?? 0,
        openRecommendations: 0,
        unreadNotifications: unreadNotifications ?? 0,
        accessRequestsOpen: 0,
        // Prefer mapped count for "connected"; fall back to synced so Adspirer
        // sync is visible even before Map / Add as client.
        connectedAccounts: (mappedAccounts ?? 0) > 0
          ? (mappedAccounts ?? 0)
          : (syncedAccounts ?? 0),
        staleAccess: 0,
      },
      recentTasks: (taskRows ?? []).map((row) =>
        mapTaskRow(row as Record<string, unknown>),
      ),
      pendingApprovals: (approvalRows ?? []).map((row) =>
        mapApprovalRow(row as Record<string, unknown>),
      ),
    });
  });
}
