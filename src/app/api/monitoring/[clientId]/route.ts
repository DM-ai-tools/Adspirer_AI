import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertClientAccess } from "@/lib/authz/assert";
import { analyzeSnapshots } from "@/lib/monitoring/analyzer";
import type { MonitoringSnapshot, Recommendation } from "@/types";
import { jsonOk, withApiHandler } from "@/lib/api/response";

type RouteContext = { params: Promise<{ clientId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withApiHandler(async () => {
    const { clientId } = await context.params;
    const user = await getCurrentUser();
    assertAuthenticated(user);
    await assertClientAccess(user.id, clientId);

    const config = getConfig();
    let snapshots: MonitoringSnapshot[] = [];
    let recommendations: Recommendation[] = [];

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
    } else {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const supabase = createAdminClient();
      const [{ data: snaps }, { data: recs }] = await Promise.all([
        supabase
          .from("monitoring_snapshots")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
        supabase
          .from("recommendations")
          .select("*")
          .eq("client_id", clientId),
      ]);
      snapshots = (snaps ?? []) as MonitoringSnapshot[];
      recommendations = (recs ?? []) as Recommendation[];
    }

    const current = snapshots[0] ?? null;
    const baseline = snapshots[1] ?? null;
    const analysis = current
      ? analyzeSnapshots({ current, baseline })
      : { findings: [], summary: "No monitoring snapshots available." };

    return jsonOk({
      clientId,
      snapshots,
      findings: analysis.findings,
      summary: analysis.summary,
      recommendations,
    });
  });
}
