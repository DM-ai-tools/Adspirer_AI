import { z } from "zod";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { completedDaysRange, parseDateRangeFromText, resolveAuditBrief } from "@/lib/agent/audit-brief";
import { FOCUS_AREAS, type ChangeKind, type Focus } from "@/lib/agent/optimization-capabilities";
import { wantsQueueApprovals } from "@/lib/agent/optimize-queue";
import { detectRequestIntentWithHistory, type RequestIntent } from "@/lib/agent/task-plan";

/**
 * What the operator's message means, as data: what they want (intent), whether
 * they want changes made (mode), which areas, which campaigns / ad sets / ads,
 * which period, and which proposals to queue. Dates are always computed here
 * from the message text, never taken from a model.
 */

export type BriefPeriod = { since: string; until: string; label: string; explicit: boolean };

export type QueueSelection = {
  requested: boolean;
  /** "all of these": everything shown in the previous optimisation reply. */
  all: boolean;
  /** Proposal numbers (#n) the operator named. */
  refs: number[];
  focus: Focus[];
  /** Names or ids of the campaigns / ad sets / ads the operator named for the change. */
  entities: string[];
  /** Proposal numbers to leave out ("everything except #2"). */
  exceptRefs?: number[];
  /** Areas to leave out ("the budget ones but not the placement ones"). */
  exceptFocus?: Focus[];
  /** The kind of change asked for ("the pauses", "raise the budget"); empty when none was named. */
  kinds?: ChangeKind[];
  /** The operator used queue words (queue / apply / send to Approvals). False for a direct instruction like "pause X". */
  phrased?: boolean;
};

export type RequestBrief = {
  intent: RequestIntent;
  /** `act` only when the operator asked for changes to be made or queued. */
  mode: "analyse" | "act";
  focus: Focus[];
  scope: { mentions: string[] };
  /** Names or ids the operator said not to touch. */
  exclude: string[];
  period: BriefPeriod | null;
  queue: QueueSelection;
  /** Wants optimisation steps or advice (drives a live fetch even for a follow-up). */
  optimizationAsk: boolean;
  source: "model" | "rules";
};

export const EMPTY_QUEUE: QueueSelection = { requested: false, all: false, refs: [], focus: [], entities: [] };

const INTENT_SET: Record<RequestIntent, true> = {
  audit: true,
  list_campaigns: true,
  budget: true,
  export: true,
  create_campaign: true,
  generate_creatives: true,
  scrape_services: true,
  ad_copy: true,
  copy_approved: true,
  optimize: true,
  strategy: true,
  general: true,
  followup: true,
  chat: true,
  out_of_scope: true,
};

export function isRequestIntent(value: unknown): value is RequestIntent {
  return typeof value === "string" && Object.hasOwn(INTENT_SET, value);
}

/** Intents that may queue changes from an optimisation. Create flows have their own explicit-request gate. */
const QUEUEABLE_INTENTS: ReadonlySet<RequestIntent> = new Set<RequestIntent>(["optimize", "budget"]);

export function isQueueableIntent(intent: RequestIntent): boolean {
  return QUEUEABLE_INTENTS.has(intent);
}

/** Intents whose answer does not depend on a reporting period. */
const NO_PERIOD_INTENTS: ReadonlySet<RequestIntent> = new Set<RequestIntent>([
  "chat",
  "out_of_scope",
  "copy_approved",
  "ad_copy",
  "generate_creatives",
  "scrape_services",
  "create_campaign",
]);

// ---------------------------------------------------------------- period

function periodFrom(text: string, explicit: boolean): BriefPeriod {
  const range = completedDaysRange(text);
  return { since: range.dateStart, until: range.dateStop, label: range.dateLabel, explicit };
}

/**
 * The period for this turn: the one the message states; else the one the
 * conversation was already working in; else the last 7 completed days.
 */
export function resolvePeriod(request: string, history: AgentHistoryMessage[]): BriefPeriod {
  if (parseDateRangeFromText(request)) return periodFrom(request, true);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    if (message.role === "user" && parseDateRangeFromText(message.content)) {
      return periodFrom(message.content, false);
    }
  }
  return periodFrom("last 7 days", false);
}

// ---------------------------------------------------------------- focus

