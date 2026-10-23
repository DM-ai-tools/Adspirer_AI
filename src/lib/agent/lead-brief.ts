import type { AgentHistoryMessage } from "@/lib/agent/history";
import {
  STRATEGY_BRIEF_MARKER,
  parseBudgetCents,
  parseRoasValues,
  parseTotal,
} from "@/lib/agent/strategy-brief";
import type { BUSINESS_MODELS } from "@/lib/clients/goals";
import type { LeadBrief } from "@/lib/strategy/lead-plan";

/**
 * The strategy brief for clients who sell leads, bookings or enquiries rather
 * than products. Their goal is a number of leads (and a cost per lead), never a
 * ROAS, and the budget is something the plan works out, not something they must
 * already know.
 */

const LEAD_MODELS: ReadonlyArray<(typeof BUSINESS_MODELS)[number]> = ["lead_gen", "local_service", "b2b"];
const DEFAULT_PERIOD_DAYS = 30;
const MAX_LEADS = 1_000_000;

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const LEAD_WORDS = String.raw`(?:qualified\s+|new\s+|more\s+)?(?:leads?|enquir(?:y|ies)|inquir(?:y|ies)|bookings?|appointments?|registrations?|sign-?ups?|form\s+fills?)`;
/** "100 leads", "1.5k enquiries", "50 qualified leads". */
const LEADS_RE = new RegExp(String.raw`(?<![\w.$])${NUM}\s*(k)?\s+${LEAD_WORDS}\b`, "i");
/** "in a month", "per week", "over 2 weeks", "monthly", "this month" straight after the lead count. */
const PERIOD_AFTER_RE = new RegExp(
  String.raw`^\s*(?:(?:in|over|within|per|a|each|every|for|\/)\s*(?:the\s+next\s+|an?\s+|this\s+)?(?:(\d+)\s*)?(day|week|month)s?\b|(daily|weekly|monthly)\b)`,
  "i",
);
/** "cpl of $25", "cost per lead under 30", "CPA: 40". */
const CPL_RE = new RegExp(
  String.raw`\b(?:cpl|cost\s+per\s+(?:lead|enquiry|inquiry|booking|appointment|acquisition)|cpa)\b(?:\s+(?:of|at|target|under|below|around|is))*\s*[:=<]?\s*\$?\s*${NUM}\s*(k)?`,
  "i",
);
/** "$25 per lead", "under $30 a lead". */
const PER_LEAD_RE = new RegExp(
  String.raw`\$\s*${NUM}\s*(k)?\s*(?:per|a|each|\/)\s*(?:lead|enquiry|inquiry|booking|appointment)\b`,
  "i",
);

function toNumber(raw: string, k: string | undefined): number {
  return Number(raw.replace(/,/g, "")) * (k ? 1000 : 1);
}

type StatedLeadBrief = {
  targetLeads: number | null;
  /** Null when the ask gave no period for the lead goal. */
  periodDays: number | null;
  dailyBudgetCents: number | null;
  targetCplCents: number | null;
};

/** The lead goal in the text: the count and the period stated right after it, if any. */
export function parseLeadGoal(text: string): { leads: number; periodDays: number | null } | null {
  const m = LEADS_RE.exec(text);
  if (!m) return null;
  const leads = toNumber(m[1], m[2]);
  if (!(leads > 0) || leads > MAX_LEADS) return null;
  const after = PERIOD_AFTER_RE.exec(text.slice(m.index + m[0].length));
  let periodDays: number | null = null;
  if (after) {
    if (after[3]) periodDays = /^daily/i.test(after[3]) ? 1 : /^weekly/i.test(after[3]) ? 7 : DEFAULT_PERIOD_DAYS;
    else {
      const unit = /^day/i.test(after[2]) ? 1 : /^week/i.test(after[2]) ? 7 : DEFAULT_PERIOD_DAYS;
      periodDays = (after[1] ? Number(after[1]) : 1) * unit;
    }
  }
  return { leads: Math.round(leads), periodDays: periodDays && periodDays > 0 ? periodDays : null };
}

