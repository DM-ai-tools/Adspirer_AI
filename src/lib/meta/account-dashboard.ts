import type { MetaGraphClient } from "@/lib/meta/graph-client";
import { metaMinorToCents } from "@/lib/meta/currency";

/**
 * Ad-account summary for the Overview dashboard: lifetime billing figures,
 * how much budget is allotted right now, and performance for a date range.
 *
 * Money is in app cents (major units × 100) like the rest of the app; Meta's
 * per-currency minor units are converted at the boundary.
 */

export const DASHBOARD_RANGES = ["today", "7d", "30d", "month"] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];

/** Meta date presets resolve in the ad account's own timezone. */
const RANGE_PRESET: Record<DashboardRange, string> = {
  today: "today",
  "7d": "last_7d",
  "30d": "last_30d",
  month: "this_month",
};

export type AccountDashboard = {
  account: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    status: number;
    statusLabel: string;
    /** True when Meta is not delivering ads for account-level reasons. */
    statusProblem: boolean;
    disableReason: string | null;
    /**
     * All-time spend from insights (date_preset=maximum) — the figure Ads
     * Manager shows. Falls back to amountSpentCents if insights fail.
     */
    lifetimeSpendCents: number;
    /**
     * Meta's billing counter measured against the spending limit. It updates
     * in batches, so it trails real-time spend by up to a day's spend.
     */
    amountSpentCents: number;
    /** null = no account spending limit. */
    spendCapCents: number | null;
    /** Meta's `balance`: unpaid spend (post-paid) or remaining funds (prepaid). */
    balanceCents: number;
    /** e.g. "VISA *7982". */
    paymentMethod: string | null;
    isPrepay: boolean;
  };
  range: {
    key: DashboardRange;
    since: string | null;
    until: string | null;
    days: number;
  };
  totals: {
    spendCents: number;
    impressions: number;
    reach: number;
    frequency: number;
    /** All clicks (likes, profile taps, expands…), Ads Manager "Clicks (all)". */
    clicks: number;
    linkClicks: number;
    /** CTR (all), percent. */
    ctr: number;
    /** Link click-through rate, percent — Ads Manager "CTR (link click-through rate)". */
    linkCtr: number;
    /** CPC (all). */
    cpcCents: number | null;
    /** Cost per link click — Ads Manager "CPC (cost per link click)". */
    costPerLinkClickCents: number | null;
    cpmCents: number | null;
    /**
     * Meta's "Results" (each campaign's optimisation goal) summed across
     * campaigns. null when campaigns optimise for different goals — Ads
     * Manager shows no account total in that case either.
     */
    results: number | null;
    resultLabel: string;
    costPerResultCents: number | null;
    purchaseValueCents: number;
    roas: number | null;
  };
  budget: {
    /** Sum of daily budgets on delivering campaigns (CBO) and ad sets (ABO). */
    dailyAllottedCents: number;
    /** Remaining amount on lifetime budgets that are still delivering. */
    lifetimeRemainingCents: number;
    activeCampaigns: number;
    activeAdSets: number;
    /** dailyAllotted × days in range — what full delivery would have spent. */
    expectedSpendCents: number;
    /** spend ÷ expected; null when nothing is budgeted. */
    pacing: number | null;
  };
  daily: Array<{ date: string; spendCents: number }>;
  /** Top campaigns by spend in the range (delivering or not). */
  campaigns: CampaignRow[];
  /** Every campaign currently delivering, with its range performance. */
  activeCampaigns: CampaignRow[];
  /** Parts that failed to load; the rest of the dashboard still renders. */
  warnings: string[];
  fetchedAt: string;
};

export type CampaignRow = {
  id: string;
  name: string;
  status: string;
  objective: string | null;
  /** Campaign budget (CBO), or the sum of its delivering ad sets' budgets. */
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  /** True when the budget above is the ad sets' total, not a campaign budget. */
  budgetAtAdSetLevel: boolean;
  startTime: string | null;
  spendCents: number;
  /** Meta's Results for the campaign's goal; null when none/mixed. */
  results: number | null;
  resultLabel: string;
  costPerResultCents: number | null;
  roas: number | null;
  /** Link CTR, percent. */
  linkCtr: number;
};

type ActionRow = { action_type?: string; value?: string };
type Row = Record<string, unknown>;

const ACCOUNT_STATUS: Record<number, { label: string; problem: boolean }> = {
  1: { label: "Active", problem: false },
  2: { label: "Disabled", problem: true },
  3: { label: "Unsettled payment", problem: true },
  7: { label: "Pending risk review", problem: true },
  8: { label: "Pending settlement", problem: true },
  9: { label: "In grace period", problem: true },
  100: { label: "Pending closure", problem: true },
  101: { label: "Closed", problem: true },
  201: { label: "Any active", problem: false },
  202: { label: "Any closed", problem: true },
};

