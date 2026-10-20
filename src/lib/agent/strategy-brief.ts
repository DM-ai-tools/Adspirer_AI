import type { AgentHistoryMessage } from "@/lib/agent/history";
import type { ResolvedGoals } from "@/lib/clients/goals";
import type { StrategyBrief } from "@/lib/strategy/plan";

/** Only the strategy clarifying question says this; history routing keys on it. */
export const STRATEGY_BRIEF_MARKER = "strategy brief";

type BriefField = "budget" | "target_roas";
type UsedDefault = BriefField | "period";

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
/** "$1,200/day", "1200 per day", "$30k a day", "$36k/month", "$500 daily". */
const BUDGET_RE = new RegExp(
  String.raw`\$?\s*${NUM}\s*(k)?\s*(?:(?:\/|per\s+|a\s+|each\s+|every\s+)\s*(day|month|mo)\b|(daily|monthly)\b)`,
  "i",
);
/** "10x", "12 ×". */
const MULTIPLE_RE = new RegExp(String.raw`(?<![\w.])${NUM}\s*[x×](?![a-z0-9])`, "gi");
/**
 * "roas of 8", "roas at 8", "roas target 8", "roas: 8", "roas of 400%". The
 * connector is required: in "10x roas 500 per day" the 500 is a budget.
 */
const ROAS_OF_RE = new RegExp(String.raw`\broas\s*(?:(?:of|at|target)\b|[=:])\s*${NUM}(\s*%)?`, "gi");
/** The goals schema's cap; anything higher is a typo or a budget, not a target. */
const MAX_ROAS = 100;
const PERIOD = String.raw`(?:over|across|within|for)\s+(?:the\s+next\s+)?(\d+)\s*(day|week|month)s?\b`;
/** "over 2 weeks", "this month": the period a total budget covers. */
const PERIOD_RE = new RegExp(String.raw`\b(?:${PERIOD}|(this\s+month\b))`, "i");
const PERIOD_FRAG = String.raw`(?:(?:over|across|within|for)\s+(?:the\s+next\s+)?\d+\s*(?:day|week|month)s?\s+|this\s+month\s+)?`;
/**
 * "$4k to get $40k back", "spend $4k and get $40k back", "spend $4k to make $40k",
 * "$4k over 2 weeks to get $40k": a total A and the money B it should bring in.
 */
const A_TO_B_RE = new RegExp(
  String.raw`\$\s*${NUM}\s*(k)?\s+${PERIOD_FRAG}(?:and|to)\s+(?:get|make|generate|bring\s+in|return)\s+(?:me\s+)?\$\s*${NUM}\s*(k)?`,
  "i",
);
/** "$4k for $40k in sales". */
const A_FOR_B_RE = new RegExp(
  String.raw`\$\s*${NUM}\s*(k)?\s+${PERIOD_FRAG}for\s+\$\s*${NUM}\s*(k)?\s+in\s+(?:sales|revenue)\b`,
  "i",
);
/** "$4k over 2 weeks", "$6k this month": a total with its period. */
const TOTAL_PERIOD_RE = new RegExp(String.raw`\$\s*${NUM}\s*(k)?\s+(?:${PERIOD}|this\s+month\b)`, "i");
const DEFAULT_PERIOD_DAYS = 30;

const DAYS_PER_MONTH = 30.4;

