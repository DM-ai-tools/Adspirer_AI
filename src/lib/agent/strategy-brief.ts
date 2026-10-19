import type { AgentHistoryMessage } from "@/lib/agent/history";
import type { ResolvedGoals } from "@/lib/clients/goals";
import type { StrategyBrief } from "@/lib/strategy/plan";

/** Only the strategy clarifying question says this; history routing keys on it. */
export const STRATEGY_BRIEF_MARKER = "strategy brief";

type BriefField = "budget" | "target_roas";

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
/** "$4k to get $40k back". */
const A_TO_B_RE = new RegExp(
  String.raw`\$\s*${NUM}\s*(k)?\s+to\s+(?:get|make|generate|bring\s+in|return)\s+(?:me\s+)?\$\s*${NUM}\s*(k)?\s*back`,
  "i",
);

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

function impliedRoas(text: string): number | null {
  const m = A_TO_B_RE.exec(text);
  if (!m) return null;
  const a = toNumber(m[1], m[2]);
  const b = toNumber(m[3], m[4]);
  return a > 0 && b > 0 && b / a <= MAX_ROAS ? round2(b / a) : null;
}

type BriefDefaults = { goals: ResolvedGoals; currentDailySpendCents: number | null };
type BriefResult = { brief: StrategyBrief | null; missing: BriefField[]; usedDefaults: BriefField[] };
/** Values the operator actually wrote, before any default fills a gap. */
type StatedBrief = { dailyBudgetCents: number | null; targetRoas: number | null; stretch: number[] };

function statedBrief(text: string): StatedBrief {
  // An explicit "Nx" wins over the "$A to get $B back" form.
  const values = parseRoasValues(text);
  return {
    dailyBudgetCents: parseBudgetCents(text),
    targetRoas: values.length ? values[0] : impliedRoas(text),
    stretch: values.slice(1),
  };
}

/** Fills gaps from the client's goals / current spend and reports what is still missing. */
function completeBrief(stated: StatedBrief, defaults: BriefDefaults): BriefResult {
  const usedDefaults: BriefField[] = [];
  const missing: BriefField[] = [];

  let dailyBudgetCents = stated.dailyBudgetCents;
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
  return { brief: { dailyBudgetCents, targetRoas: target, stretchTargets }, missing, usedDefaults };
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
      dailyBudgetCents: now.dailyBudgetCents ?? before.dailyBudgetCents,
      targetRoas: now.targetRoas ?? before.targetRoas,
      stretch: [...before.stretch, ...now.stretch],
    },
    defaults,
  );
}

/** A short reply with a money amount and/or an Nx / ROAS value. */
export function looksLikeStrategyBriefReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  if (parseRoasValues(t).length > 0) return true;
  if (parseBudgetCents(t) != null) return true;
  return /\$\s*\d/.test(t);
}