const DISABLE_REASON: Record<number, string> = {
  1: "Ads integrity policy",
  2: "Ads IP review",
  3: "Risk payment",
  4: "Gray account shut down",
  5: "Ads AFC review",
  6: "Business integrity",
  7: "Permanent close",
  8: "Unused reseller account",
  9: "Unused account",
};

type MetaResultRow = {
  indicator?: string;
  values?: Array<{ value?: string }>;
};

const RESULT_LABELS: Array<{ match: RegExp; label: string }> = [
  { match: /(^|\.)(omni_)?purchase$|fb_pixel_purchase$/, label: "Purchases" },
  { match: /(^|\.)lead$|lead_grouped$|fb_pixel_lead$/, label: "Leads" },
  { match: /complete_registration$/, label: "Registrations" },
  { match: /messaging_conversation_started/, label: "Conversations" },
  { match: /(^|\.)landing_page_view$/, label: "Landing page views" },
  { match: /(^|\.)link_click$/, label: "Link clicks" },
  { match: /thruplay/, label: "ThruPlays" },
  { match: /(^|\.)post_engagement$/, label: "Post engagements" },
  { match: /^reach$/, label: "Reach" },
  { match: /^impressions$/, label: "Impressions" },
  { match: /offsite_conversion\.custom\.\d+/, label: "Custom conversions" },
];