function toNumber(raw: string, k: string | undefined): number {
  return Number(raw.replace(/,/g, "")) * (k ? 1000 : 1);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseBudgetCents(text: string): number | null {
  const m = BUDGET_RE.exec(text);
  if (!m) return null;
  const cents = toNumber(m[1], m[2]) * 100;
  const monthly = /^(month|mo|monthly)$/i.test(m[3] ?? m[4] ?? "");
  const daily = Math.round(monthly ? cents / DAYS_PER_MONTH : cents);
  return daily > 0 ? daily : null;
}

/** Every "Nx" / "roas of N" value in the order it appears; "400%" is 4×, and values over the cap are dropped. */
function parseRoasValues(text: string): number[] {
  const found: Array<{ at: number; value: number }> = [];
  for (const re of [MULTIPLE_RE, ROAS_OF_RE]) {
    for (const m of text.matchAll(re)) {
      const raw = Number(m[1].replace(/,/g, ""));
      const value = m[2] ? raw / 100 : raw;
      if (value > 0 && value <= MAX_ROAS) found.push({ at: m.index ?? 0, value: round2(value) });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.value);
}

/** A period right after a total or its "to get $B (back)" clause; "in the last 90 days" never counts. */
const PERIOD_AFTER_RE = new RegExp(String.raw`^\s*(?:back\b)?\s*(?:${PERIOD}|this\s+month\b)`, "i");

/** "over 2 weeks" is 14, "over 3 months" is 90, "this month" is 30. */
function periodDaysFrom(m: RegExpExecArray | null): number | null {
  if (!m) return null;
  if (m[3]) return DEFAULT_PERIOD_DAYS;
  const days = Number(m[1]) * (/^day/i.test(m[2]) ? 1 : /^week/i.test(m[2]) ? 7 : DEFAULT_PERIOD_DAYS);
  return days > 0 ? days : null;
}

/** The total budget in cents and its stated period, from a money-back form or "$A over N days / this month". */
function parseTotal(text: string): { cents: number; periodDays: number | null } | null {
  const m = A_TO_B_RE.exec(text) ?? A_FOR_B_RE.exec(text) ?? TOTAL_PERIOD_RE.exec(text);
  if (!m) return null;
  const cents = Math.round(toNumber(m[1], m[2]) * 100);
  if (cents <= 0) return null;
  const end = m.index + m[0].length;
  const periodDays = periodDaysFrom(PERIOD_RE.exec(m[0])) ?? periodDaysFrom(PERIOD_AFTER_RE.exec(text.slice(end)));
  return { cents, periodDays };
}

function impliedRoas(text: string): number | null {
  const m = A_TO_B_RE.exec(text) ?? A_FOR_B_RE.exec(text);
  if (!m) return null;
  const a = toNumber(m[1], m[2]);
  const b = toNumber(m[3], m[4]);
  return a > 0 && b > 0 && b / a <= MAX_ROAS ? round2(b / a) : null;
}

type BriefDefaults = { goals: ResolvedGoals; currentDailySpendCents: number | null };
type BriefResult = { brief: StrategyBrief | null; missing: BriefField[]; usedDefaults: UsedDefault[] };
/** Values the operator actually wrote, before any default fills a gap. */
type StatedBrief = {
  dailyBudgetCents: number | null;
  totalBudgetCents: number | null;
  periodDays: number | null;
  targetRoas: number | null;
  stretch: number[];
  /** The ask names Google ("using Google Ads and Meta together"). */
  wantsGoogle: boolean;
};

function statedBrief(text: string): StatedBrief {
  const total = parseTotal(text);
  // An explicit "Nx" wins over the "$A to get $B back" form.
  const values = parseRoasValues(text);
  return {
    dailyBudgetCents: parseBudgetCents(text),
    totalBudgetCents: total?.cents ?? null,
    periodDays: total?.periodDays ?? null,
    targetRoas: values.length ? values[0] : impliedRoas(text),
    stretch: values.slice(1),
    wantsGoogle: /\bgoogle\b/i.test(text),
  };
}

/** Fills gaps from the client's goals / current spend and reports what is still missing. */
function completeBrief(stated: StatedBrief, defaults: BriefDefaults): BriefResult {
  const usedDefaults: UsedDefault[] = [];
  const missing: BriefField[] = [];

  const total = stated.totalBudgetCents;
  const periodDays = total != null ? (stated.periodDays ?? DEFAULT_PERIOD_DAYS) : null;
  if (total != null && stated.periodDays == null) usedDefaults.push("period");

  // An explicit daily budget wins; otherwise a total spreads evenly over its period.
  let dailyBudgetCents = stated.dailyBudgetCents;
  if (dailyBudgetCents == null && total != null && periodDays != null) {
    dailyBudgetCents = Math.round(total / periodDays);
  }
  if (dailyBudgetCents == null) {
    const fallback = defaults.goals.daily_account_cap_cents ?? defaults.currentDailySpendCents;
    if (fallback != null && fallback > 0) {
      dailyBudgetCents = Math.round(fallback);
      usedDefaults.push("budget");
    } else {
      missing.push("budget");
    }
  }

  let targetRoas = stated.targetRoas;
  if (targetRoas == null) {
    const fallback = defaults.goals.target_roas;
    if (fallback != null && fallback > 0) {
      targetRoas = fallback;
      usedDefaults.push("target_roas");
    } else {
      missing.push("target_roas");
    }
  }

  if (missing.length || dailyBudgetCents == null || targetRoas == null) {
    return { brief: null, missing, usedDefaults };
  }
  const target = targetRoas;
  const stretchTargets = [...new Set(stated.stretch)].filter((v) => v !== target).sort((a, b) => a - b);
  const brief: StrategyBrief = { dailyBudgetCents, targetRoas: target, stretchTargets };
  if (stated.wantsGoogle) brief.wantsGoogle = true;
  if (total != null) {
    brief.totalBudgetCents = total;
    brief.periodDays = periodDays;
  }
  return { brief, missing, usedDefaults };
}

export function parseStrategyBrief(text: string, defaults: BriefDefaults): BriefResult {
  return completeBrief(statedBrief(text), defaults);
}

export function buildStrategyClarifyingQuestion(missing: BriefField[]): string {
  const asks: string[] = [];
  if (missing.includes("budget")) {
    asks.push("**Daily budget** — how much do you want to spend per day, e.g. `$1,200/day` or `$36k/month`?");
  }
  if (missing.includes("target_roas")) {
    asks.push(
      "**Target ROAS** — what return are you aiming for, e.g. `10x`? You can add stretch targets too, like `stretch 12x and 15x`.",
    );
  }
  return [
    `I can build a **strategy** that shows how to reach your return goal — I just need ${asks.length > 1 ? "two details" : "one detail"} to finish your strategy brief:`,
    "",
    ...asks.map((a, i) => `${i + 1}. ${a}`),
    "",
    "Reply with the missing piece(s) and I’ll build the plan. It’s a recommendation only — I won’t change any campaigns.",
  ].join("\n");
}

/**
 * The brief for this turn. When it answers the brief question, the reply and
 * the operator's earlier ask are read separately: the reply's budget and target
 * win, the earlier ask fills only what the reply leaves out, and stretch
 * targets come from both.
 */
export function resolveStrategyBrief(
  request: string,
  history: AgentHistoryMessage[] = [],
  defaults: BriefDefaults,
): BriefResult {
  const at = history.findLastIndex((m) => m.role === "assistant");
  const answersQuestion = at >= 0 && history[at].content.toLowerCase().includes(STRATEGY_BRIEF_MARKER);
  const earlier = answersQuestion ? history.slice(0, at).findLast((m) => m.role === "user") : undefined;
  if (!earlier) return parseStrategyBrief(request, defaults);
  const now = statedBrief(request);
  const before = statedBrief(earlier.content);
  return completeBrief(
    {
      // A total in the reply sets the daily figure itself, so an earlier daily budget doesn't override it.
      dailyBudgetCents: now.dailyBudgetCents ?? (now.totalBudgetCents != null ? null : before.dailyBudgetCents),
      totalBudgetCents: now.totalBudgetCents ?? before.totalBudgetCents,
      periodDays: now.periodDays ?? before.periodDays,
      targetRoas: now.targetRoas ?? before.targetRoas,
      stretch: [...before.stretch, ...now.stretch],
      wantsGoogle: now.wantsGoogle || before.wantsGoogle,
    },
    defaults,
  );
}

/** The texts that make up the strategy ask: the request, plus the earlier ask when it answers the brief question. */
export function strategyAskTexts(request: string, history: AgentHistoryMessage[] = []): string[] {
  const at = history.findLastIndex((m) => m.role === "assistant");
  const answersQuestion = at >= 0 && history[at].content.toLowerCase().includes(STRATEGY_BRIEF_MARKER);
  const earlier = answersQuestion ? history.slice(0, at).findLast((m) => m.role === "user") : undefined;
  return earlier ? [request, earlier.content] : [request];
}

/** A short reply with a money amount and/or an Nx / ROAS value. */
export function looksLikeStrategyBriefReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  if (parseRoasValues(t).length > 0) return true;
  if (parseBudgetCents(t) != null) return true;
  return /\$\s*\d/.test(t);
}
