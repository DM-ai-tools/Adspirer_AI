"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  MessageSquareText,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/layout/app-provider";
import { PageHeader } from "@/components/shared/page-header";
import { LoadingState } from "@/components/shared/loading-state";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MetaConnectButton } from "@/components/meta-connect-button";
import {
  Delta,
  SEVERITY_META,
  STATUS_META,
  ScoreRing,
  ScoreTrend,
  count,
  kpiValue,
  money,
  shortDate,
} from "@/components/monitoring/health-parts";
import {
  changePct,
  type AccountHealth,
  type HealthFinding,
  type HealthWindow,
} from "@/lib/monitoring/health";
import type { ClientHealthResult, HealthHistoryPoint } from "@/lib/monitoring/service";
import type { ClientHealthSummary } from "@/app/api/monitoring/overview/route";

type AccountUpdate = {
  id: string;
  at: string;
  kind: "optimization" | "recommendation" | "task";
  title: string;
  detail: string;
  status: string;
};

type ClientPayload = {
  window: HealthWindow;
  health: ClientHealthResult;
  history: HealthHistoryPoint[];
  accountUpdates: AccountUpdate[];
};

const WINDOWS: Array<{ days: HealthWindow; label: string }> = [
  { days: 7, label: "7 days" },
  { days: 14, label: "14 days" },
  { days: 30, label: "30 days" },
];

function askHref(clientId: string, prompt: string) {
  const params = new URLSearchParams({ clientId, prompt });
  return `/workspace?${params.toString()}`;
}

// ---- Agency overview ---------------------------------------------------------

