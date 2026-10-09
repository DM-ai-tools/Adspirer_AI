import type { MetaGraphClient } from "@/lib/meta/graph-client";
import { metaMinorToCents } from "@/lib/meta/currency";
import { resultLabelFor } from "@/lib/meta/account-dashboard";
import { pixelStats } from "@/lib/audit/meta-audit-data";

/** promoted_object.custom_event_type → pixel event name. */
const PIXEL_EVENT: Record<string, string> = {
  PURCHASE: "Purchase",
  LEAD: "Lead",
  COMPLETE_REGISTRATION: "CompleteRegistration",
  ADD_TO_CART: "AddToCart",
  INITIATED_CHECKOUT: "InitiateCheckout",
  CONTACT: "Contact",
  SCHEDULE: "Schedule",
  SUBMIT_APPLICATION: "SubmitApplication",
  START_TRIAL: "StartTrial",
  SUBSCRIBE: "Subscribe",
};

function list(names: string[]) {
  const shown = names.slice(0, 2).map((n) => `"${n}"`).join(", ");
  return names.length > 2 ? `${shown} and ${names.length - 2} more` : shown;
}

/**
 * Account health watch: compares the last N full days with the N days before
 * and flags what an account manager should look at today — delivery stopping,
 * spend without results, rising cost per result, fatigue, spend-cap risk,
 * rejected ads. Read-only: it never changes anything on Meta.
 *
 * Fetching (`fetchHealthSnapshot`) and judging (`evaluateHealth`) are split so
 * the rules are unit-testable without Graph.
 */

export const HEALTH_WINDOWS = [7, 14, 30] as const;
export type HealthWindow = (typeof HEALTH_WINDOWS)[number];

export type PeriodMetrics = {
  spendCents: number;
  impressions: number;
  linkClicks: number;
  /** Link CTR, percent. */
  linkCtr: number;
  cpmCents: number | null;
  frequency: number;
  /** Meta "Results" for the optimisation goal; null when none or mixed goals. */
  results: number | null;
  resultLabel: string;
  costPerResultCents: number | null;
};

export type CampaignHealthRow = {
  id: string;
  name: string;
  /** Currently delivering (effective_status ACTIVE). */
  delivering: boolean;
  dailyBudgetCents: number | null;
  startTime: string | null;
  current: PeriodMetrics;
  previous: PeriodMetrics;
};

export type AdIssue = {
  id: string;
  name: string;
  status: string;
  campaignId: string | null;
  campaignName: string | null;
  reason: string | null;
};

/** A live ad set's optimisation event and how often it fired this week. */
export type TrackingSignal = {
  pixelId: string;
  eventName: string;
  /** Events recorded in the last 7 days; null when the pixel couldn't be read. */
  events7d: number | null;
  adSetNames: string[];
};

export type HealthSnapshot = {
  account: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    statusLabel: string;
    statusProblem: boolean;
    disableReason: string | null;
    amountSpentCents: number;
    spendCapCents: number | null;
  };
  window: {
    days: number;
    current: { since: string; until: string };
    previous: { since: string; until: string };
  };
  current: PeriodMetrics;
  previous: PeriodMetrics;
  dailyAllottedCents: number;
  activeCampaigns: number;
  campaigns: CampaignHealthRow[];
  adIssues: AdIssue[];
  /** Conversion tracking for live ad sets (empty when none optimise for an event). */
  tracking?: TrackingSignal[];
  /** Parts that failed to load; the rest still evaluates. */
  warnings: string[];
  fetchedAt: string;
  demo?: boolean;
};

export type HealthSeverity = "critical" | "warning" | "info";
export type HealthStatus = "healthy" | "watch" | "at_risk";

export type HealthFinding = {
  code: string;
  severity: HealthSeverity;
  title: string;
  detail: string;
  campaignId?: string;
  campaignName?: string;
  /** Prefilled workspace prompt so the agent can investigate this finding. */
  ask: string;
};

export type HealthKpi = {
  key: "spend" | "results" | "cpr" | "linkCtr" | "cpm" | "frequency";
  label: string;
  current: number | null;
  previous: number | null;
  /** Percent change; null when there is no comparable baseline. */
  changePct: number | null;
  format: "money" | "number" | "percent" | "decimal";
  /** Which direction is good for this metric. */
  better: "up" | "down" | null;
};

