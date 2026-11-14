import { parseDateRangeFromText } from "@/lib/agent/audit-brief";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { parseLeadGoal } from "@/lib/agent/lead-brief";
import { parseBudgetCents, parseRoasValues, parseTotal } from "@/lib/agent/strategy-brief";
import type { GoalKind, StatedTarget, TargetOption } from "@/lib/strategy/account-strategy";

/**
 * What the operator asked of an account strategy: a target (ROAS, a cost per result, a number of
 * results) and the time to reach it, or a pick from the targets the assistant proposed.
 */

/** Only the proposal's own closing line says this; the next turn keys on it. */
export const STRATEGY_TARGET_MARKER = "pick a target for the strategy";

/** The fixed closing line under a target proposal (added by code, so the marker is always there). */
export function strategyTargetClosing(kind: GoalKind, hasOptions: boolean): string {
  const example = kind === "sales" ? "`4x ROAS in 60 days` or `$40 per purchase in 45 days`" : kind === "leads" ? "`$40 per lead in 45 days` or `120 leads a month`" : "`$2 per result in 30 days`";
  const how = hasOptions
    ? `reply **safe**, **recommended** or **bold** to ${STRATEGY_TARGET_MARKER}, or give your own (for example ${example})`
    : `give your own target and timeframe to ${STRATEGY_TARGET_MARKER} (for example ${example})`;
  return ["---", `**Next:** ${how}. I'll then write the full plan. Nothing in Meta will be changed.`].join("\n");
}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const RESULT_WORDS = String.raw`(?:lead|purchase|sale|order|acquisition|result|conversion|booking|enquiry|inquiry|appointment|registration|sign-?up)`;
/** "cpa of $40", "cost per purchase under 35", "CPL: 20", "cost per result $12". */
const COST_PER_RE = new RegExp(
  String.raw`\b(?:cpa|cpl|cpp|cost\s+per\s+${RESULT_WORDS})\b(?:\s+(?:of|at|to|target|under|below|around|is|down\s+to|by))*\s*[:=<]?\s*\$?\s*${NUM}\s*(k)?`,
  "i",
);
/** "$40 per lead", "under $30 a sale". */
const PER_RESULT_RE = new RegExp(String.raw`\$\s*${NUM}\s*(k)?\s*(?:per|a|each|\/)\s*${RESULT_WORDS}\b`, "i");
/** "50 sales", "200 purchases", "30 orders". Leads use parseLeadGoal. */
const SALES_VOLUME_RE = new RegExp(String.raw`(?<![\w.$])${NUM}\s*(k)?\s+(?:more\s+|new\s+)?(?:sales|purchases|orders|conversions)\b`, "i");
/**
 * The time to reach it: "in 45 days", "within 6 weeks", "over the next 2 months", "by end of the
 * month". "last/past N days" is a data period, never a window.
 */
const WINDOW_RE = /\b(?:in|within|over|across|by|for)\s+(?:the\s+)?(?:next\s+)?(\d+|a|one|two|three|four|six|eight|twelve)\s*(day|week|month)s?\b/i;
const MONTH_END_RE = /\b(?:by\s+(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?month|this\s+month)\b/i;
const WORD_NUMBERS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, six: 6, eight: 8, twelve: 12 };

function toNumber(raw: string, k?: string): number {
  return Number(raw.replace(/,/g, "")) * (k ? 1000 : 1);
}

export function parseWindowDays(text: string, today: Date = new Date()): number | null {
  const m = WINDOW_RE.exec(text);
  if (m && !/\b(?:last|past|previous)\s*$/i.test(text.slice(0, m.index))) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORD_NUMBERS[m[1]!.toLowerCase()] ?? 0;
    const days = n * (/^day/i.test(m[2]!) ? 1 : /^week/i.test(m[2]!) ? 7 : 30);
    if (days > 0 && days <= 365) return days;
  }
  if (MONTH_END_RE.test(text)) {
    const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0);
    const left = Math.round((end - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86_400_000);
    return Math.max(7, left);
  }
  return null;
}

/** The target the text states, if any. ROAS is ignored for a lead or other account: it can't be measured there. */
export function parseStatedTarget(text: string, kind: GoalKind, today?: Date): StatedTarget {
  const out: StatedTarget = {};
  if (kind === "sales") {
    const roas = parseRoasValues(text)[0];
    if (roas != null) out.roas = roas;
  }
  // Only "per lead / per sale"-style wording counts, so "$300/day" (a budget) never reads as a cost.
  const cost = COST_PER_RE.exec(text) ?? PER_RESULT_RE.exec(text);
  if (cost) {
    const cents = Math.round(toNumber(cost[1]!, cost[2]) * 100);
    if (cents > 0) out.costPerCents = cents;
  }
  const lead = kind !== "sales" ? parseLeadGoal(text) : null;
  const sales = kind === "sales" ? SALES_VOLUME_RE.exec(text) : null;
  if (lead) {
    out.volume = lead.leads;
    if (lead.periodDays) out.windowDays = lead.periodDays;
  } else if (sales) {
    const n = Math.round(toNumber(sales[1]!, sales[2]));
    if (n > 0) out.volume = n;
  }
  const window = parseWindowDays(text, today);
  if (window != null) out.windowDays = window;
  return out;
}