function AgencyOverview({
  rows,
  loading,
  selectedClientId,
  onSelect,
}: {
  rows: ClientHealthSummary[] | null;
  loading: boolean;
  selectedClientId: string | null;
  onSelect: (id: string) => void;
}) {
  if (loading && !rows) {
    return (
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-lg" />
        ))}
      </div>
    );
  }
  if (!rows?.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => {
        const selected = row.clientId === selectedClientId;
        return (
          <button
            key={row.clientId}
            type="button"
            onClick={() => onSelect(row.clientId)}
            aria-pressed={selected}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
              selected
                ? "border-accent bg-accent/5"
                : "border-border-subtle bg-card hover:border-border hover:bg-secondary/40",
            )}
          >
            {row.state === "ok" && row.status && row.score != null ? (
              <ScoreRing score={row.score} status={row.status} size={40} />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted">
                <Activity className="h-4 w-4" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-foreground">{row.clientName}</p>
                {row.status ? (
                  <Badge variant={STATUS_META[row.status].badge} className="shrink-0 text-[10px]">
                    {STATUS_META[row.status].label}
                  </Badge>
                ) : null}
              </div>
              {row.state === "ok" ? (
                <>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {money(row.spendCents, row.currency ?? "USD")} spent
                    {row.results != null
                      ? ` · ${count(row.results)} ${row.resultLabel?.toLowerCase()}`
                      : ""}
                    {row.costPerResultCents != null
                      ? ` · ${money(row.costPerResultCents, row.currency ?? "USD")} each`
                      : ""}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-foreground/80">
                    {row.topFinding ?? "No issues found"}
                  </p>
                </>
              ) : (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted">{row.message}</p>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---- Client detail -----------------------------------------------------------

function HealthHeader({
  health,
  onRefresh,
  refreshing,
}: {
  health: AccountHealth;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const meta = STATUS_META[health.status];
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of health.findings) counts[f.severity] += 1;
  const { current, previous } = health.window;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
        <ScoreRing score={health.score} status={health.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-foreground">{health.account.name}</h2>
            <Badge variant={meta.badge}>{meta.label}</Badge>
            {health.demo ? <Badge variant="muted">Demo data</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-muted">
            {shortDate(current.since)} – {shortDate(current.until)} compared with{" "}
            {shortDate(previous.since)} – {shortDate(previous.until)} · {health.account.timezone}
          </p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-danger" /> {counts.critical} critical
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-warning" /> {counts.warning} warnings
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-muted" /> {counts.info} notes
            </span>
            <span className="text-muted">· checked {formatRelative(health.fetchedAt)}</span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing} className="self-start sm:self-center">
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          Re-check
        </Button>
      </CardContent>
    </Card>
  );
}

function KpiGrid({ health }: { health: AccountHealth }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      {health.kpis.map((kpi) => (
        <div key={kpi.key} className="rounded-lg border border-border-subtle bg-secondary/30 px-3 py-2.5">
          <p className="truncate text-xs text-muted" title={kpi.label}>{kpi.label}</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
            {kpiValue(kpi, kpi.current, health.account.currency)}
          </p>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <Delta change={kpi.changePct} better={kpi.better} />
            <span className="truncate text-[11px] tabular-nums text-muted" title="Previous period">
              was {kpiValue(kpi, kpi.previous, health.account.currency)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function FindingRow({ finding, clientId }: { finding: HealthFinding; clientId: string }) {
  const meta = SEVERITY_META[finding.severity];
  return (
    <div className="flex gap-3 rounded-lg border border-border-subtle px-3 py-2.5">
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", meta.dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-foreground">{finding.title}</p>
          <Badge variant={meta.badge} className="text-[10px]">{meta.label}</Badge>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{finding.detail}</p>
      </div>
      <Button asChild variant="secondary" size="sm" className="h-7 shrink-0 self-start gap-1 text-xs">
        <Link href={askHref(clientId, finding.ask)} title="Open the workspace with this question ready to send">
          <MessageSquareText className="h-3.5 w-3.5" />
          Ask agent
        </Link>
      </Button>
    </div>
  );
}

function CampaignComparison({ health }: { health: AccountHealth }) {
  const flagged = new Map<string, number>();
  for (const f of health.findings) {
    if (f.campaignId) flagged.set(f.campaignId, (flagged.get(f.campaignId) ?? 0) + 1);
  }
  const currency = health.account.currency;
  if (!health.campaigns.length) {
    return <p className="text-sm text-muted">No campaign spent money in either period.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border-subtle">
            <th className="py-2 pr-3 font-medium">Campaign</th>
            <th className="py-2 pr-3 text-right font-medium">Spend</th>
            <th className="py-2 pr-3 text-right font-medium">Results</th>
            <th className="py-2 pr-3 text-right font-medium">Cost / result</th>
            <th className="py-2 pr-3 text-right font-medium">CTR (link)</th>
            <th className="py-2 text-right font-medium">Frequency</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {health.campaigns.map((c) => (
            <tr key={c.id} className="border-b border-border-subtle/60 align-top">
              <td className="max-w-[280px] py-2 pr-3">
                <p className="flex items-center gap-1.5 truncate text-sm text-foreground" title={c.name}>
                  {flagged.has(c.id) ? (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Has findings" />
                  ) : null}
                  <span className="truncate">{c.name}</span>
                </p>
                <p className="text-[11px] text-muted">
                  {c.delivering ? "Delivering" : "Not delivering"}
                  {c.dailyBudgetCents ? ` · ${money(c.dailyBudgetCents, currency)}/day` : ""}
                </p>
              </td>
              <td className="py-2 pr-3 text-right">
                <p className="text-foreground">{money(c.current.spendCents, currency)}</p>
                <Delta change={changePct(c.current.spendCents, c.previous.spendCents)} better={null} />
              </td>
              <td className="py-2 pr-3 text-right">
                <p className="text-foreground">{count(c.current.results)}</p>
                {c.current.results != null ? (
                  <p className="text-[11px] text-muted">{c.current.resultLabel.toLowerCase()}</p>
                ) : null}
                <Delta change={changePct(c.current.results, c.previous.results)} better="up" />
              </td>
              <td className="py-2 pr-3 text-right">
                <p className="text-foreground">{money(c.current.costPerResultCents, currency)}</p>
                <Delta change={changePct(c.current.costPerResultCents, c.previous.costPerResultCents)} better="down" />
              </td>
              <td className="py-2 pr-3 text-right">
                <p className="text-foreground">{c.current.spendCents > 0 ? `${c.current.linkCtr.toFixed(2)}%` : "—"}</p>
                <Delta change={changePct(c.current.linkCtr || null, c.previous.linkCtr || null)} better="up" />
              </td>
              <td className="py-2 text-right">
                <p className={cn("text-foreground", c.current.frequency >= 4 && "font-medium text-warning")}>
                  {c.current.frequency ? c.current.frequency.toFixed(2) : "—"}
                </p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityFeed({ updates }: { updates: AccountUpdate[] }) {
  if (!updates.length) {
    return (
      <p className="text-sm text-muted">
        No changes yet. Approved optimisations, recommendations and workspace tasks for this client
        appear here.
      </p>
    );
  }
  return (
    <ol className="space-y-3">
      {updates.slice(0, 15).map((u) => (
        <li key={u.id} className="relative border-l border-border-subtle pl-3">
          <span className="absolute -left-[3.5px] top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-foreground">{u.title}</p>
            <Badge variant="secondary" className="shrink-0 text-[10px]">{u.status}</Badge>
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted">{u.detail}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            {u.kind === "optimization" ? "Account change" : u.kind === "recommendation" ? "Recommendation" : "Workspace task"} ·{" "}
            {formatRelative(u.at)}
          </p>
        </li>
      ))}
    </ol>
  );
}

function ClientDetail({
  clientId,
  data,
  onRefresh,
  refreshing,
}: {
  clientId: string;
  data: ClientPayload;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const result = data.health;
  if (result.state !== "ok") {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 p-5">
          <p className="text-sm font-medium text-foreground">
            {result.state === "no_account"
              ? "No ad account mapped"
              : result.state === "not_connected"
                ? "Facebook not connected"
                : "Couldn't load account health"}
          </p>
          <p className="text-sm text-muted">{result.message}</p>
          {result.state === "not_connected" ? (
            <MetaConnectButton variant="compact" returnTo="/monitoring" />
          ) : result.state === "no_account" ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/connections">Open Connections</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const health = result.health;
  return (
    <div className="space-y-4">
      <HealthHeader health={health} onRefresh={onRefresh} refreshing={refreshing} />
      <KpiGrid health={health} />

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">What needs attention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {health.findings.length === 0 ? (
              <div className="flex items-center gap-3 rounded-lg border border-border-subtle px-3 py-3">
                <ShieldCheck className="h-5 w-5 text-success" />
                <p className="text-sm text-muted">
                  All checks passed — delivery, costs, fatigue, spending limit and ad reviews look normal.
                </p>
              </div>
            ) : (
              health.findings.map((f, i) => (
                <FindingRow key={`${f.code}-${f.campaignId ?? i}`} finding={f} clientId={clientId} />
              ))
            )}
            {health.warnings.length ? (
              <p className="pt-1 text-[11px] text-muted">
                Some data could not be loaded: {health.warnings.join(" · ")}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Health trend</CardTitle>
            </CardHeader>
            <CardContent>
              <ScoreTrend points={data.history} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recent activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityFeed updates={data.accountUpdates} />
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Campaigns — this period vs previous</CardTitle>
        </CardHeader>
        <CardContent>
          <CampaignComparison health={health} />
        </CardContent>
      </Card>
    </div>
  );
}

// ---- Page --------------------------------------------------------------------

function MonitoringView() {
  const { clients, selectedClientId, setSelectedClientId } = useApp();
  const searchParams = useSearchParams();
  const [days, setDays] = useState<HealthWindow>(7);
  const [tick, setTick] = useState(0);
  /** Set by "Re-check" so the next load bypasses the server cache. */
  const forceFresh = useRef(false);
  // Each response remembers which request it answers; while a newer one is in
  // flight the previous frame stays on screen (dimmed).
  const [overviewLoaded, setOverviewLoaded] = useState<{
    key: string;
    rows: ClientHealthSummary[] | null;
  } | null>(null);
  const [loaded, setLoaded] = useState<{
    key: string;
    data: ClientPayload | null;
    error: string | null;
  } | null>(null);

  // Deep link from a notification: /monitoring?clientId=…
  const linkedClientId = searchParams.get("clientId");
  useEffect(() => {
    if (linkedClientId && clients.some((c) => c.id === linkedClientId)) {
      setSelectedClientId(linkedClientId);
    }
  }, [linkedClientId, clients, setSelectedClientId]);

  const overviewKey = `${days}|${tick}`;
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ clients: ClientHealthSummary[] }>(`/api/monitoring/overview?window=${days}`)
      .then((res) => {
        if (!cancelled) setOverviewLoaded({ key: overviewKey, rows: res.clients });
      })
      .catch(() => {
        if (!cancelled) setOverviewLoaded({ key: overviewKey, rows: null });
      });
    return () => {
      cancelled = true;
    };
  }, [days, overviewKey]);

  const requestKey = selectedClientId ? `${selectedClientId}|${days}|${tick}` : null;
  useEffect(() => {
    if (!selectedClientId || !requestKey) return;
    let cancelled = false;
    const fresh = forceFresh.current;
    forceFresh.current = false;
    apiFetch<ClientPayload>(
      `/api/monitoring/${selectedClientId}?window=${days}${fresh ? "&refresh=1" : ""}`,
    )
      .then((res) => {
        if (!cancelled) setLoaded({ key: requestKey, data: res, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded((prev) => ({
          key: requestKey,
          data: prev?.data ?? null,
          error: err instanceof Error ? err.message : "Failed to load monitoring",
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClientId, days, requestKey]);

  const overview = overviewLoaded?.rows ?? null;
  const overviewLoading = overviewLoaded?.key !== overviewKey;
  const loading = requestKey != null && loaded?.key !== requestKey;
  // Only show the previous client's data while switching windows, not clients.
  const data =
    loaded?.data && loaded.key.split("|")[0] === selectedClientId ? loaded.data : null;
  const error = loaded?.key === requestKey ? loaded.error : null;
  const recheck = () => {
    forceFresh.current = true;
    setTick((n) => n + 1);
  };

  return (
    <div>
      <PageHeader
        title="Monitoring"
        description="Daily health watch for every ad account — what changed, what's at risk, and what to do next. Read-only: nothing is changed on Meta."
        actions={
          <div className="inline-flex rounded-lg border border-border bg-card p-0.5" role="group" aria-label="Comparison window">
            {WINDOWS.map((w) => (
              <button
                key={w.days}
                type="button"
                onClick={() => setDays(w.days)}
                aria-pressed={days === w.days}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  days === w.days ? "bg-accent text-accent-foreground" : "text-muted hover:text-foreground",
                )}
              >
                {w.label}
              </button>
            ))}
          </div>
        }
      />

      <div className="space-y-5">
        {clients.length > 1 ? (
          <section aria-label="All clients">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              All clients · worst first
            </p>
            <AgencyOverview
              rows={overview}
              loading={overviewLoading}
              selectedClientId={selectedClientId}
              onSelect={setSelectedClientId}
            />
          </section>
        ) : null}

        {!selectedClientId ? (
          <EmptyState
            icon={Activity}
            title="Select a client"
            description="Choose a client above to see its account health, findings and campaign changes."
          />
        ) : loading && !data ? (
          <LoadingState skeleton />
        ) : error ? (
          <ErrorState description={error} onRetry={recheck} />
        ) : data ? (
          <div className={cn(loading && "opacity-60 transition-opacity")}>
            <ClientDetail
              clientId={selectedClientId}
              data={data}
              refreshing={loading}
              onRefresh={recheck}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  return (
    <Suspense fallback={<LoadingState skeleton />}>
      <MonitoringView />
    </Suspense>
  );
}