const FOCUS_PATTERNS: Array<[Focus, RegExp]> = [
  ["budget", /\b(?:budgets?|spend(?:ing)?|scal(?:e|ing)|trim(?:ming)?|reallocat\w*|rebalanc\w*)\b/i],
  ["bids", /\b(?:bid(?:s|ding)?|bid cap|cost cap|cpa cap|roas floor|min(?:imum)? roas)\b/i],
  ["placements", /\b(?:placements?|reels|stories|audience network|messenger|marketplace|right column)\b/i],
  ["audiences", /\b(?:audiences?(?!\s+network)|overlap|lookalikes?|exclusions?)\b/i],
  ["creative", /\b(?:creatives?|ad copy|fatigue[d]?|headlines?|primary text|images?|videos?|hooks?|refresh(?:ing)? (?:the )?ads?)\b/i],
  ["schedule", /\b(?:schedule|end date|start date|ends? on|run until|dayparting|ad scheduling)\b/i],
  ["tracking", /\b(?:pixel|capi|conversions? api|tracking|events? manager|utm|attribution|dedup\w*)\b/i],
  ["structure", /\b(?:consolidat\w*|new ad ?sets?|broad (?:ad ?set|audience)|advantage\+|campaign structure|learning[- ]limited|restructur\w*)\b/i],
  ["reactivation", /\b(?:reactivat\w*|re-?start|turn(?:ing)? (?:it |them )?back on|bring back|resume)\b/i],
  ["landing_page", /\b(?:landing pages?|page speed|site speed|load time|bounce)\b/i],
];

export function detectFocus(text: string): Focus[] {
  return FOCUS_AREAS.filter((area) => FOCUS_PATTERNS.some(([f, re]) => f === area && re.test(text)));
}

// ---------------------------------------------------------------- entities

const GENERIC_NAME =
  /^(?:budgets?|spend|spending|performance|results?|ads?|ad sets?|creatives?|settings?|structure|objective|name|data|status|health|audiences?|placements?|bids?|targeting|delivery|optimi[sz]ation|that|this|these|those|it|them|too|is|are|was|has|have|with|performing|and|or|the|my|our|alone|only|instead|also|either|to|for|in|on|at|by|from|than|that|which)\b/i;

/** Words that describe an entity rather than name it; only a name made of nothing else is dropped. */
const DESCRIPTORS =
  /^(?:(?:the|a|an|best|worst|top|bottom|active|live|whole|entire|all|every|each|other|new|old|current|main|first|second|last|previous|next|same|one|ones)\s*)+$/i;

/** A word or number that is not a campaign, ad set or ad name. */
const isGeneric = (name: string) => GENERIC_NAME.test(name) || DESCRIPTORS.test(name) || /^\d{1,6}$/.test(name);

const unquote = (s: string) => s.trim().replace(/^["“”]+|["“”]+$/g, "").trim();

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

