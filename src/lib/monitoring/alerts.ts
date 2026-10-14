import type { MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import type { ResolvedGoals } from "@/lib/clients/goals";
import { assessFatigue } from "@/lib/creative/fatigue";
import type { AccountHealth, TrackingSignal } from "@/lib/monitoring/health";
import { formatMoney } from "@/lib/monitoring/health";

/**
 * Scheduled monitoring alerts. Each alert has a stable key (what + which
 * entity) so it is notified once, can be acknowledged or snoozed, and
 * resolves itself when the problem is gone. Alerts with a known fix carry a
 * draft action that is queued for approval — never executed.
 */
export type MonitorAlert = {
  key: string;
  severity: "critical" | "warning";
  title: string;
  detail: string;
  action?: { tool: string; args: Record<string, unknown>; rationale: string };
};

export type AlertState = {
  key: string;
  severity: "critical" | "warning";
  first_seen_at: string;
  last_seen_at: string;
  notified_at: string | null;
  acknowledged_at: string | null;
  snoozed_until: string | null;
  resolved_at: string | null;
  approval_id: string | null;
};

/** Health codes worth checking hourly: delivery, tracking and account status. */
export const HOURLY_CODES = new Set(["ACCOUNT_STATUS", "SPEND_CAP", "NO_DELIVERY", "TRACKING_STOPPED", "AD_ISSUES"]);

const CONVERSION_LABEL = /lead|purchase|registration|conversion|sale|contact|schedul|appointment|submi|subscri|trial|checkout|install|messag|call|order|sign/i;

export function alertsFromHealth(health: AccountHealth): MonitorAlert[] {
  return health.findings
    .filter((f) => f.severity === "critical" || f.severity === "warning")
    .map((f) => ({
      key: `${f.code}:${f.campaignId ?? "account"}`,
      severity: f.severity as "critical" | "warning",
      title: f.title,
      detail: f.detail,
    }));
}

const live = (status: string) => status === "ACTIVE" || status === "WITH_ISSUES";
const spendOf = (p: PeriodPerformance | null | undefined) => p?.spendCents ?? 0;

export function alertsFromAudit(snap: MetaAuditSnapshot, goals: ResolvedGoals): MonitorAlert[] {
  const out: MonitorAlert[] = [];
  const account = snap.account.id;
  const money = (cents: number) => formatMoney(cents, snap.account.currency);
  const days = Math.max(1, snap.period.days);
  const target = goals.target_cpa_cents ?? null;
  const step = Math.min(goals.policy.scale_step_pct, goals.max_budget_change_pct);
  const liveSets = snap.adSets.filter((a) => live(a.status));
  const setById = new Map(snap.adSets.map((a) => [a.id, a]));

  // Account cost per result against the client's target (conversions only).
  const totals = snap.totals;
  if (target && totals?.costPerResultCents != null && CONVERSION_LABEL.test(totals.resultLabel)) {
    const ratio = totals.costPerResultCents / target;
    if (ratio > 1.2) {
      out.push({
        key: "CPR_OVER_TARGET:account",
        severity: ratio > 1.5 ? "critical" : "warning",
        title: `Cost per result ${Math.round(ratio * 100)}% of target`,
        detail: `${money(totals.costPerResultCents)} per ${totals.resultLabel.toLowerCase()} over the last ${days} days against a ${money(target)} target.`,
      });
    }
  }

  for (const set of liveSets) {
    const p = set.performance;
    if (set.learningStatus === "FAIL" && spendOf(p) > 0) {
      out.push({
        key: `LEARNING_LIMITED:${set.id}`,
        severity: "warning",
        title: `${set.name} is learning limited`,
        detail: "It isn't getting enough results to exit learning. Consolidate it with a similar ad set, raise its budget, or optimise for a more frequent event.",
      });
    }
    if (!target || !p) continue;
    const budget = set.dailyBudgetCents;
    const cpr = p.costPerResultCents;
    if (cpr != null && (p.results ?? 0) >= 5 && cpr <= target * 0.8 && budget && p.spendCents / days >= budget * 0.9) {
      const next = Math.round(budget * (1 + step / 100));
      out.push({
        key: `WINNER_CAPPED:${set.id}`,
        severity: "warning",
        title: `${set.name} is beating target but capped by its budget`,
        detail: `${money(cpr)} per result (target ${money(target)}) while spending its full ${money(budget)}/day.`,
        action: {
          tool: "update_adset_budget",
          args: { account_id: account, adset_id: set.id, daily_budget_cents: next, previous_daily_budget_cents: budget },
          rationale: `Raise ${set.name} by ${step}% (${money(budget)} → ${money(next)}/day): ${money(cpr)} per result against a ${money(target)} target, and it spends its whole budget.`,
        },
      });
    } else if (cpr != null && cpr > target * 1.5 && p.spendCents >= target * 2) {
      const next = budget ? Math.round(budget * (1 - step / 100)) : null;
      out.push({
        key: `ADSET_OVER_TARGET:${set.id}`,
        severity: "warning",
        title: `${set.name} costs ${Math.round((cpr / target) * 100)}% of target`,
        detail: `${money(cpr)} per result against a ${money(target)} target over ${days} days.`,
        ...(budget && next
          ? {
              action: {
                tool: "update_adset_budget",
                args: { account_id: account, adset_id: set.id, daily_budget_cents: next, previous_daily_budget_cents: budget },
                rationale: `Trim ${set.name} by ${step}% (${money(budget)} → ${money(next)}/day): ${money(cpr)} per result against a ${money(target)} target.`,
              },
            }
          : {}),
      });
    } else if (!(p.results ?? 0) && p.spendCents >= target * goals.policy.kill_multiple) {
      out.push({
        key: `ADSET_NO_RESULTS:${set.id}`,
        severity: "critical",
        title: `${set.name} spent ${money(p.spendCents)} with no results`,
        detail: `That's ${goals.policy.kill_multiple}× the ${money(target)} target with nothing to show.`,
        action: {
          tool: "pause_adset",
          args: { account_id: account, adset_id: set.id },
          rationale: `Pause ${set.name}: ${money(p.spendCents)} spent in ${days} days with no results (${goals.policy.kill_multiple}× the ${money(target)} target).`,
        },
      });
    }
  }

  // Ads: fatigue by the shared rule, and disapproved ads in live ad sets.
  const liveAds = snap.ads.filter((a) => live(a.status));
  const pausing = new Set<string>();
  for (const ad of snap.ads) {
    const set = setById.get(ad.adSetId);
    if (ad.status === "DISAPPROVED" && set && live(set.status)) {
      out.push({
        key: `DISAPPROVED_AD:${ad.id}`,
        severity: "warning",
        title: `${ad.name} was disapproved`,
        detail: `${ad.issue ?? "Meta rejected it."} Its ad set ${set.name} is still running, so fix or replace the ad.`,
      });
    }
    if (!live(ad.status) || !ad.performance || ad.frequency7d == null || spendOf(ad.performance) <= 0) continue;
    const verdict = assessFatigue(
      { impressions: ad.performance.impressions, frequency7d: ad.frequency7d, ctrNow: ad.performance.linkCtr },
      { frequencyMax: goals.policy.prospecting_frequency_max },
    );
    if (!verdict.fatigued) continue;
    // Never empty an ad set: something must keep delivering.
    const siblings = liveAds.filter((a) => a.adSetId === ad.adSetId && a.id !== ad.id && !pausing.has(a.id));
    const canPause = siblings.length > 0 && pausing.size < 3;
    if (canPause) pausing.add(ad.id);
    out.push({
      key: `AD_FATIGUE:${ad.id}`,
      severity: "warning",
      title: `${ad.name} is fatigued`,
      detail: canPause ? verdict.reason : `${verdict.reason} It's the only live ad in its ad set — add a replacement before pausing it.`,
      ...(canPause
        ? {
            action: {
              tool: "pause_ad",
              args: { account_id: account, ad_id: ad.id },
              rationale: `Pause fatigued ad ${ad.name}: ${verdict.reason}`,
            },
          }
        : {}),
    });
  }
  return out;
}

/** The optimisation event's weekly count halved against a week ago (and wasn't tiny). */
export function trackingDropAlerts(current: TrackingSignal[], baseline: TrackingSignal[]): MonitorAlert[] {
  const before = new Map(baseline.map((s) => [`${s.pixelId}:${s.eventName}`, s.events7d]));
  return current.flatMap((s) => {
    const was = before.get(`${s.pixelId}:${s.eventName}`);
    if (s.events7d == null || was == null || was < 20 || s.events7d >= was * 0.5) return [];
    return [
      {
        key: `TRACKING_DROP:${s.pixelId}:${s.eventName}`,
        severity: "warning" as const,
        title: `${s.eventName} events down ${Math.round((1 - s.events7d / was) * 100)}% week on week`,
        detail: `${s.events7d} this week against ${was} the week before, on the event ${s.adSetNames.slice(0, 3).join(", ")} optimise for. Check the pixel and Conversions API before trusting results.`,
      },
    ];
  });
}

/**
 * What to notify, store and resolve. A new alert (or one back after
 * resolving, or one that got worse) is notified once; snoozed or
 * acknowledged alerts stay quiet. Open alerts this run checked and didn't
 * find are resolved.
 */
export function planAlertUpdates(
  alerts: MonitorAlert[],
  existing: AlertState[],
  now: Date,
  inScope: (key: string) => boolean = () => true,
): { notify: MonitorAlert[]; upsert: AlertState[]; resolved: string[] } {
  const ts = now.toISOString();
  const byKey = new Map(existing.map((s) => [s.key, s]));
  const notify: MonitorAlert[] = [];
  const upsert: AlertState[] = [];
  for (const alert of alerts) {
    const prev = byKey.get(alert.key);
    const fresh = !prev || prev.resolved_at != null;
    const worse = prev != null && !fresh && prev.severity === "warning" && alert.severity === "critical";
    const quiet = prev != null && !fresh && ((prev.snoozed_until != null && prev.snoozed_until > ts) || prev.acknowledged_at != null);
    const send = fresh || (worse && !quiet);
    if (send) notify.push(alert);
    upsert.push({
      key: alert.key,
      severity: alert.severity,
      first_seen_at: fresh ? ts : prev!.first_seen_at,
      last_seen_at: ts,
      notified_at: send ? ts : (prev?.notified_at ?? null),
      acknowledged_at: fresh ? null : (prev?.acknowledged_at ?? null),
      snoozed_until: fresh ? null : (prev?.snoozed_until ?? null),
      resolved_at: null,
      approval_id: fresh ? null : (prev?.approval_id ?? null),
    });
  }
  const seen = new Set(alerts.map((a) => a.key));
  const resolved = existing.filter((s) => s.resolved_at == null && !seen.has(s.key) && inScope(s.key)).map((s) => s.key);
  return { notify, upsert, resolved };
}
