import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, getAccessibleClientIds } from "@/lib/authz/assert";
import { jsonOk, withApiHandler } from "@/lib/api/response";
import {
  HEALTH_WINDOWS,
  changePct,
  type HealthSeverity,
  type HealthStatus,
  type HealthWindow,
} from "@/lib/monitoring/health";
import { getClientHealth } from "@/lib/monitoring/service";

export type ClientHealthSummary = {
  clientId: string;
  clientName: string;
  state: "ok" | "no_account" | "not_connected" | "error";
  message?: string;
  accountName?: string;
  currency?: string;
  score?: number;
  status?: HealthStatus;
  counts?: Record<HealthSeverity, number>;
  topFinding?: string;
  spendCents?: number;
  spendChangePct?: number | null;
  results?: number | null;
  resultLabel?: string;
  costPerResultCents?: number | null;
};

/** Meta allows a few concurrent calls per user; stay well under the limits. */
const CONCURRENCY = 3;

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * GET /api/monitoring/overview?window=7
 * Health of every client the user can see, worst first — the agency's
 * morning check across all accounts.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);

    const requested = Number(new URL(request.url).searchParams.get("window") ?? 7);
    const days: HealthWindow = (HEALTH_WINDOWS as readonly number[]).includes(requested)
      ? (requested as HealthWindow)
      : 7;

    const allowed = await getAccessibleClientIds(user);
    const config = getConfig();
    let clients: Array<{ id: string; name: string }>;
    if (config.isDemoMode || !config.hasSupabase) {
      clients = getDemoStore().clients.map((c) => ({ id: c.id, name: c.name }));
    } else {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      let query = createAdminClient().from("clients").select("id, name").order("name");
      if (allowed) query = query.in("id", allowed.length ? allowed : ["00000000-0000-0000-0000-000000000000"]);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      clients = (data ?? []) as Array<{ id: string; name: string }>;
    }
    if (allowed) clients = clients.filter((c) => allowed.includes(c.id));

    const summaries = await mapLimited(clients, CONCURRENCY, async (client): Promise<ClientHealthSummary> => {
      const result = await getClientHealth({ userId: user.id, clientId: client.id, days });
      if (result.state !== "ok") {
        return { clientId: client.id, clientName: client.name, state: result.state, message: result.message };
      }
      const h = result.health;
      const counts: Record<HealthSeverity, number> = { critical: 0, warning: 0, info: 0 };
      for (const f of h.findings) counts[f.severity] += 1;
      return {
        clientId: client.id,
        clientName: client.name,
        state: "ok",
        accountName: h.account.name,
        currency: h.account.currency,
        score: h.score,
        status: h.status,
        counts,
        topFinding: h.findings[0]?.title,
        spendCents: h.current.spendCents,
        spendChangePct: changePct(h.current.spendCents, h.previous.spendCents),
        results: h.current.results,
        resultLabel: h.current.resultLabel,
        costPerResultCents: h.current.costPerResultCents,
      };
    });

    const rank = (s: ClientHealthSummary) =>
      s.state !== "ok" ? 1_000 : s.status === "at_risk" ? s.score ?? 0 : s.status === "watch" ? 200 + (s.score ?? 0) : 400 + (s.score ?? 0);
    summaries.sort((a, b) => rank(a) - rank(b) || a.clientName.localeCompare(b.clientName));

    return jsonOk({ window: days, clients: summaries });
  });
}