const QUOTED = /["“]([^"“”\n]{2,80})["”]/g;
const IDS = /\bact_\d+\b|\b\d{10,}\b/g;
const ACTION_ENTITY =
  /\b(?:pause|resume|stop|turn\s+(?:on|off)|switch\s+(?:on|off)|restart|raise|lower|increase|decrease|cut|reduce|boost|trim|scale(?:\s+(?:up|down))?)\s+(?:the\s+)?(.+?)\s+(?:ad\s?set|adset|campaign|ad)\b/gi;
const TYPE_THEN_NAME =
  /\b(?:campaign|ad\s?set|adset)\s+(?:called\s+|named\s+)?["“]?([A-Za-z0-9][^"”\n,.?!]{0,59}?)["”]?(?=\s+(?:for|in|over|during|last|this|from|between|and|to|please|by|at|with|up|down|than|on)\b|[,.?!]|$)/gi;
/** "from the Leads ad set", "on Brand campaign": a name before the type word, after a preposition. */
const PREP_THEN_NAME =
  /\b(?:from|on|for|in|to|of)\s+(?:the\s+)?["“]?([A-Za-z0-9][^"”\n,.?!]{0,59}?)["”]?\s+(?:ad\s?set|adset|campaign)\b/gi;
const NEGATED =
  /\b(?:don'?t|do\s+not|never|leave|except(?:\s+for)?|excluding|but\s+not)\s+(?:(?:touch(?:ing)?|change|changing|pause|pausing|include|including|alter|altering)\s+)?(?:the\s+)?["“]?([^"”,.?!]{1,60}?)["”]?\s+(?:ad\s?set|adset|campaign|ad)\b/gi;

function matches(re: RegExp, text: string): string[] {
  return [...text.matchAll(re)].map((m) => unquote(m[1] ?? m[0]));
}

/** Names and ids the message points at, and the ones it says to leave alone. */
export function extractEntities(request: string): { mentions: string[]; exclude: string[] } {
  const exclude = dedupe(matches(NEGATED, request).filter((n) => n && !isGeneric(n)));
  const candidates = [
    ...matches(QUOTED, request),
    ...matches(IDS, request),
    ...matches(ACTION_ENTITY, request),
    ...matches(TYPE_THEN_NAME, request),
    ...matches(PREP_THEN_NAME, request),
  ].filter((n) => n && !isGeneric(n));
  const excluded = new Set(exclude.map((n) => n.toLowerCase()));
  const mentions = dedupe(candidates).filter((n) => !excluded.has(n.toLowerCase()));
  return { mentions, exclude };
}

// ---------------------------------------------------------------- queue / mode

const ACT_VERBS =
  "pause|resume|restart|turn\\s+on|turn\\s+off|switch\\s+on|switch\\s+off|stop|raise|lower|increase|decrease|set|change|exclude|remove|add|scale\\s+up|scale\\s+down|trim|cut|reduce|boost|end";
const IMPERATIVE_START = new RegExp(
  `^(?:(?:please|pls|plz|hey|ok(?:ay)?|now|and|then|so|also)[,\\s]+)*(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?(?:${ACT_VERBS})\\b`,
  "i",
);
const IMPERATIVE_COMPOUND = new RegExp(`(?:\\band\\b|\\bthen\\b|[,;])\\s+(?:${ACT_VERBS})\\b`, "i");
const QUESTION_START =
  /^(?:should|shall|would|is|are|does|do|did|what|whats|what's|why|how|which|when|where|who|if)\b/i;
const QUEUE_VERB = /\b(?:queue|apply|implement|execute|push|submit|approve)\b/i;
const QUEUE_COMPOUND = /\b(?:and|then)\s+(?:queue|apply|implement|push|send)\b/i;
const PRONOUN_OBJECT =
  /\b(?:these|those|them|the (?:changes|recommendations|suggestions|optimi[sz]ations|proposals|fixes))\b/i;
const ALL_WORDS = /\b(?:all|everything|every one|each one)\b/i;
const OPTIMIZATION_ASK =
  /\boptimi[sz]\w*|\bnext steps?\b|\bwhat (?:should|do) (?:i|we) (?:do|fix|change|improve)\b|\bhow (?:do|can|should) (?:i|we) (?:fix|improve)\b|\bimprove (?:my|our|the)\b|\bwhat to fix\b/i;

function isImperative(text: string): boolean {
  const t = text.trim();
  if (QUESTION_START.test(t)) return false;
  if (/\?\s*$/.test(t) && !/^(?:(?:please|pls|plz)[,\s]+)?(?:can|could|would|will)\s+you\b/i.test(t)) return false;
  return IMPERATIVE_START.test(t) || IMPERATIVE_COMPOUND.test(t);
}

export function parseRefs(text: string): number[] {
  const refs = new Set<number>();
  const add = (n: number) => {
    if (Number.isInteger(n) && n > 0 && n < 1000) refs.add(n);
  };
  for (const m of text.matchAll(/#\s*(\d{1,3})(?:\s*(?:-|–|to|through|thru)\s*#?\s*(\d{1,3}))?/gi)) {
    const a = Number(m[1]);
    add(a);
    if (m[2]) {
      const b = Number(m[2]);
      if (b > a && b - a <= 20) for (let n = a + 1; n <= b; n += 1) add(n);
      else add(b);
    }
  }
  for (const m of text.matchAll(/\b(?:number|no\.?|item|proposal|step|suggestion|recommendation|option)\s+(\d{1,3})\b/gi)) {
    add(Number(m[1]));
  }
  return [...refs].sort((a, b) => a - b);
}

// ---------------------------------------------------------------- negation

const NEGATOR =
  "(?:don[’']?t|dont|do\\s+not|never|no\\s+need|not|isn[’']?t|aren[’']?t|except(?:\\s+for)?|excluding|without|skip|leave|ignore|other\\s+than|apart\\s+from|besides|hold\\s+off)";
const INSTRUCTION =
  "(?:queue|apply|implement|execute|push|submit|approve|send|add|put|pause|resume|raise|lower|increase|decrease|set|change|optimi[sz]e|fix|improve|audit|review|analy[sz]e|check|scale|trim|cut|reduce|boost|stop|turn|switch|exclude|remove|restart|end|show|tell|list|give|what|why|how|just)";
/**
 * A message splits into clauses at the end of a sentence, before every negator, at "but",
 * before "and" + a new instruction, and before a new instruction after a comma. Never at a
 * dash, bracket or full stop inside a name ("Retargeting – AU", "Leads (AU)", "Sale 2.0").
 */
const CLAUSE_SPLIT = new RegExp(
  `(?<=[.;!?])\\s+|(?=\\b${NEGATOR}\\b)|\\bbut\\b|(?=\\band\\s+${INSTRUCTION}\\b)|,\\s*(?=(?:(?:and|but|then|just|please)\\s+)*(?:${NEGATOR}|${INSTRUCTION})\\b)`,
  "i",
);
const NEGATIVE_CLAUSE = new RegExp(`^\\s*${NEGATOR}\\b`, "i");
/** A question about something is not an instruction to do it. */
const QUESTION_CLAUSE =
  /^\s*(?:(?:and|but|then|so|also|please)\s+)*(?:(?:should|shall|is|are|does|did|what|what's|whats|why|how|which|when|where|who|if)\b|(?:would|could|can|will)\s+(?!you\b))/i;
const NAME_FILLER = new Set([
  "the", "a", "an", "any", "my", "our", "queue", "apply", "touch", "change", "pause", "resume", "include",
  "including", "these", "those", "it", "them", "want", "you", "to", "need", "do", "make", "anything",
  "everything", "else", "also", "yet", "just", "for", "of", "on", "in", "out",
]);
const NAME_STOP = /^(?:ads?|ad-?sets?|adsets?|campaigns?|ones?|alone|and|or|but|only|too|please)$/i;

const isFiller = (token: string) => {
  const word = token.toLowerCase().replace(/[^a-z]/g, "");
  return NAME_FILLER.has(word) || (word.length > 4 && word.endsWith("ing") && token === token.toLowerCase());
};

/** Names in a clause that says to leave something alone: "leave Brand alone", "except the Leads ad set", "not \"Summer Sale\"". */
function namesInNegative(clause: string): string[] {
  const names: string[] = [...matches(QUOTED, clause), ...matches(IDS, clause)];
  const alone = clause.match(/\b(?:leave|skip|ignore)\s+(?:out\s+)?(?:the\s+)?["“]?(.+?)["”]?\s+alone\b/i);
  if (alone?.[1]) names.push(unquote(alone[1]).replace(/\s+(?:ad\s?sets?|adsets?|campaigns?|ads?)$/i, ""));
  const rest = clause.replace(new RegExp(`^\\s*${NEGATOR}\\b[,\\s]*`, "i"), "");
  const tokens = rest.split(/\s+/).filter(Boolean);
  let k = 0;
  while (k < tokens.length && isFiller(tokens[k]!)) k += 1;
  const words: string[] = [];
  for (; k < tokens.length; k += 1) {
    const token = tokens[k]!.replace(/[.,;:!?)"”]+$/g, "");
    if (!/^[A-Z0-9][\w&'’-]*$/.test(token) || NAME_STOP.test(token)) break;
    words.push(token);
  }
  if (words.length) names.push(words.join(" "));
  return names.map((n) => unquote(n).replace(/['’]s$/i, "")).filter((n) => n && !isGeneric(n));
}

export type Negation = {
  /** What the operator told us to do, with everything they ruled out and every question taken out. */
  positive: string;
  /** What they asked about ("what should I fix in budget?"): read for the analysis, never queued. */
  questions: string;
  /** The message says not to do something. */
  negated: boolean;
  /** The message asks a question. */
  questioned: boolean;
  exceptRefs: number[];
  exceptFocus: Focus[];
  excludeNames: string[];
};

/**
 * Split a message into what it asks for and what it rules out. "Queue #1 but not #2" asks
 * for #1 and rules out #2; "don't queue anything yet" asks for nothing. Every request,
 * keyword or model, reads its numbers, areas, names and queue words from the positive
 * part only, so a negated instruction can never queue what it excludes.
 */
export function negationOf(request: string): Negation {
  const positive: string[] = [];
  const questions: string[] = [];
  const exceptRefs = new Set<number>();
  const exceptFocus = new Set<Focus>();
  const names: string[] = [];
  let negated = false;
  for (const clause of request.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean)) {
    if (!NEGATIVE_CLAUSE.test(clause)) {
      (QUESTION_CLAUSE.test(clause) ? questions : positive).push(clause);
      continue;
    }
    negated = true;
    for (const n of parseRefs(clause)) exceptRefs.add(n);
    for (const area of detectFocus(clause)) exceptFocus.add(area);
    names.push(...namesInNegative(clause));
  }
  names.push(...matches(NEGATED, request).filter((n) => n && !isGeneric(n)));
  return {
    positive: positive.join(" "),
    questions: questions.join(" "),
    negated,
    questioned: questions.length > 0,
    exceptRefs: [...exceptRefs].sort((a, b) => a - b),
    exceptFocus: [...exceptFocus],
    excludeNames: dedupe(names),
  };
}

// ---------------------------------------------------------------- kinds of change

const INCREASE = /\b(?:increas\w*|rais(?:e|es|ed|ing)|boost\w*|scal(?:e|ing)[\s-]+ups?|scal(?:e|ing)\s+(?:the\s+)?(?:winners?|best)|top\s+up)\b/i;
const DECREASE = /\b(?:decreas\w*|lower\w*|cut(?:s|ting)?|trim\w*|reduc\w*|scal(?:e|ing)[\s-]+downs?)\b/i;
/** "Pause" and "resume" are about the thing itself. "Stop", "turn off" and "switch on" can also be about a feature of it. */
const STRONG_PAUSE = /\b(?:paus(?:e|es|ed|ing)|halt\w*)\b/i;
const WEAK_PAUSE = /\b(?:stop(?:s|ping)?|turn(?:ing)?\s+(?:it\s+|them\s+)?off|switch(?:ing)?\s+(?:it\s+|them\s+)?off|shut\s+(?:it\s+|them\s+)?off)\b/i;
const STRONG_RESUME = /\b(?:resum(?:e|es|ed|ing)|restart\w*|reactivat\w*)\b/i;
const WEAK_RESUME = /\b(?:re-?enabl\w*|turn(?:ing)?\s+(?:it\s+|them\s+)?(?:back\s+)?on|switch(?:ing)?\s+(?:it\s+|them\s+)?(?:back\s+)?on)\b/i;

/** Which kinds of change a message asks for: "the pauses", "raise the budget". */
export function detectKinds(text: string): ChangeKind[] {
  // "Turn off audience network" changes a placement; it does not pause the ad set.
  const aboutAFeature = detectFocus(text).some((area) => area === "placements" || area === "audiences" || area === "schedule");
  const kinds: ChangeKind[] = [];
  if (INCREASE.test(text)) kinds.push("increase");
  if (DECREASE.test(text)) kinds.push("decrease");
  if (STRONG_PAUSE.test(text) || (!aboutAFeature && WEAK_PAUSE.test(text))) kinds.push("pause");
  if (STRONG_RESUME.test(text) || (!aboutAFeature && WEAK_RESUME.test(text))) kinds.push("resume");
  return kinds;
}

/** The operator used queue words, as opposed to a direct instruction ("pause X"). */
export function phrasedAsQueue(text: string): boolean {
  return QUEUE_VERB.test(text) || wantsQueueApprovals(text) || QUEUE_COMPOUND.test(text);
}

const CONFIRMATION = /\b(?:yes|yep|yeah|go ahead|do it|please do|sure|ok(?:ay)?|proceed|confirm(?:ed)?)\b/i;

/** Does this text still say to do something (after what it rules out is taken away)? */
function hasInstructionCue(text: string): boolean {
  return phrasedAsQueue(text) || parseRefs(text).length > 0 || isImperative(text) || CONFIRMATION.test(text);
}

function detectQueue(
  request: string,
  intent: RequestIntent,
  focus: Focus[],
  mentions: string[],
): QueueSelection {
  if (!isQueueableIntent(intent)) return { ...EMPTY_QUEUE };
  const refs = parseRefs(request);
  const kinds = detectKinds(request);
  const queueVerb = QUEUE_VERB.test(request);
  const all =
    queueVerb || wantsQueueApprovals(request) || QUEUE_COMPOUND.test(request)
      ? ALL_WORDS.test(request) || (PRONOUN_OBJECT.test(request) && /\b(?:these|those|them)\b/i.test(request) && !refs.length && !focus.length)
      : false;
  const phrasedAsQueue = queueVerb || wantsQueueApprovals(request) || QUEUE_COMPOUND.test(request);
  const requested =
    wantsQueueApprovals(request) ||
    QUEUE_COMPOUND.test(request) ||
    (queueVerb && (refs.length > 0 || all || PRONOUN_OBJECT.test(request) || focus.length > 0 || kinds.length > 0)) ||
    (isImperative(request) && (mentions.length > 0 || focus.length > 0));
  if (!requested) return { ...EMPTY_QUEUE };
  // Only "queue the budget changes" selects among the proposals shown earlier; a direct
  // instruction ("raise the budget of X to 60") names an area but is the operator's own change.
  return {
    requested: true,
    all,
    refs,
    focus: phrasedAsQueue ? [...focus] : [],
    entities: [...mentions],
    kinds,
    phrased: phrasedAsQueue,
  };
}

/** Numbers and areas the operator ruled out are left out of what they asked to queue. */
function withLeftOut(queue: QueueSelection, negation: Negation): QueueSelection {
  if (!queue.requested) return queue;
  return {
    ...queue,
    refs: queue.refs.filter((n) => !negation.exceptRefs.includes(n)),
    exceptRefs: negation.exceptRefs,
    exceptFocus: negation.exceptFocus.filter((area) => !queue.focus.includes(area)),
  };
}

export function asksForOptimization(text: string): boolean {
  return OPTIMIZATION_ASK.test(text);
}

/**
 * The campaigns the conversation was already working on (an audit of "TR Lead",
 * say), so "give me the optimization steps" stays on them. Empty when the latest
 * message widens it to the whole account.
 */
export function inheritedScope(request: string, history: AgentHistoryMessage[]): string[] {
  const audit = resolveAuditBrief(request, history);
  return audit.scope === "campaigns" ? audit.campaignHints.filter((n) => !isGeneric(n)) : [];
}

/**
 * Final adjustments every brief gets, wherever it came from: a follow-up that asks
 * for optimisation steps is a live optimisation (the old report is not evidence),
 * and an analysis stays on the campaigns the chat was already about.
 */
export function normalizeBrief(
  brief: RequestBrief,
  request: string,
  history: AgentHistoryMessage[],
): RequestBrief {
  let next = brief;
  if (next.intent === "followup" && next.optimizationAsk) {
    next = { ...next, intent: "optimize", mode: "analyse", queue: { ...EMPTY_QUEUE } };
  }
  // A budget message that changes something, or asks what to do, is the optimisation flow:
  // live numbers for the stated period and scope, and a numbered list to queue from.
  if (next.intent === "budget" && (next.mode === "act" || next.optimizationAsk)) {
    next = { ...next, intent: "optimize" };
  }
  if (!next.period && !NO_PERIOD_INTENTS.has(next.intent)) {
    next = { ...next, period: resolvePeriod(request, history) };
  }
  if (next.intent === "optimize" && !next.queue.requested && next.scope.mentions.length === 0) {
    const excluded = new Set(next.exclude.map((n) => n.toLowerCase()));
    const inherited = inheritedScope(request, history).filter((n) => !excluded.has(n.toLowerCase()));
    if (inherited.length) next = { ...next, scope: { mentions: inherited } };
  }
  return next;
}

/**
 * The brief when no model answered: the keyword intent rules plus the same
 * extraction as above. Conservative: anything unclear is `analyse`.
 */
export function rulesBrief(request: string, history: AgentHistoryMessage[]): RequestBrief {
  let intent = detectRequestIntentWithHistory(request, history);
  // What the operator asks for, without what they ruled out ("queue #1 but not #2").
  const negation = negationOf(request);
  const instructed = negation.positive;
  const asked = [negation.positive, negation.questions].filter(Boolean).join(" ");
  const optimizationAsk = OPTIMIZATION_ASK.test(asked);
  const focus = detectFocus(asked);
  const found = extractEntities(asked);
  const exclude = dedupe([...negation.excludeNames, ...found.exclude]);
  const left = new Set(exclude.map((n) => n.toLowerCase()));
  const notLeft = (names: string[]) => names.filter((n) => !left.has(n.toLowerCase()));
  const mentions = notLeft(found.mentions);
  const toChange = notLeft(extractEntities(instructed).mentions);
  const changeFocus = detectFocus(instructed);
  // "pause the Retargeting ad set" is an instruction to change something, which is the
  // optimize flow (pause / resume / budget changes through Approvals).
  const wantsChange = isImperative(instructed) && (toChange.length > 0 || changeFocus.length > 0);
  if ((optimizationAsk || wantsChange) && (intent === "general" || intent === "budget")) intent = "optimize";
  const queue = withLeftOut(detectQueue(instructed, intent, changeFocus, toChange), negation);
  return {
    intent,
    mode: queue.requested ? "act" : "analyse",
    focus,
    scope: { mentions },
    exclude,
    period: NO_PERIOD_INTENTS.has(intent) ? null : resolvePeriod(request, history),
    queue,
    optimizationAsk,
    source: "rules",
  };
}

// ---------------------------------------------------------------- model reply

const focusSchema = z.enum(FOCUS_AREAS);
const nameList = z.array(z.string().min(1).max(120)).max(10);
const modelSchema = z.object({
  intent: z.string().refine(isRequestIntent),
  mode: z.enum(["analyse", "act"]).default("analyse"),
  focus: z.array(focusSchema).default([]),
  scope: nameList.default([]),
  periodStated: z.boolean().optional(),
  optimizationAsk: z.boolean().default(false),
  queue: z
    .object({
      requested: z.boolean().default(false),
      all: z.boolean().default(false),
      refs: z.array(z.number().int().positive().max(999)).max(30).default([]),
      focus: z.array(focusSchema).default([]),
      entities: nameList.default([]),
      exceptRefs: z.array(z.number().int().positive().max(999)).max(30).default([]),
      exceptFocus: z.array(focusSchema).default([]),
    })
    .default({ requested: false, all: false, refs: [], focus: [], entities: [], exceptRefs: [], exceptFocus: [] }),
  exclude: nameList.default([]),
});

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Parse and validate the classifier's JSON. null when it cannot be trusted. */
export function parseBriefReply(
  reply: string,
  request: string,
  history: AgentHistoryMessage[],
): RequestBrief | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = modelSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;
  const intent = data.intent as RequestIntent;

  // Only names the operator actually typed count; a model cannot add a campaign.
  const typed = norm(request);
  const keep = (names: string[]) => dedupe(names.map(unquote)).filter((n) => typed.includes(norm(n)));
  // What the typed text rules out is applied whatever the model said: "don't queue #2" never queues #2.
  const negation = negationOf(request);
  const asked = negation.positive;
  const exclude = dedupe([...keep(data.exclude), ...negation.excludeNames]);
  const excluded = new Set(exclude.map(norm));
  const mentions = keep(data.scope).filter((n) => !excluded.has(norm(n)));
  const exceptRefs = [...new Set([...data.queue.exceptRefs, ...negation.exceptRefs])].sort((a, b) => a - b);
  const exceptFocus = [...new Set([...data.queue.exceptFocus, ...negation.exceptFocus])];
  const phrased = phrasedAsQueue(asked);

  // A model that reads a negated message as an instruction is overruled when nothing is left to do.
  const ruledOut = (negation.negated || negation.questioned) && !hasInstructionCue(asked);
  const act = data.mode === "act" && data.queue.requested && isQueueableIntent(intent) && !ruledOut;
  const queueFocus = phrased ? [...new Set(data.queue.focus)] : [];
  const queue: QueueSelection = act
    ? {
        requested: true,
        all: data.queue.all,
        refs: [...new Set(data.queue.refs)].filter((n) => !exceptRefs.includes(n)).sort((a, b) => a - b),
        focus: queueFocus,
        entities: keep(data.queue.entities).filter((n) => !excluded.has(norm(n))),
        exceptRefs,
        exceptFocus: exceptFocus.filter((area) => !queueFocus.includes(area)),
        kinds: detectKinds(asked),
        phrased,
      }
    : { ...EMPTY_QUEUE };

  return {
    intent,
    mode: act ? "act" : "analyse",
    focus: [...new Set(data.focus)].filter((area) => !exceptFocus.includes(area)),
    scope: { mentions },
    exclude,
    period: NO_PERIOD_INTENTS.has(intent) ? null : resolvePeriod(request, history),
    queue,
    optimizationAsk: data.optimizationAsk,
    source: "model",
  };
}
