import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import {
  loadMappedMetaAccounts,
  resolvePrimaryAccountId,
} from "@/lib/adspirer/resolve-meta-account";
import {
  demoHealthSnapshot,
  evaluateHealth,
  fetchHealthSnapshot,
  type AccountHealth,
  type HealthStatus,
} from "@/lib/monitoring/health";

/**
 * Loads account health for a client (live Graph or demo), caches it briefly,
 * and records one snapshot per client per day so the page can show a trend.
 */

export type ClientHealthResult =
  | { state: "ok"; health: AccountHealth; accounts: Array<{ id: string; name: string }> }
  | {
      state: "no_account" | "not_connected" | "error";
      message: string;
      accounts: Array<{ id: string; name: string }>;
    };

export type HealthHistoryPoint = {
  date: string;
  score: number;
  status: HealthStatus;
  spendCents: number;
  results: number | null;
};

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; health: AccountHealth }>();

const normalizeAct = (id: string) => (id.startsWith("act_") ? id : `act_${id}`);

export async function getClientHealth(input: {
  /** Cache scope: whose token loaded the data. */
  userId: string;
  clientId: string;
  days: number;
  accountId?: string | null;
  /** Skip the cache (manual refresh, scheduled job). */
  fresh?: boolean;
}): Promise<ClientHealthResult> {
  const mapped = (await loadMappedMetaAccounts(input.clientId)).filter(
    (a) => a.access_status === "granted",
  );
  const accounts = mapped.map((a) => ({
    id: normalizeAct(a.meta_account_id),
    name: a.meta_account_name,
  }));

  let accountId: string | null = null;
  if (input.accountId) {
    const wanted = normalizeAct(input.accountId);
    accountId = accounts.find((a) => a.id === wanted)?.id ?? null;
  }
  accountId ??= await resolvePrimaryAccountId(input.clientId).then((id) =>
    id ? normalizeAct(id) : null,
  );
  if (!accountId) {
    return {
      state: "no_account",
      accounts,
      message: "No Meta ad account is mapped to this client yet. Map one under Connections.",
    };
  }

  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const name = accounts.find((a) => a.id === accountId)?.name ?? accountId;
    return {
      state: "ok",
      accounts,
      health: evaluateHealth(demoHealthSnapshot(accountId, name, input.days)),
    };
  }

  const key = `${input.userId}:${accountId}:${input.days}`;
  const hit = cache.get(key);
  if (!input.fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { state: "ok", accounts, health: hit.health };
  }

  let token: string;
  try {
    const { getUserMetaToken } = await import("@/lib/meta/get-user-token");
    token = (await getUserMetaToken()).accessToken;
  } catch (error) {
    return {
      state: "not_connected",
      accounts,
      message: error instanceof Error ? error.message : "Connect Facebook to monitor this account.",
    };
  }

  try {
    const { MetaGraphClient } = await import("@/lib/meta/graph-client");
    const snapshot = await fetchHealthSnapshot(new MetaGraphClient(token), accountId, input.days);
    const health = evaluateHealth(snapshot);
    cache.set(key, { at: Date.now(), health });
    void persistHealthSnapshot(input.clientId, health).catch((error) =>
      logger.warn("monitoring.snapshot_save_failed", {
        clientId: input.clientId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return { state: "ok", accounts, health };
  } catch (error) {
    return {
      state: "error",
      accounts,
      message: error instanceof Error ? error.message : "Could not load account health from Meta.",
    };
  }
}

const dateRangeKey = (days: number) => `health_${days}d`;

/** One row per client, window and day — re-checks the same day update it. */
export async function persistHealthSnapshot(clientId: string, health: AccountHealth): Promise<void> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) return;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const cur = health.current;
  const row = {
    client_id: clientId,
    meta_account_id: health.account.id,
    captured_at: health.fetchedAt,
    period_start: `${health.window.current.since}T00:00:00Z`,
    period_end: `${health.window.current.until}T23:59:59Z`,
    date_range: dateRangeKey(health.window.days),
    spend: cur.spendCents / 100,
    impressions: cur.impressions,
    clicks: cur.linkClicks,
    ctr: cur.linkCtr,
    cpm: cur.cpmCents != null ? cur.cpmCents / 100 : null,
    leads: cur.results,
    cpl: cur.costPerResultCents != null ? cur.costPerResultCents / 100 : null,
    raw_metrics: {
      score: health.score,
      status: health.status,
      resultLabel: cur.resultLabel,
      frequency: cur.frequency,
      currency: health.account.currency,
      days: health.window.days,
    },
    findings: health.findings,
  };

  const { data: existing } = await supabase
    .from("monitoring_snapshots")
    .select("id")
    .eq("client_id", clientId)
    .eq("meta_account_id", health.account.id)
    .eq("date_range", row.date_range)
    .eq("period_end", row.period_end)
    .limit(1)
    .maybeSingle();

  const { error } = existing
    ? await supabase.from("monitoring_snapshots").update(row).eq("id", existing.id)
    : await supabase.from("monitoring_snapshots").insert(row);
  if (error) throw new Error(error.message);
}

export async function loadHealthHistory(
  clientId: string,
  days: number,
  limit = 30,
): Promise<HealthHistoryPoint[]> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    // A plausible two-week trend for demo mode.
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - (14 - i));
      const score = Math.max(35, Math.min(100, 92 - i * 3 + (i % 3) * 4));
      return {
        date: d.toISOString().slice(0, 10),
        score,
        status: score >= 80 ? "healthy" : score >= 50 ? "watch" : "at_risk",
        spendCents: 120_000 + i * 900,
        results: 40 - i,
      } satisfies HealthHistoryPoint;
    });
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { data, error } = await createAdminClient()
    .from("monitoring_snapshots")
    .select("period_end, spend, leads, raw_metrics")
    .eq("client_id", clientId)
    .eq("date_range", dateRangeKey(days))
    .order("period_end", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row) => {
      const raw = (row.raw_metrics ?? {}) as { score?: number; status?: HealthStatus };
      return {
        date: String(row.period_end).slice(0, 10),
        score: typeof raw.score === "number" ? raw.score : 0,
        status: raw.status ?? "watch",
        spendCents: Math.round(Number(row.spend ?? 0) * 100),
        results: row.leads == null ? null : Number(row.leads),
      };
    })
    .reverse();
}