/** "actions:offsite_conversion.fb_pixel_custom.Ecomm_Lead" → "Ecomm Lead". */
export function resultLabelFor(indicator: string): string {
  const type = indicator.replace(/^(actions|conversions):/, "");
  for (const { match, label } of RESULT_LABELS) {
    if (match.test(type)) return label;
  }
  const custom = type.match(/fb_pixel_custom\.(.+)$/);
  if (custom) return custom[1].replace(/[_-]+/g, " ");
  const tail = type.split(".").pop() ?? type;
  const words = tail.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Meta's own Results / Cost per result for a campaign row — the same numbers
 * Ads Manager shows, based on each campaign's optimisation goal.
 */
function metaResult(row: Row): {
  indicator: string | null;
  count: number | null;
  costCents: number | null;
} {
  const results = Array.isArray(row.results) ? (row.results as MetaResultRow[]) : [];
  const indicator = results[0]?.indicator ?? null;
  if (!indicator || indicator === "mixed") {
    return { indicator, count: null, costCents: null };
  }
  const count = num(results[0]?.values?.[0]?.value);
  const costs = Array.isArray(row.cost_per_result)
    ? (row.cost_per_result as MetaResultRow[])
    : [];
  const cost = costs[0]?.values?.[0]?.value;
  return {
    indicator,
    count,
    costCents: count > 0 && cost != null ? majorToCents(cost) : null,
  };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function majorToCents(value: unknown): number {
  return Math.round(num(value) * 100);
}

function actionValue(rows: ActionRow[], type: string | null): number {
  if (!type) return 0;
  return num(rows.find((r) => r.action_type === type)?.value);
}

function roasFrom(row: Row, spend: number): number | null {
  const roasRows = Array.isArray(row.purchase_roas) ? (row.purchase_roas as ActionRow[]) : [];
  const direct = roasRows.find((r) => /purchase/.test(String(r.action_type ?? "")));
  if (direct?.value != null) return num(direct.value);
  const values = Array.isArray(row.action_values) ? (row.action_values as ActionRow[]) : [];
  const purchaseValue = num(
    values.find((r) => /^(omni_purchase|purchase|offsite_conversion\.fb_pixel_purchase)$/.test(String(r.action_type ?? "")))?.value,
  );
  return purchaseValue > 0 && spend > 0 ? purchaseValue / spend : null;
}

function daysBetween(since: string | null, until: string | null): number {
  if (!since || !until) return 1;
  const ms = Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(1, Math.round(ms / 86_400_000) + 1) : 1;
}

async function settle<T>(
  label: string,
  warnings: string[],
  promise: Promise<T>,
): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function buildAccountDashboard(
  graph: MetaGraphClient,
  accountId: string,
  range: DashboardRange,
): Promise<AccountDashboard> {
  const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  const preset = RANGE_PRESET[range];
  const warnings: string[] = [];
  const delivering = JSON.stringify(["ACTIVE"]);

  // The account row is required; everything else degrades to a warning.
  const accountPromise = graph.get<Row>(id, {
    fields:
      "name,currency,timezone_name,account_status,disable_reason,amount_spent,spend_cap,balance,is_prepay_account,funding_source_details",
  });

  const [
    account,
    totalsRes,
    dailyRes,
    campaignInsightsRes,
    campaignsRes,
    adSetsRes,
    lifetimeRes,
  ] = await Promise.all([
      accountPromise,
      settle(
        "Performance totals",
        warnings,
        graph.get<{ data?: Row[] }>(`${id}/insights`, {
          level: "account",
          date_preset: preset,
          fields:
            "spend,impressions,reach,frequency,clicks,inline_link_clicks,ctr,inline_link_click_ctr,cpc,cost_per_inline_link_click,cpm,actions,action_values,purchase_roas",
        }),
      ),
      settle(
        "Daily spend",
        warnings,
        graph.get<{ data?: Row[] }>(`${id}/insights`, {
          level: "account",
          date_preset: preset,
          time_increment: 1,
          fields: "spend",
          limit: 100,
        }),
      ),
      settle(
        "Campaign performance",
        warnings,
        graph.get<{ data?: Row[] }>(`${id}/insights`, {
          level: "campaign",
          date_preset: preset,
          fields:
            "campaign_id,campaign_name,spend,inline_link_click_ctr,action_values,purchase_roas,results,cost_per_result",
          sort: "spend_descending",
          limit: 100,
        }),
      ),
      settle(
        "Campaign budgets",
        warnings,
        graph.get<{ data?: Row[] }>(`${id}/campaigns`, {
          fields:
            "id,name,objective,effective_status,daily_budget,lifetime_budget,budget_remaining,start_time",
          effective_status: delivering,
          limit: 200,
        }),
      ),
      settle(
        "Ad set budgets",
        warnings,
        graph.get<{ data?: Row[] }>(`${id}/adsets`, {
          fields: "id,campaign_id,daily_budget,lifetime_budget,budget_remaining",
          effective_status: delivering,
          limit: 500,
        }),
      ),
      settle(
        "Lifetime spend",
        warnings,
        graph.get<{ data?: Row[] }>(`${id}/insights`, {
          level: "account",
          date_preset: "maximum",
          fields: "spend",
        }),
      ),
    ]);

  const currency = String(account.currency ?? "USD");
  const toCents = (minor: unknown) => metaMinorToCents(num(minor), currency);

  // ---- Totals ---------------------------------------------------------------
  const t = totalsRes?.data?.[0] ?? {};
  const actions = Array.isArray(t.actions) ? (t.actions as ActionRow[]) : [];
  const actionValues = Array.isArray(t.action_values) ? (t.action_values as ActionRow[]) : [];
  const spend = num(t.spend);
  const purchaseValue = actionValue(
    actionValues,
    actions.find((a) => /^(omni_purchase|purchase|offsite_conversion\.fb_pixel_purchase)$/.test(String(a.action_type ?? "")))?.action_type ?? null,
  );
  const since = typeof t.date_start === "string" ? t.date_start : null;
  const until = typeof t.date_stop === "string" ? t.date_stop : null;

  // ---- Budgets --------------------------------------------------------------
  const campaigns = campaignsRes?.data ?? [];
  const adSets = adSetsRes?.data ?? [];
  let dailyAllotted = 0;
  let lifetimeRemaining = 0;
  for (const c of campaigns) {
    dailyAllotted += toCents(c.daily_budget);
    if (num(c.lifetime_budget) > 0) lifetimeRemaining += toCents(c.budget_remaining);
  }
  for (const a of adSets) {
    // Ad sets under a CBO campaign carry no budget of their own (0 / absent).
    dailyAllotted += toCents(a.daily_budget);
    if (num(a.lifetime_budget) > 0) lifetimeRemaining += toCents(a.budget_remaining);
  }
  const days = daysBetween(since, until);
  const expected = dailyAllotted * days;
  const spendCents = majorToCents(spend);

  // ---- Daily trend ----------------------------------------------------------
  const daily = (dailyRes?.data ?? [])
    .map((row) => ({
      date: String(row.date_start ?? ""),
      spendCents: majorToCents(row.spend),
    }))
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  // ---- Campaign tables ------------------------------------------------------
  const activeById = new Map(campaigns.map((c) => [String(c.id), c]));
  const insightsById = new Map(
    (campaignInsightsRes?.data ?? []).map((row) => [String(row.campaign_id ?? ""), row]),
  );
  // ABO campaigns have no budget of their own — total their ad sets instead.
  const adSetBudgets = new Map<string, { daily: number; lifetime: number }>();
  for (const a of adSets) {
    const key = String(a.campaign_id ?? "");
    const sum = adSetBudgets.get(key) ?? { daily: 0, lifetime: 0 };
    sum.daily += toCents(a.daily_budget);
    sum.lifetime += toCents(a.lifetime_budget);
    adSetBudgets.set(key, sum);
  }

  const toCampaignRow = (cid: string): CampaignRow => {
    const meta = activeById.get(cid);
    const row = insightsById.get(cid) ?? {};
    const rowResult = metaResult(row);
    const rowSpend = num(row.spend);
    const ownDaily = meta && num(meta.daily_budget) > 0 ? toCents(meta.daily_budget) : null;
    const ownLifetime =
      meta && num(meta.lifetime_budget) > 0 ? toCents(meta.lifetime_budget) : null;
    const fromAdSets = adSetBudgets.get(cid);
    const useAdSets = ownDaily == null && ownLifetime == null && Boolean(fromAdSets);
    return {
      id: cid,
      name: String(row.campaign_name ?? meta?.name ?? cid),
      status: meta ? String(meta.effective_status ?? "ACTIVE") : "NOT_DELIVERING",
      objective: meta?.objective ? String(meta.objective) : null,
      dailyBudgetCents: useAdSets ? fromAdSets!.daily || null : ownDaily,
      lifetimeBudgetCents: useAdSets ? fromAdSets!.lifetime || null : ownLifetime,
      budgetAtAdSetLevel: useAdSets,
      startTime: typeof meta?.start_time === "string" ? meta.start_time : null,
      spendCents: majorToCents(rowSpend),
      results: rowResult.count,
      resultLabel:
        rowResult.indicator === "mixed"
          ? "Mixed goals"
          : rowResult.indicator
            ? resultLabelFor(rowResult.indicator)
            : "Results",
      costPerResultCents: rowResult.costCents,
      roas: roasFrom(row, rowSpend),
      linkCtr: num(row.inline_link_click_ctr),
    };
  };

  // Account total: Meta reports no account-level Results, so sum campaigns —
  // but only when they all share one goal (summing leads with ThruPlays
  // would be meaningless).
  const indicators = new Set<string>();
  let totalResults = 0;
  for (const row of campaignInsightsRes?.data ?? []) {
    if (num(row.spend) <= 0) continue;
    const r = metaResult(row);
    if (!r.indicator) continue;
    indicators.add(r.indicator);
    totalResults += r.count ?? 0;
  }
  const singleGoal = indicators.size === 1 && !indicators.has("mixed");
  const result = singleGoal
    ? { count: totalResults, label: resultLabelFor([...indicators][0]!) }
    : {
        count: null as number | null,
        label: indicators.size > 1 || indicators.has("mixed") ? "Mixed goals" : "Results",
      };

  const campaignRows = (campaignInsightsRes?.data ?? [])
    .filter((row) => num(row.spend) > 0)
    .slice(0, 10)
    .map((row) => toCampaignRow(String(row.campaign_id ?? "")));
  const activeCampaignRows = campaigns
    .map((c) => toCampaignRow(String(c.id)))
    .sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));

  const funding = account.funding_source_details as
    | { display_string?: unknown }
    | undefined;
  const lifetimeRow = lifetimeRes?.data?.[0];

  const statusCode = num(account.account_status);
  const status = ACCOUNT_STATUS[statusCode] ?? { label: `Status ${statusCode}`, problem: true };
  const disableCode = num(account.disable_reason);
  const spendCap = num(account.spend_cap);

  return {
    account: {
      id,
      name: String(account.name ?? id),
      currency,
      timezone: String(account.timezone_name ?? "UTC"),
      status: statusCode,
      statusLabel: status.label,
      statusProblem: status.problem,
      disableReason: disableCode > 0 ? (DISABLE_REASON[disableCode] ?? `Reason ${disableCode}`) : null,
      lifetimeSpendCents: lifetimeRow
        ? majorToCents(lifetimeRow.spend)
        : toCents(account.amount_spent),
      amountSpentCents: toCents(account.amount_spent),
      spendCapCents: spendCap > 0 ? toCents(spendCap) : null,
      balanceCents: toCents(account.balance),
      paymentMethod:
        typeof funding?.display_string === "string" ? funding.display_string : null,
      isPrepay: account.is_prepay_account === true,
    },
    range: { key: range, since, until, days },
    totals: {
      spendCents,
      impressions: num(t.impressions),
      reach: num(t.reach),
      frequency: num(t.frequency),
      clicks: num(t.clicks),
      linkClicks: num(t.inline_link_clicks),
      ctr: num(t.ctr),
      linkCtr: num(t.inline_link_click_ctr),
      cpcCents: t.cpc != null ? majorToCents(t.cpc) : null,
      costPerLinkClickCents:
        t.cost_per_inline_link_click != null
          ? majorToCents(t.cost_per_inline_link_click)
          : null,
      cpmCents: t.cpm != null ? majorToCents(t.cpm) : null,
      results: result.count,
      resultLabel: result.label,
      costPerResultCents:
        result.count != null && result.count > 0
          ? Math.round(spendCents / result.count)
          : null,
      purchaseValueCents: majorToCents(purchaseValue),
      roas: roasFrom(t, spend),
    },
    budget: {
      dailyAllottedCents: dailyAllotted,
      lifetimeRemainingCents: lifetimeRemaining,
      activeCampaigns: campaigns.length,
      activeAdSets: adSets.length,
      expectedSpendCents: expected,
      pacing: expected > 0 ? spendCents / expected : null,
    },
    daily,
    campaigns: campaignRows,
    activeCampaigns: activeCampaignRows,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

/** Deterministic sample for DEMO_MODE — labelled as demo data in the UI. */
export function demoAccountDashboard(
  accountId: string,
  accountName: string,
  range: DashboardRange,
): AccountDashboard {
  const days = range === "today" ? 1 : range === "7d" ? 7 : range === "30d" ? 30 : 18;
  const daily = Array.from({ length: days }, (_, i) => {
    const date = new Date(Date.UTC(2026, 9, 8 - (days - 1 - i)));
    const wave = 0.75 + 0.25 * Math.sin(i / 2.2) + (i % 5 === 0 ? 0.12 : 0);
    return { date: date.toISOString().slice(0, 10), spendCents: Math.round(18_500 * wave) };
  });
  const spendCents = daily.reduce((sum, d) => sum + d.spendCents, 0);
  const dailyAllotted = 21_000;
  const results = Math.round(spendCents / 4_200);
  return {
    account: {
      id: accountId,
      name: accountName,
      currency: "USD",
      timezone: "America/New_York",
      status: 1,
      statusLabel: "Active",
      statusProblem: false,
      disableReason: null,
      lifetimeSpendCents: 4_839_100,
      amountSpentCents: 4_812_300,
      spendCapCents: 6_000_000,
      balanceCents: 128_450,
      paymentMethod: "VISA *4242",
      isPrepay: false,
    },
    range: { key: range, since: daily[0]?.date ?? null, until: daily.at(-1)?.date ?? null, days },
    totals: {
      spendCents,
      impressions: Math.round(spendCents * 1.9),
      reach: Math.round(spendCents * 1.1),
      frequency: 1.73,
      clicks: Math.round(spendCents / 62),
      linkClicks: Math.round(spendCents / 81),
      ctr: 1.62,
      linkCtr: 0.94,
      cpcCents: 81,
      costPerLinkClickCents: 112,
      cpmCents: 1_052,
      results,
      resultLabel: "Leads",
      costPerResultCents: results ? Math.round(spendCents / results) : null,
      purchaseValueCents: 0,
      roas: null,
    },
    budget: {
      dailyAllottedCents: dailyAllotted,
      lifetimeRemainingCents: 240_000,
      activeCampaigns: 3,
      activeAdSets: 7,
      expectedSpendCents: dailyAllotted * days,
      pacing: spendCents / (dailyAllotted * days),
    },
    daily,
    campaigns: demoCampaigns(spendCents),
    activeCampaigns: demoCampaigns(spendCents),
    warnings: [],
    fetchedAt: new Date().toISOString(),
  };
}

function demoCampaigns(spendCents: number): CampaignRow[] {
  return [
    { name: "Implants — Lead Gen", share: 0.46, budget: 9_000, cpr: 3_650, adSets: false },
    { name: "Veneers — Advantage+", share: 0.34, budget: 7_000, cpr: 4_480, adSets: true },
    { name: "Brand — Retargeting", share: 0.2, budget: 5_000, cpr: 5_120, adSets: false },
  ].map((c, i) => {
    const spend = Math.round(spendCents * c.share);
    return {
      id: `demo_campaign_${i + 1}`,
      name: c.name,
      status: "ACTIVE",
      objective: "OUTCOME_LEADS",
      dailyBudgetCents: c.budget,
      lifetimeBudgetCents: null,
      budgetAtAdSetLevel: c.adSets,
      startTime: `2026-0${7 + i}-0${2 + i}T09:00:00+0000`,
      spendCents: spend,
      results: Math.round(spend / c.cpr),
      resultLabel: "Leads",
      costPerResultCents: c.cpr,
      roas: null,
      linkCtr: 0.8 + i * 0.15,
    };
  });
}