export function hasTarget(t: StatedTarget): boolean {
  return t.roas != null || t.costPerCents != null || t.volume != null;
}

/** "safe" / "recommended" / "bold" (and the usual ways of saying them) from a reply to the proposal. */
export function pickedOption(text: string): TargetOption["key"] | null {
  const t = text.trim().toLowerCase();
  if (!t || t.length > 300) return null;
  if (/\b(bold|stretch|aggressive|ambitious|option\s*3|third|c\))|^\s*(3|c)\s*\.?\s*$/.test(t)) return "bold";
  if (/\b(safe|conservative|cautious|option\s*1|first|a\))|^\s*(1|a)\s*\.?\s*$/.test(t)) return "safe";
  if (/\b(recommend\w*|realistic|middle|option\s*2|second|b\)|your\s+(pick|call|suggestion)|go\s+(ahead|with\s+(it|that|yours))|sounds\s+good|yes|yep|ok(ay)?|sure|do\s+it|proceed)\b|^\s*(2|b)\s*\.?\s*$/.test(t)) {
    return "recommended";
  }
  return null;
}

/** True when the assistant's last message was a target proposal (it carries the marker). */
export function answersTargetProposal(history: AgentHistoryMessage[]): boolean {
  const last = history.findLast((m) => m.role === "assistant");
  return Boolean(last && last.content.toLowerCase().includes(STRATEGY_TARGET_MARKER));
}

/**
 * The target for this turn: the request's own; else, when it answers a proposal, the operator's
 * pick (or their own target in the reply, filled out by the earlier ask's window); else nothing.
 */
export function resolveStrategyTarget(
  request: string,
  history: AgentHistoryMessage[],
  kind: GoalKind,
  today?: Date,
): { stated: StatedTarget; pick: TargetOption["key"] | null; answering: boolean } {
  const stated = parseStatedTarget(request, kind, today);
  const answering = answersTargetProposal(history);
  if (hasTarget(stated)) {
    if (stated.windowDays == null && answering) {
      // "45 days" may have been said in the original ask.
      const at = history.findLastIndex((m) => m.role === "assistant");
      const ask = history.slice(0, at).findLast((m) => m.role === "user");
      const window = ask ? parseWindowDays(ask.content, today) : null;
      if (window != null) stated.windowDays = window;
    }
    return { stated, pick: null, answering };
  }
  if (!answering) {
    // A window alone ("strategy for the next 60 days") is kept for the proposal.
    return { stated, pick: null, answering };
  }
  return { stated, pick: pickedOption(request), answering };
}

/**
 * The period to read: the period of the latest audit in the chat ("based on this audit"), else a
 * "last N days / weeks / months" in the ask, else the last 30 days. A window to reach a target
 * ("in 45 days") is never read as a data period.
 */
export function strategyPeriod(
  request: string,
  history: AgentHistoryMessage[],
): { dateStart: string; dateStop: string; source: string } {
  const audit = history.findLast((m) => m.role === "assistant" && /^#\s*Meta Ads Account Audit\b/m.test(m.content));
  const periodLine = audit?.content.match(/\*\*Period:?\*\*:?\s*([^\n·]+)/)?.[1];
  const fromAudit = periodLine ? parseDateRangeFromText(periodLine) : null;
  if (fromAudit) return { dateStart: fromAudit.dateStart, dateStop: fromAudit.dateStop, source: "the period of the audit in this chat" };
  if (/\b(?:last|past|previous)\s+(?:\d+\s+)?(?:days?|weeks?|months?|year)\b/i.test(request)) {
    const asked = parseDateRangeFromText(request);
    if (asked) return { dateStart: asked.dateStart, dateStop: asked.dateStop, source: "the period in the operator's ask" };
  }
  const last30 = parseDateRangeFromText("last 30 days")!;
  return { dateStart: last30.dateStart, dateStop: last30.dateStop, source: "the last 30 days (no period was given)" };
}

/**
 * True when the ask is the budget plan: a stated money budget to divide (by category for sales,
 * across campaigns for leads), or — for leads — a lead count with a budget question ("100 leads a
 * month, what budget do I need?"), which the lead plan sizes in cases. Everything else gets the
 * account strategy. An "other" account never gets the budget plan: it plans on ROAS or leads,
 * which that account can't measure.
 */
export function wantsBudgetPlan(texts: string[], kind: GoalKind): boolean {
  if (kind === "other") return false;
  const text = texts.join("\n");
  if (parseBudgetCents(text) != null || parseTotal(text) != null) return true;
  return kind === "leads" && parseLeadGoal(text) != null && /\b(?:budget|how\s+much|spend)\b/i.test(text);
}
