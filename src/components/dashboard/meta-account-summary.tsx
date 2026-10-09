"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { apiFetch, formatRelative } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/layout/app-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { MetaConnectButton } from "@/components/meta-connect-button";
import type {
  AccountDashboard,
  CampaignRow,
  DashboardRange,
} from "@/lib/meta/account-dashboard";

type ApiResult =
  | {
      state: "ok";
      demo?: boolean;
      accounts: Array<{ id: string; name: string }>;
      dashboard: AccountDashboard;
    }
  | {
      state: "no_account" | "not_connected";
      accounts: Array<{ id: string; name: string }>;
      message: string;
    };

const RANGES: Array<{ key: DashboardRange; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
];

// ---- formatting --------------------------------------------------------------

function money(cents: number | null | undefined, currency: string, compact = false) {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: compact && Math.abs(cents) >= 10_000_00 ? "compact" : "standard",
      maximumFractionDigits: compact ? (Math.abs(cents) >= 100_00 ? 0 : 2) : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function count(value: number) {
  return new Intl.NumberFormat("en", {
    notation: value >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 100_000 ? 1 : 0,
  }).format(value);
}

function pct(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function shortDate(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Round an axis max up to a clean 1/2/5 × 10^n step. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

// ---- pieces ------------------------------------------------------------------

function Tile({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border-subtle bg-secondary/30 px-3.5 py-3",
        className,
      )}
    >
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

/**
 * Meter: fill carries severity, the track is a muted step of the same hue.
 * `value` is a 0–1+ ratio; over 1 is clamped visually and flagged in text.
 */
function Meter({
  value,
  tone,
  label,
}: {
  value: number;
  tone: "accent" | "warning" | "danger";
  label: string;
}) {
  const fill = {
    accent: "bg-accent",
    warning: "bg-warning",
    danger: "bg-danger",
  }[tone];
  const track = {
    accent: "bg-accent-muted",
    warning: "bg-warning-muted",
    danger: "bg-danger-muted",
  }[tone];
  return (
    <div
      className={cn("h-2 w-full overflow-hidden rounded-full", track)}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.min(value, 1) * 100)}
    >
      <div
        className={cn("h-full rounded-full transition-[width]", fill)}
        style={{ width: `${Math.max(2, Math.min(value, 1) * 100)}%` }}
      />
    </div>
  );
}

function pacingTone(pacing: number): "accent" | "warning" | "danger" {
  if (pacing > 1.1) return "danger";
  if (pacing < 0.7) return "warning";
  return "accent";
}

function pacingNote(pacing: number | null): string {
  if (pacing == null) return "No active daily budgets to pace against";
  if (pacing > 1.1) return "Spending faster than the allotted daily budgets";
  if (pacing < 0.7) return "Under-delivering against allotted budget";
  return "On pace with allotted budget";
}

function DailySpendChart({
  daily,
  dailyBudgetCents,
  currency,
}: {
  daily: AccountDashboard["daily"];
  dailyBudgetCents: number;
  currency: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const peak = Math.max(dailyBudgetCents, ...daily.map((d) => d.spendCents), 1);
  const max = niceMax(peak);
  const ticks = [0, max / 2, max];
  const budgetPct = dailyBudgetCents > 0 ? (dailyBudgetCents / max) * 100 : null;

  if (!daily.length) {
    return (
      <p className="py-10 text-center text-sm text-muted">
        No spend in this period.
      </p>
    );
  }

  return (
    <div className="flex gap-3">
      {/* y-axis */}
      <div className="relative mt-3 h-44 w-14 shrink-0 text-right text-[11px] tabular-nums text-muted">
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute right-0 -translate-y-1/2"
            style={{ bottom: `${(t / max) * 100}%` }}
          >
            {money(t, currency, true)}
          </span>
        ))}
      </div>

      <div className="relative mt-3 h-44 min-w-0 flex-1">
        {/* hairline gridlines */}
        {ticks.map((t) => (
          <div
            key={t}
            className="pointer-events-none absolute inset-x-0 h-px bg-border-subtle"
            style={{ bottom: `${(t / max) * 100}%` }}
          />
        ))}
        {/* allotted daily budget reference */}
        {budgetPct != null ? (
          <div
            className="pointer-events-none absolute inset-x-0 z-10 h-px bg-foreground/40"
            style={{ bottom: `${budgetPct}%` }}
          >
            <span className="absolute -top-4 right-0 rounded bg-card px-1 text-[10px] text-muted">
              Daily budget {money(dailyBudgetCents, currency, true)}
            </span>
          </div>
        ) : null}

        <div className="absolute inset-0 flex items-end gap-[2px]">
          {daily.map((d, i) => {
            const h = (d.spendCents / max) * 100;
            const isActive = active === i;
            return (
              <div
                key={d.date}
                tabIndex={0}
                role="img"
                aria-label={`${shortDate(d.date)}: ${money(d.spendCents, currency)} spent`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive((cur) => (cur === i ? null : cur))}
                onFocus={() => setActive(i)}
                onBlur={() => setActive((cur) => (cur === i ? null : cur))}
                className="group relative flex h-full min-w-0 flex-1 cursor-default items-end justify-center outline-none"
              >
                {/* The whole slot is the hit target; the bar itself stays thin. */}
                <div
                  className={cn(
                    "w-full max-w-[24px] rounded-t-[4px] bg-accent transition-opacity group-focus-visible:ring-2 group-focus-visible:ring-ring",
                    active != null && !isActive && "opacity-55",
                  )}
                  style={{ height: `${Math.max(h, d.spendCents > 0 ? 1.5 : 0)}%` }}
                />
                {isActive ? (
                  <div
                    className={cn(
                      "pointer-events-none absolute z-20 mb-2 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1.5 shadow-lg",
                      i < daily.length / 2 ? "left-0" : "right-0",
                    )}
                    // Sit just above the hovered bar, not at the top of the plot.
                    style={{ bottom: `${Math.max(h, 1.5)}%` }}
                  >
                    <p className="text-sm font-semibold text-foreground">
                      {money(d.spendCents, currency)}
                    </p>
                    <p className="text-[11px] text-muted">{shortDate(d.date)}</p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CampaignTable({
  rows,
  currency,
  emptyText,
}: {
  rows: CampaignRow[];
  currency: string;
  emptyText: string;
}) {
  if (!rows.length) return <p className="text-sm text-muted">{emptyText}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-xs">
        <thead className="text-muted">
          <tr className="border-b border-border-subtle">
            <th className="py-2 pr-3 font-medium">Campaign</th>
            <th className="py-2 pr-3 text-right font-medium">Budget</th>
            <th className="py-2 pr-3 text-right font-medium">Spend</th>
            <th className="py-2 pr-3 text-right font-medium">Results</th>
            <th className="py-2 pr-3 text-right font-medium">Cost / result</th>
            <th className="py-2 pr-3 text-right font-medium">ROAS</th>
            <th className="py-2 text-right font-medium">CTR (link)</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((c) => (
            <tr key={c.id} className="border-b border-border-subtle/60">
              <td className="max-w-[300px] py-2 pr-3">
                <p className="truncate text-sm text-foreground" title={c.name}>
                  {c.name}
                </p>
                <p className="text-[11px] text-muted">
                  {c.status === "ACTIVE" ? "Delivering" : "Not delivering"}
                  {c.objective
                    ? ` · ${c.objective.replace(/^OUTCOME_/, "").toLowerCase()}`
                    : ""}
                  {c.startTime
                    ? ` · since ${new Date(c.startTime).toLocaleDateString("en", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}`
                    : ""}
                </p>
              </td>
              <td className="py-2 pr-3 text-right">
                {c.dailyBudgetCents != null ? (
                  <>
                    {money(c.dailyBudgetCents, currency)}/day
                    {c.budgetAtAdSetLevel ? (
                      <p className="text-[11px] text-muted">across ad sets</p>
                    ) : null}
                  </>
                ) : c.lifetimeBudgetCents != null ? (
                  `${money(c.lifetimeBudgetCents, currency)} lifetime`
                ) : (
                  "—"
                )}
              </td>
              <td className="py-2 pr-3 text-right text-foreground">
                {money(c.spendCents, currency)}
              </td>
              <td className="py-2 pr-3 text-right">
                {c.results != null ? count(c.results) : "—"}
                {c.results != null || c.resultLabel === "Mixed goals" ? (
                  <p className="text-[11px] text-muted">{c.resultLabel.toLowerCase()}</p>
                ) : null}
              </td>
              <td className="py-2 pr-3 text-right">
                {money(c.costPerResultCents, currency)}
              </td>
              <td className="py-2 pr-3 text-right">
                {c.roas != null ? `${c.roas.toFixed(2)}×` : "—"}
              </td>
              <td className="py-2 text-right">{c.linkCtr.toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- main --------------------------------------------------------------------

export function MetaAccountSummary() {
  const { clients, selectedClientId, setSelectedClientId } = useApp();
  const clientId = selectedClientId ?? clients[0]?.id ?? null;
  const [range, setRange] = useState<DashboardRange>("7d");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [campaignView, setCampaignView] = useState<"active" | "top">("active");
  // The last response and which filter combination it answers. While a new
  // request is in flight the previous frame stays on screen (dimmed).
  const [loaded, setLoaded] = useState<{
    key: string;
    result: ApiResult | null;
    error: string | null;
  } | null>(null);

  const requestKey = clientId
    ? `${clientId}|${range}|${accountId ?? ""}|${reloadTick}`
    : null;

  useEffect(() => {
    if (!clientId || !requestKey) return;
    let cancelled = false;
    const params = new URLSearchParams({ clientId, range });
    if (accountId) params.set("accountId", accountId);
    apiFetch<ApiResult>(`/api/dashboard/meta?${params}`)
      .then((data) => {
        if (!cancelled) setLoaded({ key: requestKey, result: data, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoaded((prev) => ({
          key: requestKey,
          result: prev?.result ?? null,
          error: err instanceof Error ? err.message : "Could not load the ad account",
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, range, accountId, requestKey]);

  const loading = requestKey != null && loaded?.key !== requestKey;
  const load = () => setReloadTick((n) => n + 1);
  const result = loaded?.result ?? null;
  const error = loaded?.key === requestKey ? loaded.error : null;
  const dash = result?.state === "ok" ? result.dashboard : null;
  const currency = dash?.account.currency ?? "USD";
  const capUse = useMemo(() => {
    if (!dash?.account.spendCapCents) return null;
    return dash.account.amountSpentCents / dash.account.spendCapCents;
  }, [dash]);

  return (
    <Card className="mb-6">
      <CardHeader className="space-y-3 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-accent" aria-hidden />
            <CardTitle className="text-base">Ad account overview</CardTitle>
            {result?.state === "ok" && result.demo ? (
              <Badge variant="secondary">Demo data</Badge>
            ) : null}
          </div>
          {dash ? (
            <p className="text-[11px] text-muted">
              Updated {formatRelative(dash.fetchedAt)}
            </p>
          ) : null}
        </div>

        {/* Filters — one row, scoping everything below. */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={clientId ?? undefined}
            onValueChange={(value) => {
              setAccountId(null);
              setSelectedClientId(value);
            }}
          >
            <SelectTrigger className="h-8 w-full text-xs sm:w-[200px]" aria-label="Client">
              <SelectValue placeholder="Select client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {result && result.accounts.length > 1 ? (
            <Select
              value={accountId ?? dash?.account.id ?? undefined}
              onValueChange={(value) => setAccountId(value)}
            >
              <SelectTrigger className="h-8 w-full text-xs sm:w-[220px]" aria-label="Ad account">
                <SelectValue placeholder="Ad account" />
              </SelectTrigger>
              <SelectContent>
                {result.accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <div
            role="radiogroup"
            aria-label="Date range"
            className="flex flex-wrap rounded-lg border border-border bg-secondary/40 p-0.5"
          >
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                role="radio"
                aria-checked={range === r.key}
                onClick={() => setRange(r.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs transition-colors",
                  range === r.key
                    ? "bg-card font-medium text-foreground shadow-sm"
                    : "text-muted hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2"
            onClick={load}
            disabled={loading || !clientId}
            aria-label="Refresh ad account data"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        {!clientId ? (
          <p className="text-sm text-muted">Add a client to see its ad account here.</p>
        ) : error ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger-muted/40 px-3 py-2 text-sm">
            <span className="text-danger">{error}</span>
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        ) : !result ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-[78px] rounded-lg" />
            ))}
          </div>
        ) : result.state !== "ok" ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-border-subtle bg-secondary/30 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted">{result.message}</p>
            {result.state === "not_connected" ? (
              <MetaConnectButton variant="compact" returnTo="/dashboard" />
            ) : (
              <Button size="sm" variant="outline" asChild>
                <Link href="/admin/connections">Open Connections</Link>
              </Button>
            )}
          </div>
        ) : dash ? (
          // Refetch keeps the previous frame, dimmed, instead of a skeleton flash.
          <div className={cn("space-y-5 transition-opacity", loading && "opacity-60")}>
            {/* Account line */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="text-sm font-medium text-foreground">{dash.account.name}</span>
              <span className="font-mono">{dash.account.id}</span>
              <span>
                {dash.account.currency} · {dash.account.timezone}
              </span>
              <Badge variant={dash.account.statusProblem ? "danger" : "success"} className="gap-1">
                {dash.account.statusProblem ? (
                  <AlertTriangle className="h-3 w-3" aria-hidden />
                ) : (
                  <CheckCircle2 className="h-3 w-3" aria-hidden />
                )}
                {dash.account.statusLabel}
              </Badge>
              {dash.account.disableReason ? (
                <span className="text-danger">Reason: {dash.account.disableReason}</span>
              ) : null}
              {dash.range.since ? (
                <span>
                  {shortDate(dash.range.since)}
                  {dash.range.until && dash.range.until !== dash.range.since
                    ? ` – ${shortDate(dash.range.until)}`
                    : ""}
                </span>
              ) : null}
            </div>

            {/* Spend vs allotted budget */}
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)]">
              <div className="rounded-lg border border-border-subtle bg-secondary/30 p-4">
                <p className="text-xs text-muted">
                  Spent · {RANGES.find((r) => r.key === dash.range.key)?.label.toLowerCase()}
                </p>
                <p className="mt-1 text-4xl font-semibold tracking-tight text-foreground">
                  {money(dash.totals.spendCents, currency)}
                </p>
                <p className="mt-1 text-xs text-muted">
                  of {money(dash.budget.expectedSpendCents, currency)} allotted over{" "}
                  {dash.range.days} day{dash.range.days === 1 ? "" : "s"}
                </p>
                <div className="mt-3">
                  {dash.budget.pacing != null ? (
                    <Meter
                      value={dash.budget.pacing}
                      tone={pacingTone(dash.budget.pacing)}
                      label="Spend against allotted budget"
                    />
                  ) : null}
                  <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                    {dash.budget.pacing != null && pacingTone(dash.budget.pacing) !== "accent" ? (
                      <AlertTriangle className="h-3 w-3 text-warning" aria-hidden />
                    ) : null}
                    {dash.budget.pacing != null ? `${pct(dash.budget.pacing)} · ` : ""}
                    {pacingNote(dash.budget.pacing)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Tile
                  label="Daily budget allotted"
                  value={money(dash.budget.dailyAllottedCents, currency)}
                  sub={`${dash.budget.activeCampaigns} campaigns · ${dash.budget.activeAdSets} ad sets delivering`}
                />
                <Tile
                  label={dash.totals.results != null ? dash.totals.resultLabel : "Results"}
                  value={dash.totals.results != null ? count(dash.totals.results) : "—"}
                  sub={
                    dash.totals.results == null
                      ? dash.totals.resultLabel === "Mixed goals"
                        ? "Campaigns optimise for different goals — see the table"
                        : "No results reported for this period"
                      : dash.totals.costPerResultCents != null
                        ? `${money(dash.totals.costPerResultCents, currency)} each`
                        : "No results yet"
                  }
                />
                <Tile
                  label={dash.totals.roas != null ? "ROAS" : "CTR (link)"}
                  value={
                    dash.totals.roas != null
                      ? `${dash.totals.roas.toFixed(2)}×`
                      : `${dash.totals.linkCtr.toFixed(2)}%`
                  }
                  sub={
                    dash.totals.roas != null
                      ? `${money(dash.totals.purchaseValueCents, currency)} purchase value`
                      : `${count(dash.totals.linkClicks)} link clicks · CTR (all) ${dash.totals.ctr.toFixed(2)}%`
                  }
                />
                <Tile
                  label="Reach"
                  value={count(dash.totals.reach)}
                  sub={`Frequency ${dash.totals.frequency.toFixed(2)}`}
                />
                <Tile
                  label="CPM"
                  value={money(dash.totals.cpmCents, currency)}
                  sub={`${count(dash.totals.impressions)} impressions`}
                />
                <Tile
                  label="CPC (link)"
                  value={money(dash.totals.costPerLinkClickCents, currency)}
                  sub={`CPC (all) ${money(dash.totals.cpcCents, currency)} · ${count(dash.totals.clicks)} clicks`}
                />
              </div>
            </div>

            {/* Billing */}
            <div className="grid gap-3 sm:grid-cols-3">
              <Tile
                label="Lifetime spent"
                value={money(dash.account.lifetimeSpendCents, currency)}
                sub="All-time amount spent, as in Ads Manager"
              />
              <div className="rounded-lg border border-border-subtle bg-secondary/30 px-3.5 py-3">
                <p className="text-xs text-muted">
                  {dash.account.spendCapCents != null
                    ? "Left before spending limit"
                    : "Account spending limit"}
                </p>
                <p className="mt-1 text-xl font-semibold text-foreground">
                  {dash.account.spendCapCents != null
                    ? money(dash.account.spendCapCents - dash.account.amountSpentCents, currency)
                    : "No limit"}
                </p>
                {capUse != null ? (
                  <div className="mt-1.5">
                    <Meter
                      value={capUse}
                      tone={capUse >= 0.9 ? "danger" : capUse >= 0.75 ? "warning" : "accent"}
                      label="Spending limit used"
                    />
                    <p className="mt-1 text-xs text-muted">
                      {pct(capUse)} of {money(dash.account.spendCapCents, currency)} used
                      {capUse >= 0.9 ? " — ads stop when it is reached" : ""}
                    </p>
                  </div>
                ) : (
                  <p className="mt-0.5 text-xs text-muted">Remaining before ads pause</p>
                )}
              </div>
              <Tile
                label={dash.account.isPrepay ? "Prepaid funds" : "Current balance"}
                value={money(dash.account.balanceCents, currency)}
                sub={
                  <>
                    {dash.account.paymentMethod
                      ? `Paid with ${dash.account.paymentMethod}. `
                      : ""}
                    Meta refreshes this periodically, so it can differ from the
                    Billing page by a few cents.
                  </>
                }
              />
            </div>

            {/* Daily spend */}
            {dash.range.key !== "today" ? (
              <div>
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">Daily spend</p>
                  <p className="text-[11px] text-muted">
                    Line marks today&apos;s total daily budget
                  </p>
                </div>
                <DailySpendChart
                  daily={dash.daily}
                  dailyBudgetCents={dash.budget.dailyAllottedCents}
                  currency={currency}
                />
                <details className="mt-2 text-xs text-muted">
                  <summary className="cursor-pointer select-none hover:text-foreground">
                    View as table
                  </summary>
                  <table className="mt-2 w-full max-w-sm text-left">
                    <thead>
                      <tr className="border-b border-border-subtle">
                        <th className="py-1 font-medium">Date</th>
                        <th className="py-1 text-right font-medium">Spend</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {dash.daily.map((d) => (
                        <tr key={d.date} className="border-b border-border-subtle/60">
                          <td className="py-1">{shortDate(d.date)}</td>
                          <td className="py-1 text-right text-foreground">
                            {money(d.spendCents, currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </div>
            ) : null}

            {/* Campaigns */}
            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">Campaigns</p>
                <div
                  role="radiogroup"
                  aria-label="Campaign list"
                  className="flex rounded-lg border border-border bg-secondary/40 p-0.5"
                >
                  {(
                    [
                      ["active", `Active (${dash.activeCampaigns.length})`],
                      ["top", "Top by spend"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      role="radio"
                      aria-checked={campaignView === key}
                      onClick={() => setCampaignView(key)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs transition-colors",
                        campaignView === key
                          ? "bg-card font-medium text-foreground shadow-sm"
                          : "text-muted hover:text-foreground",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <CampaignTable
                rows={campaignView === "active" ? dash.activeCampaigns : dash.campaigns}
                currency={currency}
                emptyText={
                  campaignView === "active"
                    ? "No campaigns are delivering right now."
                    : "No campaign spend in this period."
                }
              />
            </div>
            {dash.warnings.length ? (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                Some figures could not be loaded: {dash.warnings.join("; ")}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