export type AccountHealth = HealthSnapshot & {
  score: number;
  status: HealthStatus;
  findings: HealthFinding[];
  kpis: HealthKpi[];
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<HealthSeverity, number> = { critical: 0, warning: 1, info: 2 };
const SEVERITY_PENALTY: Record<HealthSeverity, number> = { critical: 25, warning: 10, info: 3 };

export function changePct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      maximumFractionDigits: cents >= 100_000 ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(0)}%`;

export function evaluateHealth(snapshot: HealthSnapshot): AccountHealth {
  const findings: HealthFinding[] = [];
  const { account, current: cur, previous: prev, window } = snapshot;
  const money = (c: number) => formatMoney(c, account.currency);
  const days = window.days;
  const period = `the last ${days} days`;
  const label = cur.resultLabel || "results";
  const add = (f: HealthFinding) => findings.push(f);

  // ---- Account-level blockers -------------------------------------------
  if (account.statusProblem) {
    add({
      code: "ACCOUNT_STATUS",
      severity: "critical",
      title: `Ad account is ${account.statusLabel.toLowerCase()}`,
      detail: account.disableReason
        ? `Meta reports: ${account.disableReason}. Ads cannot deliver until this is resolved.`
        : "Meta is not delivering ads for account-level reasons. Check Account Quality and Billing.",
      ask: `The ad account ${account.name} shows status "${account.statusLabel}". Explain what this means and the steps to restore delivery.`,
    });
  }

  if (account.spendCapCents && account.spendCapCents > 0) {
    const used = account.amountSpentCents / account.spendCapCents;
    if (used >= 0.8) {
      const remaining = Math.max(0, account.spendCapCents - account.amountSpentCents);
      const perDay = cur.spendCents / days;
      const daysLeft = perDay > 0 ? Math.floor(remaining / perDay) : null;
      add({
        code: "SPEND_CAP",
        severity: used >= 0.95 ? "critical" : "warning",
        title: `Account spending limit ${Math.round(used * 100)}% used`,
        detail: `${money(remaining)} left of the ${money(account.spendCapCents)} limit${
          daysLeft != null ? ` — about ${daysLeft} day${daysLeft === 1 ? "" : "s"} at the current pace` : ""
        }. All ads stop when it is reached.`,
        ask: `The account spending limit is ${Math.round(used * 100)}% used. How much runway is left and what should the limit be raised to for next month's plan?`,
      });
    }
  }

  if (snapshot.activeCampaigns > 0 && cur.spendCents === 0 && !account.statusProblem) {
    add({
      code: "NO_DELIVERY",
      severity: "critical",
      title: "Active campaigns but no spend",
      detail: `${snapshot.activeCampaigns} campaign${snapshot.activeCampaigns === 1 ? " is" : "s are"} active yet nothing was spent in ${period}. Check billing, ad review and ad set schedules.`,
      ask: `Campaigns are active but the account spent nothing in ${period}. Diagnose why delivery stopped (billing, review, audience, schedule).`,
    });
  }

  // ---- Account-level trends ---------------------------------------------
  const resultsChange = changePct(cur.results, prev.results);
  if (resultsChange != null && (prev.results ?? 0) >= 5 && resultsChange <= -25) {
    add({
      code: "RESULTS_DOWN",
      severity: resultsChange <= -50 ? "critical" : "warning",
      title: `${label} down ${pct(resultsChange)}`,
      detail: `${cur.results} ${label.toLowerCase()} in ${period} vs ${prev.results} in the previous ${days} days, on ${money(cur.spendCents)} spend.`,
      ask: `${label} fell from ${prev.results} to ${cur.results} week over week. Find which campaigns, ad sets and ads drove the drop and propose fixes.`,
    });
  }

  const cprChange = changePct(cur.costPerResultCents, prev.costPerResultCents);
  if (
    cprChange != null &&
    (cur.results ?? 0) >= 3 &&
    (prev.results ?? 0) >= 3 &&
    cprChange >= 20
  ) {
    add({
      code: "CPR_UP",
      severity: cprChange >= 50 ? "critical" : "warning",
      title: `Cost per ${singular(label)} up ${pct(cprChange)}`,
      detail: `${money(cur.costPerResultCents!)} now vs ${money(prev.costPerResultCents!)} in the previous ${days} days.`,
      ask: `Cost per ${singular(label)} rose from ${money(prev.costPerResultCents!)} to ${money(cur.costPerResultCents!)}. Break down the cause (CPM, CTR, conversion rate) and recommend changes.`,
    });
  }

  const ctrChange = changePct(cur.linkCtr, prev.linkCtr);
  if (ctrChange != null && prev.impressions >= 1_000 && cur.impressions >= 1_000 && ctrChange <= -20) {
    add({
      code: "CTR_DOWN",
      severity: "warning",
      title: `Link CTR down ${pct(ctrChange)}`,
      detail: `${cur.linkCtr.toFixed(2)}% vs ${prev.linkCtr.toFixed(2)}% — usually creative fatigue or a weaker audience.`,
      ask: `Link CTR dropped from ${prev.linkCtr.toFixed(2)}% to ${cur.linkCtr.toFixed(2)}%. Which ads are fatiguing and what new creative angles should we test?`,
    });
  }

  const cpmChange = changePct(cur.cpmCents, prev.cpmCents);
  if (cpmChange != null && cpmChange >= 30 && cur.impressions >= 1_000) {
    add({
      code: "CPM_UP",
      severity: "info",
      title: `CPM up ${pct(cpmChange)}`,
      detail: `${money(cur.cpmCents!)} vs ${money(prev.cpmCents!)} per 1,000 impressions — auction costs or narrower targeting.`,
      ask: `CPM rose from ${money(prev.cpmCents!)} to ${money(cur.cpmCents!)}. Is this seasonal competition or our targeting? What should we change?`,
    });
  }

  if (cur.frequency >= 3.5) {
    add({
      code: "FREQUENCY_HIGH",
      severity: "warning",
      title: `Frequency ${cur.frequency.toFixed(1)} — audience fatigue risk`,
      detail: `People saw the ads ${cur.frequency.toFixed(1)} times on average in ${period}. Refresh creative or widen the audience.`,
      ask: `Account frequency is ${cur.frequency.toFixed(1)} over ${period}. Which ad sets are saturated and how should we expand or refresh them?`,
    });
  }

  // A rejected ad inside a delivering campaign is the usual reason delivery drops.
  const activeIds = new Set(snapshot.campaigns.filter((c) => c.delivering).map((c) => c.id));
  const blockingAds = snapshot.adIssues.filter((a) => a.campaignId && activeIds.has(a.campaignId));
  const likelyCause = blockingAds.length
    ? ` ${blockingAds.length} ad${blockingAds.length === 1 ? " is" : "s are"} rejected or limited in a live campaign — a likely cause.`
    : "";
  const pacing =
    snapshot.dailyAllottedCents > 0 ? cur.spendCents / (snapshot.dailyAllottedCents * days) : null;

  const spendChange = changePct(cur.spendCents, prev.spendCents);
  let deliveryFlagged = false;
  if (spendChange != null && cur.spendCents > 0) {
    if (spendChange >= 50) {
      add({
        code: "SPEND_SPIKE",
        severity: "info",
        title: `Spend up ${pct(spendChange)}`,
        detail: `${money(cur.spendCents)} vs ${money(prev.spendCents)} in the previous ${days} days. Confirm this was planned.`,
        ask: `Spend rose from ${money(prev.spendCents)} to ${money(cur.spendCents)}. Which campaigns drove it and did results keep pace?`,
      });
    } else if (spendChange <= -50) {
      deliveryFlagged = true;
      const nearlyStopped = pacing != null && pacing < 0.1;
      add({
        code: "SPEND_DROP",
        severity: nearlyStopped ? "critical" : "warning",
        title: nearlyStopped ? "Delivery has nearly stopped" : `Spend down ${pct(spendChange)}`,
        detail: `${money(cur.spendCents)} spent vs ${money(prev.spendCents)} in the previous ${days} days${
          pacing != null ? ` (${Math.round(pacing * 100)}% of today's daily budgets)` : ""
        }.${likelyCause || " Campaigns may be limited by budget, bids or ad review."}`,
        ask: `Spend fell from ${money(prev.spendCents)} to ${money(cur.spendCents)} over ${period}. Find which campaigns and ad sets stopped delivering and why, and how to restore delivery.`,
      });
    }
  }

  if (!deliveryFlagged && pacing != null && cur.spendCents > 0 && pacing < 0.6) {
    add({
      code: "UNDERPACING",
      severity: pacing < 0.1 ? "critical" : "warning",
      title: `Under-delivering: ${Math.round(pacing * 100)}% of budget spent`,
      detail: `${money(cur.spendCents)} spent vs ${money(snapshot.dailyAllottedCents * days)} at today's daily budgets.${
        likelyCause || " Bid caps, small audiences or learning-limited ad sets are common causes."
      }`,
      ask: `The account spent only ${Math.round(pacing * 100)}% of its daily budgets over ${period}. Which ad sets are under-delivering and why?`,
    });
  }

  // ---- Campaign-level -----------------------------------------------------
  const accountSpend = Math.max(1, cur.spendCents);
  for (const c of snapshot.campaigns) {
    const name = c.name;
    const startedRecently =
      c.startTime != null && Date.parse(c.startTime) > Date.parse(`${window.current.until}T00:00:00Z`) - 2 * 86_400_000;

    if (c.delivering && c.current.spendCents === 0 && (c.dailyBudgetCents ?? 0) > 0 && !startedRecently) {
      add({
        code: "CAMPAIGN_NOT_SPENDING",
        severity: "warning",
        title: "Active campaign not spending",
        detail: `"${name}" has a ${money(c.dailyBudgetCents!)}/day budget but spent nothing in ${period}.`,
        campaignId: c.id,
        campaignName: name,
        ask: `Campaign "${name}" is active with a ${money(c.dailyBudgetCents!)}/day budget but spent nothing in ${period}. Diagnose why it isn't delivering.`,
      });
      continue;
    }

    const threshold = Math.max((c.dailyBudgetCents ?? 0) * 2, accountSpend * 0.15);
    if (c.current.results === 0 && c.current.spendCents > 0 && c.current.spendCents >= threshold) {
      const share = c.current.spendCents / accountSpend;
      const what = c.current.resultLabel.toLowerCase();
      add({
        code: "SPEND_NO_RESULTS",
        severity: share >= 0.3 ? "critical" : "warning",
        title: `Spending with 0 ${what}`,
        detail: `"${name}" spent ${money(c.current.spendCents)} (${Math.round(share * 100)}% of account spend) in ${period} with no ${what}. Check tracking and the landing page before spending more.`,
        campaignId: c.id,
        campaignName: name,
        ask: `Campaign "${name}" spent ${money(c.current.spendCents)} in ${period} with 0 ${what}. Check pixel/conversion tracking, the landing page and targeting, and propose fixes.`,
      });
      continue;
    }

    const cChange = changePct(c.current.costPerResultCents, c.previous.costPerResultCents);
    if (cChange != null && cChange >= 30 && (c.current.results ?? 0) >= 3 && (c.previous.results ?? 0) >= 3) {
      add({
        code: "CAMPAIGN_CPR_UP",
        severity: "warning",
        title: `Cost per ${singular(c.current.resultLabel)} up ${pct(cChange)}`,
        detail: `"${name}": ${money(c.current.costPerResultCents!)} vs ${money(c.previous.costPerResultCents!)} in the previous ${days} days.`,
        campaignId: c.id,
        campaignName: name,
        ask: `Cost per ${singular(c.current.resultLabel)} on "${name}" rose ${pct(cChange)}. Which ad sets and ads are responsible and what should change?`,
      });
    }

    if (c.current.frequency >= 4 && c.current.spendCents > 0) {
      add({
        code: "CAMPAIGN_FATIGUE",
        severity: "warning",
        title: `Frequency ${c.current.frequency.toFixed(1)} on campaign`,
        detail: `"${name}" is reaching the same people repeatedly — expect rising costs.`,
        campaignId: c.id,
        campaignName: name,
        ask: `Campaign "${name}" has frequency ${c.current.frequency.toFixed(1)}. Suggest creative refreshes or audience expansion.`,
      });
    }
  }

  // Tracking first: an optimisation event that stopped firing means Meta is
  // bidding blind and every result figure above is under-reported.
  for (const t of snapshot.tracking ?? []) {
    if (t.events7d !== 0) continue;
    add({
      code: "TRACKING_STOPPED",
      severity: cur.spendCents > 0 ? "critical" : "warning",
      title: `No ${t.eventName} events recorded this week`,
      detail: `${list(t.adSetNames)} optimise${t.adSetNames.length === 1 ? "s" : ""} for ${t.eventName}, but the pixel recorded none in the last 7 days. Meta can't optimise or report results until tracking is fixed.`,
      ask: `The ${t.eventName} event hasn't fired in 7 days on pixel ${t.pixelId}, which live ad sets optimise for. Help me diagnose the tracking (pixel, Conversions API, thank-you page) and what to do with the ad sets meanwhile.`,
    });
  }

  if (snapshot.adIssues.length) {
    const disapproved = snapshot.adIssues.filter((a) => a.status === "DISAPPROVED");
    const names = snapshot.adIssues.slice(0, 3).map((a) => `"${a.name}"`).join(", ");
    add({
      code: "AD_ISSUES",
      severity: disapproved.length >= 3 ? "critical" : "warning",
      title: `${snapshot.adIssues.length} ad${snapshot.adIssues.length === 1 ? "" : "s"} rejected or with issues`,
      detail: `${names}${snapshot.adIssues.length > 3 ? " and more" : ""}. ${
        snapshot.adIssues.find((a) => a.reason)?.reason ?? "Open Account Quality for the policy reason."
      }`,
      ask: `These ads are disapproved or have delivery issues: ${names}. Explain the likely policy reasons and how to fix or replace them.`,
    });
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const score = Math.max(
    0,
    100 - findings.reduce((sum, f) => sum + SEVERITY_PENALTY[f.severity], 0),
  );
  const status: HealthStatus = findings.some((f) => f.severity === "critical") || score < 50
    ? "at_risk"
    : findings.some((f) => f.severity === "warning") || score < 80
      ? "watch"
      : "healthy";

  return { ...snapshot, findings, score, status, kpis: buildKpis(cur, prev) };
}