function parseCplCents(text: string): number | null {
  const m = CPL_RE.exec(text) ?? PER_LEAD_RE.exec(text);
  if (!m) return null;
  const cents = Math.round(toNumber(m[1], m[2]) * 100);
  return cents > 0 ? cents : null;
}

function statedLeadBrief(text: string): StatedLeadBrief {
  const goal = parseLeadGoal(text);
  const total = parseTotal(text);
  const daily = parseBudgetCents(text);
  const period = total?.periodDays ?? goal?.periodDays ?? DEFAULT_PERIOD_DAYS;
  return {
    targetLeads: goal?.leads ?? null,
    periodDays: goal?.periodDays ?? null,
    dailyBudgetCents: daily ?? (total ? Math.round(total.cents / period) : null),
    targetCplCents: parseCplCents(text),
  };
}

/**
 * Lead clients plan on leads, unless the ask itself states a ROAS and no lead count (then the
 * operator chose a ROAS plan). An unset or "other" client plans on leads when the ask is a lead
 * count with no ROAS. Ecommerce never does.
 */
export function isLeadStrategy(
  businessModel: (typeof BUSINESS_MODELS)[number] | undefined,
  texts: string[],
): boolean {
  if (businessModel === "ecommerce") return false;
  const text = texts.join("\n");
  const hasLeads = parseLeadGoal(text) !== null;
  const hasRoas = parseRoasValues(text).length > 0;
  if (businessModel && LEAD_MODELS.includes(businessModel)) return hasLeads || !hasRoas;
  return hasLeads && !hasRoas;
}

export type LeadBriefResult = { brief: LeadBrief | null; missing: Array<"leads">; periodAssumed: boolean };

function completeLeadBrief(s: StatedLeadBrief): LeadBriefResult {
  if (s.targetLeads == null && s.dailyBudgetCents == null) return { brief: null, missing: ["leads"], periodAssumed: false };
  return {
    brief: {
      targetLeads: s.targetLeads,
      periodDays: s.periodDays ?? DEFAULT_PERIOD_DAYS,
      dailyBudgetCents: s.dailyBudgetCents,
      targetCplCents: s.targetCplCents,
    },
    missing: [],
    periodAssumed: s.targetLeads != null && s.periodDays == null,
  };
}

/**
 * The brief for this turn. When it answers the brief question, the reply wins
 * and the operator's earlier ask fills only what the reply leaves out.
 */
export function resolveLeadBrief(request: string, history: AgentHistoryMessage[] = []): LeadBriefResult {
  const at = history.findLastIndex((m) => m.role === "assistant");
  const answersQuestion = at >= 0 && history[at].content.toLowerCase().includes(STRATEGY_BRIEF_MARKER);
  const earlier = answersQuestion ? history.slice(0, at).findLast((m) => m.role === "user") : undefined;
  const now = statedLeadBrief(request);
  if (!earlier) return completeLeadBrief(now);
  const before = statedLeadBrief(earlier.content);
  return completeLeadBrief({
    targetLeads: now.targetLeads ?? before.targetLeads,
    periodDays: now.targetLeads != null ? now.periodDays : before.periodDays,
    dailyBudgetCents: now.dailyBudgetCents ?? before.dailyBudgetCents,
    targetCplCents: now.targetCplCents ?? before.targetCplCents,
  });
}

export function buildLeadClarifyingQuestion(): string {
  return [
    "I can build a **strategy** that sizes the budget for your lead goal — I just need one detail to finish your strategy brief:",
    "",
    "1. **Lead goal** — how many leads do you want, and over what period, e.g. `100 leads a month`? You can add a target cost per lead too, like `under $25 per lead`. If you'd rather set the budget, say e.g. `$80/day` and I'll project the leads it should bring.",
    "",
    "Reply with the missing piece and I’ll build the plan. It’s a recommendation only — I won’t change any campaigns.",
  ].join("\n");
}

/** A short reply with a lead count, a cost per lead or a budget. */
export function looksLikeLeadBriefReply(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  return parseLeadGoal(t) !== null || parseCplCents(t) !== null || parseBudgetCents(t) !== null;
}
