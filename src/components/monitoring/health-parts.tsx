"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HealthKpi, HealthSeverity, HealthStatus } from "@/lib/monitoring/health";
import type { HealthHistoryPoint } from "@/lib/monitoring/service";

// ---- formatting --------------------------------------------------------------

export function money(cents: number | null | undefined, currency: string) {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(cents) >= 100_000 ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function count(value: number | null | undefined) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en", {
    notation: value >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 100_000 ? 1 : 0,
  }).format(value);
}

export function kpiValue(kpi: Pick<HealthKpi, "format">, value: number | null, currency: string) {
  if (value == null) return "—";
  switch (kpi.format) {
    case "money":
      return money(value, currency);
    case "percent":
      return `${value.toFixed(2)}%`;
    case "decimal":
      return value.toFixed(2);
    default:
      return count(value);
  }
}

export function shortDate(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---- status ------------------------------------------------------------------

export const STATUS_META: Record<HealthStatus, { label: string; tone: string; badge: "success" | "warning" | "danger" }> = {
  healthy: { label: "Healthy", tone: "text-success", badge: "success" },
  watch: { label: "Watch", tone: "text-warning", badge: "warning" },
  at_risk: { label: "At risk", tone: "text-danger", badge: "danger" },
};

export const SEVERITY_META: Record<HealthSeverity, { label: string; dot: string; badge: "danger" | "warning" | "muted" }> = {
  critical: { label: "Critical", dot: "bg-danger", badge: "danger" },
  warning: { label: "Warning", dot: "bg-warning", badge: "warning" },
  info: { label: "Info", dot: "bg-muted", badge: "muted" },
};

/** Circular 0–100 score; the arc colour carries the status. */
export function ScoreRing({ score, status, size = 88 }: { score: number; status: HealthStatus; size?: number }) {
  const stroke = size >= 64 ? 8 : 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-secondary" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(0, Math.min(100, score)) / 100)}
          className={cn(STATUS_META[status].tone, "transition-[stroke-dashoffset] duration-500")}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("font-semibold tabular-nums text-foreground", size >= 64 ? "text-2xl" : "text-xs")}>
          {score}
        </span>
        {size >= 64 ? <span className="text-[10px] uppercase tracking-wide text-muted">score</span> : null}
      </div>
    </div>
  );
}

/**
 * Change chip. Green/red follow whether the move is good for this metric
 * (CPM down is good, results down is bad); tiny moves stay neutral.
 */
export function Delta({ change, better }: { change: number | null; better: "up" | "down" | null }) {
  if (change == null || !Number.isFinite(change)) {
    return <span className="text-[11px] text-muted">no baseline</span>;
  }
  const flat = Math.abs(change) < 3;
  const up = change > 0;
  const good = better == null || flat ? null : (better === "up") === up;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums",
        good == null ? "text-muted" : good ? "text-success" : "text-danger",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {flat ? "flat" : `${up ? "+" : ""}${change.toFixed(0)}%`}
    </span>
  );
}

/** Score trend over recent daily checks. */
export function ScoreTrend({ points }: { points: HealthHistoryPoint[] }) {
  if (points.length < 2) {
    return (
      <p className="text-xs text-muted">
        The trend fills in as daily checks run — one point per day.
      </p>
    );
  }
  const w = 280;
  const h = 56;
  const step = w / (points.length - 1);
  const y = (score: number) => h - 4 - (score / 100) * (h - 8);
  const line = points.map((p, i) => `${(i * step).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");
  const last = points[points.length - 1]!;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none" role="img" aria-label="Health score trend">
        <line x1={0} x2={w} y1={y(80)} y2={y(80)} className="stroke-border" strokeDasharray="3 3" strokeWidth={1} />
        <line x1={0} x2={w} y1={y(50)} y2={y(50)} className="stroke-border" strokeDasharray="3 3" strokeWidth={1} />
        <polyline points={line} fill="none" stroke="currentColor" strokeWidth={2} className={STATUS_META[last.status].tone} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted">
        <span>{shortDate(points[0]!.date)}</span>
        <span>dashed lines: 80 healthy · 50 at risk</span>
        <span>{shortDate(last.date)}</span>
      </div>
    </div>
  );
}