function singular(label: string): string {
  const l = label.toLowerCase();
  if (l === "mixed goals" || l === "results") return "result";
  return l.endsWith("ies") ? `${l.slice(0, -3)}y` : l.replace(/s$/, "");
}

function buildKpis(cur: PeriodMetrics, prev: PeriodMetrics): HealthKpi[] {
  const k = (
    key: HealthKpi["key"],
    label: string,
    c: number | null,
    p: number | null,
    format: HealthKpi["format"],
    better: HealthKpi["better"],
  ): HealthKpi => ({ key, label, current: c, previous: p, changePct: changePct(c, p), format, better });
  return [
    k("spend", "Spend", cur.spendCents, prev.spendCents, "money", null),
    k("results", cur.resultLabel, cur.results, prev.results, "number", "up"),
    k("cpr", `Cost per ${singular(cur.resultLabel)}`, cur.costPerResultCents, prev.costPerResultCents, "money", "down"),
    k("linkCtr", "Link CTR", cur.linkCtr || null, prev.linkCtr || null, "percent", "up"),
    k("cpm", "CPM", cur.cpmCents, prev.cpmCents, "money", "down"),
    k("frequency", "Frequency", cur.frequency || null, prev.frequency || null, "decimal", "down"),
  ];
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type MetaResultRow = { indicator?: string; values?: Array<{ value?: string }> };

const PROBLEM_STATUS: Record<number, string> = {
  2: "Disabled",
  3: "Unsettled payment",
  7: "Pending risk review",
  8: "Pending settlement",
  9: "In grace period",
  100: "Pending closure",
  101: "Closed",
};

const DISABLE_REASON: Record<number, string> = {
  1: "Ads integrity policy",
  2: "Ads IP review",
  3: "Risk payment",
  4: "Gray account shut down",
  5: "Ads AFC review",
  6: "Business integrity",
  7: "Permanent close",
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const majorToCents = (v: unknown) => Math.round(num(v) * 100);

/** YYYY-MM-DD for "today" in the ad account's timezone. */
function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Last N full days (today excluded — partial) and the N days before. */
export function healthWindow(today: string, days: number) {
  const until = shiftDay(today, -1);
  const since = shiftDay(until, -(days - 1));
  const prevUntil = shiftDay(since, -1);
  const prevSince = shiftDay(prevUntil, -(days - 1));
  return { days, current: { since, until }, previous: { since: prevSince, until: prevUntil } };
}

function emptyPeriod(label = "Results"): PeriodMetrics {
  return {
    spendCents: 0,
    impressions: 0,
    linkClicks: 0,
    linkCtr: 0,
    cpmCents: null,
    frequency: 0,
    results: null,
    resultLabel: label,
    costPerResultCents: null,
  };
}

function metaResult(row: Row): { indicator: string | null; count: number | null } {
  const results = Array.isArray(row.results) ? (row.results as MetaResultRow[]) : [];
  const indicator = results[0]?.indicator ?? null;
  if (!indicator || indicator === "mixed") return { indicator, count: null };
  return { indicator, count: num(results[0]?.values?.[0]?.value) };
}

function periodFrom(row: Row | undefined): PeriodMetrics {
  if (!row) return emptyPeriod();
  const r = metaResult(row);
  const spendCents = majorToCents(row.spend);
  return {
    spendCents,
    impressions: num(row.impressions),
    linkClicks: num(row.inline_link_clicks),
    linkCtr: num(row.inline_link_click_ctr),
    cpmCents: row.cpm != null ? majorToCents(row.cpm) : null,
    frequency: num(row.frequency),
    results: r.count,
    resultLabel: r.indicator && r.indicator !== "mixed" ? resultLabelFor(r.indicator) : r.indicator === "mixed" ? "Mixed goals" : "Results",
    costPerResultCents: r.count && r.count > 0 ? Math.round(spendCents / r.count) : null,
  };
}

/** Account Results = sum of campaign Results, only when every campaign shares one goal. */
function accountResults(campaignRows: Row[]): { count: number | null; label: string } {
  const indicators = new Set<string>();
  let total = 0;
  for (const row of campaignRows) {
    if (num(row.spend) <= 0) continue;
    const r = metaResult(row);
    if (!r.indicator) continue;
    indicators.add(r.indicator);
    total += r.count ?? 0;
  }
  if (indicators.size === 1 && !indicators.has("mixed")) {
    return { count: total, label: resultLabelFor([...indicators][0]!) };
  }
  return { count: null, label: indicators.size ? "Mixed goals" : "Results" };
}

async function settle<T>(label: string, warnings: string[], p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (error) {
    warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function fetchHealthSnapshot(
  graph: MetaGraphClient,
  accountId: string,
  days: number,
): Promise<HealthSnapshot> {
  const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  const warnings: string[] = [];
  const account = await graph.get<Row>(id, {
    fields: "name,currency,timezone_name,account_status,disable_reason,amount_spent,spend_cap",
  });
  const currency = String(account.currency ?? "USD");
  const timezone = String(account.timezone_name ?? "UTC");
  const toCents = (minor: unknown) => metaMinorToCents(num(minor), currency);
  const window = healthWindow(todayIn(timezone), days);
  const timeRanges = JSON.stringify([window.current, window.previous]);
  const active = JSON.stringify(["ACTIVE"]);

  const [accountRows, campaignRows, campaigns, adSets, ads] = await Promise.all([
    settle(
      "Account performance",
      warnings,
      graph.get<{ data?: Row[] }>(`${id}/insights`, {
        level: "account",
        time_ranges: timeRanges,
        fields: "spend,impressions,inline_link_clicks,inline_link_click_ctr,cpm,frequency",
      }),
    ),
    settle(
      "Campaign performance",
      warnings,
      graph.get<{ data?: Row[] }>(`${id}/insights`, {
        level: "campaign",
        time_ranges: timeRanges,
        fields:
          "campaign_id,campaign_name,spend,impressions,inline_link_clicks,inline_link_click_ctr,cpm,frequency,results,cost_per_result",
        limit: 500,
      }),
    ),
    settle(
      "Active campaigns",
      warnings,
      graph.get<{ data?: Row[] }>(`${id}/campaigns`, {
        fields: "id,name,daily_budget,lifetime_budget,start_time",
        effective_status: active,
        limit: 200,
      }),
    ),
    settle(
      "Ad set budgets",
      warnings,
      graph.get<{ data?: Row[] }>(`${id}/adsets`, {
        fields: "name,campaign_id,daily_budget,promoted_object",
        effective_status: active,
        limit: 500,
      }),
    ),
    settle(
      "Ad review status",
      warnings,
      graph.get<{ data?: Row[] }>(`${id}/ads`, {
        fields: "id,name,effective_status,campaign{id,name},issues_info,ad_review_feedback",
        effective_status: JSON.stringify(["DISAPPROVED", "WITH_ISSUES"]),
        limit: 50,
      }),
    ),
  ]);

  const isCurrent = (row: Row) => row.date_start === window.current.since;
  const isPrevious = (row: Row) => row.date_start === window.previous.since;
  const acc = accountRows?.data ?? [];
  const camp = campaignRows?.data ?? [];
  const curCamp = camp.filter(isCurrent);
  const prevCamp = camp.filter(isPrevious);

  const accountPeriod = (rows: Row[], campRows: Row[]): PeriodMetrics => {
    const base = periodFrom(rows[0]);
    const res = accountResults(campRows);
    return {
      ...base,
      results: res.count,
      resultLabel: res.label,
      costPerResultCents: res.count && res.count > 0 ? Math.round(base.spendCents / res.count) : null,
    };
  };

  // Daily budget per campaign: its own (CBO) or the sum of its ad sets (ABO).
  const adSetDaily = new Map<string, number>();
  let dailyAllotted = 0;
  for (const a of adSets?.data ?? []) {
    const cents = toCents(a.daily_budget);
    dailyAllotted += cents;
    const key = String(a.campaign_id ?? "");
    adSetDaily.set(key, (adSetDaily.get(key) ?? 0) + cents);
  }
  const activeRows = campaigns?.data ?? [];
  for (const c of activeRows) dailyAllotted += toCents(c.daily_budget);

  // Which conversion event each live ad set optimises for, and whether the
  // pixel recorded it this week (at most 3 pixels).
  const trackingKeys = new Map<string, { pixelId: string; eventName: string; adSetNames: string[] }>();
  for (const a of adSets?.data ?? []) {
    const promoted = (a.promoted_object ?? {}) as Row;
    const pixelId = typeof promoted.pixel_id === "string" ? promoted.pixel_id : null;
    const eventName = PIXEL_EVENT[String(promoted.custom_event_type ?? "")];
    if (!pixelId || !eventName) continue;
    const key = `${pixelId}:${eventName}`;
    const entry = trackingKeys.get(key) ?? { pixelId, eventName, adSetNames: [] };
    entry.adSetNames.push(String(a.name ?? a.id ?? "Ad set"));
    trackingKeys.set(key, entry);
  }
  const pixelIds = [...new Set([...trackingKeys.values()].map((t) => t.pixelId))].slice(0, 3);
  const pixelEvents = new Map(
    await Promise.all(
      pixelIds.map(async (pid) => [
        pid,
        await settle(`Pixel ${pid} events`, warnings, pixelStats(graph, pid, 7)),
      ] as const),
    ),
  );
  const tracking: TrackingSignal[] = [...trackingKeys.values()]
    .filter((t) => pixelEvents.has(t.pixelId))
    .map((t) => {
      const stats = pixelEvents.get(t.pixelId);
      return { ...t, events7d: stats ? (stats.events[t.eventName] ?? 0) : null };
    });

  const byId = new Map<string, CampaignHealthRow>();
  const ensure = (cid: string, name: string): CampaignHealthRow => {
    let row = byId.get(cid);
    if (!row) {
      row = {
        id: cid,
        name,
        delivering: false,
        dailyBudgetCents: null,
        startTime: null,
        current: emptyPeriod(),
        previous: emptyPeriod(),
      };
      byId.set(cid, row);
    }
    return row;
  };
  for (const c of activeRows) {
    const cid = String(c.id);
    const row = ensure(cid, String(c.name ?? cid));
    row.delivering = true;
    const own = toCents(c.daily_budget);
    row.dailyBudgetCents = own > 0 ? own : adSetDaily.get(cid) || null;
    row.startTime = typeof c.start_time === "string" ? c.start_time : null;
  }
  for (const r of curCamp) {
    const cid = String(r.campaign_id ?? "");
    ensure(cid, String(r.campaign_name ?? cid)).current = periodFrom(r);
  }
  for (const r of prevCamp) {
    const cid = String(r.campaign_id ?? "");
    ensure(cid, String(r.campaign_name ?? cid)).previous = periodFrom(r);
  }
  // A campaign with spend only in the previous period still has a goal label.
  for (const row of byId.values()) {
    if (row.current.resultLabel === "Results" && row.previous.resultLabel !== "Results") {
      row.current.resultLabel = row.previous.resultLabel;
    }
  }

  const statusCode = num(account.account_status);
  const disableCode = num(account.disable_reason);
  const spendCap = num(account.spend_cap);

  return {
    account: {
      id,
      name: String(account.name ?? id),
      currency,
      timezone,
      statusLabel: PROBLEM_STATUS[statusCode] ?? "Active",
      statusProblem: statusCode in PROBLEM_STATUS,
      disableReason: disableCode > 0 ? (DISABLE_REASON[disableCode] ?? `Reason ${disableCode}`) : null,
      amountSpentCents: toCents(account.amount_spent),
      spendCapCents: spendCap > 0 ? toCents(spendCap) : null,
    },
    window,
    current: accountPeriod(acc.filter(isCurrent), curCamp),
    previous: accountPeriod(acc.filter(isPrevious), prevCamp),
    dailyAllottedCents: dailyAllotted,
    activeCampaigns: activeRows.length,
    campaigns: [...byId.values()]
      .filter((c) => c.delivering || c.current.spendCents > 0 || c.previous.spendCents > 0)
      .sort((a, b) => b.current.spendCents - a.current.spendCents || b.previous.spendCents - a.previous.spendCents),
    tracking,
    adIssues: (ads?.data ?? []).map((a) => {
      const issues = Array.isArray(a.issues_info) ? (a.issues_info as Row[]) : [];
      const campaign = a.campaign as Row | undefined;
      // ad_review_feedback: { global: { "Policy name": "explanation" } }
      const feedback = (a.ad_review_feedback as { global?: Record<string, string> } | undefined)?.global;
      const policy = feedback ? Object.keys(feedback)[0] : undefined;
      return {
        id: String(a.id),
        name: String(a.name ?? a.id),
        status: String(a.effective_status ?? ""),
        campaignId: campaign?.id ? String(campaign.id) : null,
        campaignName: campaign?.name ? String(campaign.name) : null,
        reason: issues[0]?.error_summary
          ? String(issues[0].error_summary)
          : policy
            ? `Policy: ${policy}.`
            : null,
      };
    }),
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

/** Deterministic sample for DEMO_MODE — labelled as demo data in the UI. */
export function demoHealthSnapshot(accountId: string, accountName: string, days: number): HealthSnapshot {
  const scale = days / 7;
  const period = (spend: number, leads: number, ctr: number, cpm: number, freq: number): PeriodMetrics => ({
    spendCents: Math.round(spend * scale),
    impressions: Math.round(((spend * scale) / cpm) * 1000),
    linkClicks: Math.round((((spend * scale) / cpm) * 1000 * ctr) / 100),
    linkCtr: ctr,
    cpmCents: cpm,
    frequency: freq,
    results: Math.round(leads * scale),
    resultLabel: "Leads",
    costPerResultCents: Math.round(spend / leads),
  });
  const today = new Date().toISOString().slice(0, 10);
  return {
    account: {
      id: accountId,
      name: accountName,
      currency: "USD",
      timezone: "America/New_York",
      statusLabel: "Active",
      statusProblem: false,
      disableReason: null,
      amountSpentCents: 5_210_000,
      spendCapCents: 6_000_000,
    },
    window: healthWindow(today, days),
    current: period(129_500, 31, 0.84, 1_180, 2.4),
    previous: period(121_000, 41, 1.07, 1_010, 2.1),
    dailyAllottedCents: 21_000,
    activeCampaigns: 3,
    campaigns: [
      {
        id: "demo_campaign_1",
        name: "Implants — Lead Gen",
        delivering: true,
        dailyBudgetCents: 9_000,
        startTime: "2026-07-02T09:00:00+0000",
        current: period(61_000, 21, 0.95, 1_120, 2.2),
        previous: period(57_000, 24, 1.1, 1_000, 2.0),
      },
      {
        id: "demo_campaign_2",
        name: "Veneers — Advantage+",
        delivering: true,
        dailyBudgetCents: 7_000,
        startTime: "2026-08-03T09:00:00+0000",
        current: { ...period(46_000, 1, 0.71, 1_240, 4.3), results: 0, costPerResultCents: null },
        previous: period(41_000, 11, 0.98, 1_050, 3.1),
      },
      {
        id: "demo_campaign_3",
        name: "Brand — Retargeting",
        delivering: true,
        dailyBudgetCents: 5_000,
        startTime: "2026-09-04T09:00:00+0000",
        current: period(22_500, 10, 0.9, 1_210, 2.9),
        previous: period(23_000, 6, 1.02, 980, 2.6),
      },
    ],
    adIssues: [
      {
        id: "demo_ad_9",
        name: "Veneers — Before/After v3",
        status: "DISAPPROVED",
        campaignId: "demo_campaign_2",
        campaignName: "Veneers — Advantage+",
        reason: "Personal health: before-and-after images are not allowed.",
      },
    ],
    warnings: [],
    fetchedAt: new Date().toISOString(),
    demo: true,
  };
}
