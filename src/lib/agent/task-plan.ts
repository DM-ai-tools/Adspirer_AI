import { isCreateCampaignAsk } from "@/lib/chat/infer-flow";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import { looksLikeAuditBriefReply, parseDateRangeFromText } from "@/lib/agent/audit-brief";
import { looksLikeLeadBriefReply } from "@/lib/agent/lead-brief";
import { looksLikeStrategyBriefReply, STRATEGY_BRIEF_MARKER } from "@/lib/agent/strategy-brief";

export type TaskStepState =
  | "pending"
  | "active"
  | "done"
  /** The agent asked the operator something and stopped; not running, not finished. */
  | "waiting"
  | "error"
  | "skipped";

export type TaskStep = {
  id: string;
  label: string;
  state: TaskStepState;
};

export type RequestIntent =
  | "audit"
  | "list_campaigns"
  | "budget"
  | "export"
  | "create_campaign"
  | "generate_creatives"
  | "scrape_services"
  | "ad_copy"
  | "copy_approved"
  | "optimize"
  | "strategy"
  | "general"
  /** Asks to act on a report already in the chat ("based on the audit, give me the fixes"). */
  /** Anything specific the fixed intents do not cover (a custom metric table, a weekly breakdown, an Excel with chosen columns): the model plans it and reads the data itself. */
  | "custom"
  | "followup"
  /** Greetings, thanks, definitions, "why is that" — answered without fresh account data. */
  | "chat"
  | "out_of_scope";

/** Intents that are answered conversationally (short reply, small output budget). */
export const CONVERSATIONAL_INTENTS: ReadonlySet<RequestIntent> = new Set([
  "chat",
  "general",
  "list_campaigns",
  "copy_approved",
  "out_of_scope",
]);

/** Intents whose reply is a long-form report (audit / export). */
export const REPORT_INTENTS: ReadonlySet<RequestIntent> = new Set([
  "audit",
  "export",
  "strategy",
]);

const GREETING_ONLY =
  /^(?:hi|hello|hey|hiya|yo|howdy|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|team|campaignforge|mate))?[\s!.,]*$/i;

const THANKS_OR_UNDERSTOOD =
  /^(?:(?:ok(?:ay)?|great|perfect|awesome|nice|cool|brilliant|excellent|lovely|amazing)[\s,!.]+)?(?:thanks?(?:\s+(?:you|so much|a lot|again|mate|team))*|thank\s+you(?:\s+(?:so much|very much|again))*|thx|ty|cheers|much appreciated|appreciate it|got it|understood|noted|makes sense|that makes sense|fair enough|i see|that'?s (?:helpful|clear|useful))(?:[\s,!.]+(?:thanks?|thank you|thx|cheers|that'?s helpful))*[\s!.]*$/i;

const DEFINITIONAL_QUESTION =
  /^(?:(?:so|ok(?:ay)?|and|but|hmm|sorry|quick question)[,\s]+)?(?:what(?:'s|’s| is| are| does| do)\b|whats\b|define\b|explain\b|can you explain\b|could you explain\b|meaning of\b|what do you mean\b|why\s*\?*$|why so\b|why (?:is|was|would|does|did|do) (?:that|this|it|they)\b|how (?:is|are|do you|does meta) (?:\w+\s+){0,3}(?:calculated|computed|measured|defined|counted)\b|how does (?:\w+\s+){0,3}work\b|difference between\b|is (?:that|this|it) (?:bad|good|normal|high|low)\b)/i;

/** Mentions of live account data — those questions need a fresh fetch. */
const ACCOUNT_DATA_REFERENCE =
  /\b(?:my|our|this|these|those|the|current|their)\s+(?:account|ad\s*accounts?|campaigns?|ad\s*sets?|adsets?|ads|spend|budgets?|performance|results|numbers|metrics|cpa|cpm|cpc|ctr|roas|conversions?|leads|pixel|landing\s*pages?|audiences?|creatives?|approvals?|status|destination|website)\b|\b(?:last|past|this)\s+(?:\d+\s+)?(?:days?|week|month|quarter|year)\b|\byesterday\b|\btoday\b|\bact_\d+|\b\d{10,}\b|https?:\/\/|www\./i;

/**
 * Questions about sales, products, traffic or search data, or a ranking ("best
 * selling", "top products"): answered from GA4 / Search Console / Meta through
 * the read tools, never as a quick definition.
 */
const DATA_TOPIC_REFERENCE =
  /\b(?:products?|items?|skus?|sales|revenue|orders?|purchases?|traffic|sessions?|visitors?|users?|queries|search\s+terms?|keywords?|landing\s*pages?|sources?|channels?|ga4|google\s+analytics|analytics|search\s+console|google\s+ads|best[\s-]*sell\w*|top\s+(?:\d+\s+)?\w+|most\s+\w+|worst\s+\w+)\b/i;

const ACTION_REQUEST =
  /\b(?:create|launch|build|generate|write|draft|pause|resume|queue|approve|apply|increase|decrease|raise|lower|scale|optimi[sz]e|audit|diagnos\w*|export|download|pdf|docx?|report|scrape|list|show|pull|fetch|check|compare|send)\b/i;

/**
 * A turn that needs no fresh Meta data: a greeting, a thank-you, or a
 * definitional / follow-up question ("what does CPM mean", "why is that").
 * These skip the Graph preflight and research memo so the reply starts fast.
 */
export function isConversationalTurn(request: string): boolean {
  const text = request.trim();
  if (!text || text.length > 220 || text.split("\n").length > 3) return false;
  if (GREETING_ONLY.test(text) || THANKS_OR_UNDERSTOOD.test(text)) return true;
  if (!DEFINITIONAL_QUESTION.test(text)) return false;
  if (ACCOUNT_DATA_REFERENCE.test(text)) return false;
  if (DATA_TOPIC_REFERENCE.test(text)) return false;
  if (ACTION_REQUEST.test(text)) return false;
  return true;
}

/** Explicit request for the heavy, multi-step account audit. */
const EXPLICIT_AUDIT =
  /\b(?:audit\w*|diagnos\w*|health\s*-?\s*check|account\s+health|full\s+(?:account\s+)?review|review\s+(?:of\s+)?(?:the\s+|my\s+|our\s+|this\s+)?(?:whole\s+|entire\s+|full\s+)?(?:ad\s+)?account)\b/;

/** "10x roas", "12x target", "8x return". */
const ROAS_MULTIPLE = String.raw`\d+(?:\.\d+)?\s*[x×]\s*(?:roas|target|return)\b`;
/**
 * A goal verb or plan word; a bare "5x roas" is often a reporting filter, not a goal.
 * Plain "get" is left out ("get me the ads with 5x roas" is a report); "get to 5x roas"
 * is caught by STRATEGY_EXPLICIT_GOAL.
 */
const GOAL_WORD = String.raw`\b(?:hit|reach|achieve|aim|target|plan|strategy|how\s+do\s+i)\b`;
/**
 * A goal verb straight before the multiple: "hit 5x roas", "get to 5x roas".
 * It stays a goal even next to a comparison ("we're under 2x roas, how do i hit 5x roas").
 */
const STRATEGY_EXPLICIT_GOAL =
  /\b(?:hit|reach|achieve|get\s+to|get)\s+(?:an?\s+)?\d+(?:\.\d+)?\s*[x×]\s*(?:roas|return|target)\b/;
/** "$4k to get $40k back", "spend $4k and get $40k back", "$4k over 2 weeks to get $40k back". */
const MONEY_BACK_WITH_BACK = String.raw`\$\s*[\d,.]+\s*k?\s+MONEY_PERIOD(?:and|to)\s+(?:get|make|generate|bring\s+in|return)\s+(?:me\s+)?\$\s*[\d,.]+\s*k?\s*back\b`;
/**
 * Without "back" the form is a goal only after "spend", "how do/can we/I", "plan" or
 * "strategy": "which campaigns spent $500 to get $2000 in sales" is a report.
 */
const MONEY_GOAL_OPENER = String.raw`(?:\bspend\s+|\b(?:how\s+(?:do|can)\s+(?:we|i)|plan|strategy)\b[^.?!\n]{0,40}?)`;
const MONEY_BACK_GOAL = [
  MONEY_BACK_WITH_BACK,
  String.raw`${MONEY_GOAL_OPENER}\$\s*[\d,.]+\s*k?\s+MONEY_PERIOD(?:(?:and|to)\s+(?:get|make|generate|bring\s+in|return)\s+(?:me\s+)?\$\s*[\d,.]+\s*k?|for\s+\$\s*[\d,.]+\s*k?\s+in\s+(?:sales|revenue))`,
]
  .join("|")
  .replaceAll("MONEY_PERIOD", String.raw`(?:(?:over|across|within)\s+(?:the\s+next\s+)?\d+\s*(?:days?|weeks?|months?)\s+|this\s+month\s+)?`);
/**
 * A return goal stated outright: "get 10x roas", "roas of 8", "reach a 12x target",
 * "$4k to get $40k back". The goal word sits within the same clause as the multiple.
 */
const STRATEGY_GOAL = new RegExp(
  [
    String.raw`${GOAL_WORD}[^.?!\n]{0,40}?${ROAS_MULTIPLE}`,
    String.raw`${ROAS_MULTIPLE}[^.?!\n]{0,40}?${GOAL_WORD}`,
    String.raw`\broas\s+of\s+\d`,
    String.raw`\bstretch\s+targets?\b`,
    MONEY_BACK_GOAL,
    String.raw`\b(?:hit|reach|get)\s+(?:a\s+)?\d+(?:\.\d+)?\s*[x×]\s*(?:roas|return|target|back)\b`,
  ].join("|"),
);
/** "under 2x roas", "above a roas of 3", "5x roas or better": a filter on results, not a goal. */
const ROAS_COMPARISON =
  /\b(?:above|below|under|over|more\s+than|less\s+than|at\s+least)\s+(?:an?\s+)?(?:roas\s+(?:of\s+)?\d|\d+(?:\.\d+)?\s*[x×])|(?:\d\s*[x×]\s*(?:roas\s+)?|\broas\s+of\s+\d+(?:\.\d+)?\s*)or\s+(?:better|worse)\b/;
/**
 * A lead goal stated outright with a budget or plan ask: "to get 100 leads in a month what budget do I
 * need", "how much to spend for 50 enquiries". A bare "campaigns with 100 leads" is a report.
 */
const LEAD_COUNT = String.raw`\d[\d,.]*\s*k?\s+(?:qualified\s+|new\s+)?(?:leads?|enquir\w+|inquir\w+|bookings?|appointments?|registrations?|sign-?ups?)\b`;
const STRATEGY_LEAD_GOAL = new RegExp(
  [
    String.raw`\b(?:get|generate|hit|reach|achieve|need|want|bring\s+in)\s+(?:me\s+)?${LEAD_COUNT}[^.?!\n]{0,80}?\b(?:budget|how\s+much|spend|plan|strategy)\b`,
    String.raw`\b(?:budget|how\s+much|spend|plan|strategy)\b[^.?!\n]{0,80}?\b(?:get|generate|hit|reach|achieve|bring\s+in)\s+(?:me\s+)?${LEAD_COUNT}`,
  ].join("|"),
);
/** Words that ask for a plan; on their own they don't skip the chat check. */
const STRATEGY_PLAN_WORDS = /\bstrategy\b|\bgame\s*plan\b|\bplan\s+to\s+(?:hit|reach|get)\b/;
/** "target roas" counts only next to a plan / how-to signal. */
const STRATEGY_TARGET_ROAS =
  /\btarget\s+roas\b[\s\S]*\b(?:plan|how\s+(?:do|can|to))\b|\b(?:plan|how\s+(?:do|can|to))\b[\s\S]*\btarget\s+roas\b/;
/** Other flows that mention a ROAS number but are not asking for a plan. */
const NOT_STRATEGY_ACTION =
  /\b(?:optimi[sz]\w*|create|launch|pause|resume|queue|apply|implement|execute|set\s*up)\b/;
const DEFINITION_WORDS = /\b(?:mean|means|define|definition)\b/;

/** Points at a report that already exists: "based on the audit", "from the findings above". */
const EARLIER_REPORT_REFERENCE =
  /\b(?:on|from|using|per|to|off|after|given|following|with|of)\s+(?:the|this|that|your|our)\s+(?:(?:above|previous|last|earlier)\s+)?(?:audit|report|findings?|analysis|review|scorecard|results)\b|\b(?:the|this|that|your)\s+(?:audit|report|findings?|scorecard)\s+(?:above|you\s+(?:just\s+)?(?:gave|ran|wrote|made|did))\b|\b(?:the|these|those)\s+(?:above\s+)?(?:findings|issues|failures|fails)\b/;
/** Asks for the way forward from what was just shown, with no data or build request of its own. */
const NEXT_STEPS_ASK =
  /\b(?:optimi[sz]ation|optimi[sz]ing|improvement|fix|action|next)\s+(?:steps?|actions?|plan|list|recommendations?|priorities)\b|\bwhat\s+(?:should|do)\s+(?:i|we)\s+(?:do|fix|change|improve)\b|\bhow\s+(?:do|can|should)\s+(?:i|we)\s+(?:fix|improve)\b|\b(?:among|out\s+of|of)\s+(?:these|those)\b|\b(?:these|those)\s+(?:recommendations?|steps?|fixes|actions?|changes)\b|\bcan\s+you\s+(?:do|apply|fix|implement|handle|take\s+care\s+of)\s+(?:any|some|all|these|those|them|it)\b|\bwhich\s+(?:ones?|of\s+(?:these|those|them))\b[^.?!\n]{0,60}\b(?:can|could|possible|able)\b/;
/** Wants the audit (re)done rather than used. */
const AUDIT_RERUN_ASK =
  /\b(?:run|do|start|perform|redo|re-?run|another|new|fresh|again|update|refresh|repeat)\b[^.?!\n]{0,30}\baudit/;

export function detectRequestIntent(request: string): RequestIntent {
  const text = request.toLowerCase();
  // The campaign settings card's confirmation is a step of the build; its text
  // mentions budget and attribution, which must not read as other requests.
  if (/^\s*campaign settings selections\b/.test(text)) return "create_campaign";
  if (
    // Google Ads, GA4 and Search Console are read through the data tools, so they're in scope.
    // "stock" and "code" alone are Shopify stock, discount codes and pixel code, so only
    // stock-market and programming phrasings count.
    /weather|recipe|\b(?:write|debug|fix|review)\s+(?:some\s+|this\s+|my\s+)?(?:python\s+|javascript\s+)?code\b|python|javascript|write a poem|joke|crypto|\bstocks?\s+(?:market|price|tips?|picks?)\b|linkedin|tiktok/i.test(
      text,
    ) &&
    !/meta|facebook|instagram|campaign|ad\s?set|budget|audit|ads|create|website|scrape|service|copy|headline|optimiz/.test(
      text,
    )
  ) {
    return "out_of_scope";
  }
  // "what's the plan to reach a 12x target" opens like a definitional question
  // but is a strategy ask; "what does 10x roas mean" stays a definition.
  const planWords = STRATEGY_PLAN_WORDS.test(text);
  const goalAsk =
    !DEFINITION_WORDS.test(text) &&
    (STRATEGY_EXPLICIT_GOAL.test(text) ||
      STRATEGY_LEAD_GOAL.test(text) ||
      (STRATEGY_GOAL.test(text) && !ROAS_COMPARISON.test(text)));
  if (!goalAsk && isConversationalTurn(request)) {
    return "chat";
  }
  // Strategy before optimize/audit. Optimize / create / pause / queue wording
  // wins unless the operator also says "strategy", "game plan" or "plan to".
  if (
    (goalAsk || planWords || STRATEGY_TARGET_ROAS.test(text)) &&
    (planWords || !NOT_STRATEGY_ACTION.test(text))
  ) {
    return "strategy";
  }
  // Queue / apply optimized changes → Approvals path (before export "send report")
  if (
    /\b(send|queue|submit|put|push|add)\b[\s\S]{0,48}\bapprov/.test(text) ||
    /\b(apply|implement|execute)\b[\s\S]{0,40}\b(optim|recommend|change|these|those)\b/.test(
      text,
    ) ||
    /\b(don'?t|do not|can'?t|cannot|doesn'?t)\s+see\b[\s\S]{0,48}\bapprov/.test(
      text,
    ) ||
    /\bnothing\b[\s\S]{0,24}\bapprov/.test(text) ||
    /\bqueue (?:the |these |those )?(?:optim|change|recommend|budget)/.test(text)
  ) {
    return "optimize";
  }
  if (
    /\b(optimiz|creative fatigue|refresh (the )?ad|improve (the )?ad|placement optim)\b/.test(
      text,
    ) ||
    /\bselected ad\b.*\boptim/.test(text) ||
    /\boptimize\b.*\b(ad|campaign|budget|placement)/.test(text) ||
    /\boptimi[sz]\w*\b[\s\S]*\broas\b|\broas\b[\s\S]*\boptimi[sz]\w*/.test(text)
  ) {
    return "optimize";
  }
  // Image / still generation before scrape or ad_copy — "create an image for
  // this ad copy for URL …" must not become website scrape or copy-only.
  if (
    mentionsCreativeGeneration(text) ||
    (/\b(generate|create|make|produce|design|render)\b/.test(text) &&
      /\b(images?|creatives?|stills?|visuals?|ad\s*images?)\b/.test(text))
  ) {
    return "generate_creatives";
  }
  // Scrape only when the operator wants services/offerings pulled — not merely
  // because a URL / "landing" / "website" appears next to image or copy work.
  if (
    /\b(https?:\/\/|www\.)\S+/i.test(text) &&
    /\b(scrape|services?|offerings?)\b/.test(text) &&
    !/\b(images?|stills?|creatives?|visuals?)\b/.test(text)
  ) {
    return "scrape_services";
  }
  // Report / export before create so "create a report" doesn't become campaign create
  if (
    /\b(pdf|docx?|word|export|download)\b/.test(text) ||
    (/\b(report|recap|briefing|write-?up|summary)\b/.test(text) &&
      /\b(give|generate|create|write|produce|make|draft|prepare|build|share|send|get)\b/.test(
        text,
      ) &&
      !/\bad copy|headline|primary text\b/.test(text)) ||
    /\bgive me a report\b|\bgenerate a report\b|\breport for (our|this|the) (task|session|chat|work)\b/.test(
      text,
    )
  ) {
    return "export";
  }
  if (
    /\buse approved ad copy variant\b/i.test(text) ||
    /\bapproved ad copy variant\b/i.test(text)
  ) {
    return "copy_approved";
  }
  // Copy generation needs an explicit ask — a bare "headline" / "CTA" mention
  // ("what's the CTA on ad X?") is a question, not a request for variants.
  if (
    /\b(ad copy|ad copies|write copy|generate copy|copy variants)\b/.test(
      text,
    ) ||
    (/\b(write|generate|draft|create|rewrite|refresh|suggest|come up with|give me)\b/.test(
      text,
    ) &&
      /\b(headlines?|primary text|ad copy|copies|ctas?|hooks?)\b/.test(text))
  ) {
    return "ad_copy";
  }
  if (
    /\b(create|launch|build|set up|setup|new)\b.*\b(campaign|ad set|adset|ads?)\b/.test(
      text,
    ) ||
    /\b(campaign|ad set|adset)\b.*\b(create|launch|build)\b/.test(text) ||
    /\bselected services\b/.test(text) ||
    /\bcreate_adset\b|\bcreate_ad\b|\bcreate_meta_image_campaign\b|\bcreate_meta_video_campaign\b/.test(
      text,
    )
  ) {
    return "create_campaign";
  }
  if (/\b(budget|bid|increase|decrease|scale spend)\b/.test(text)) {
    return "budget";
  }
  if (
    (/\b(list|show|which)\b.*\bcampaign/.test(text) ||
      (/\bcampaigns?\b/.test(text) && /\blist|show\b/.test(text))) &&
    !/\bcreate|launch|build\b/.test(text)
  ) {
    return "list_campaigns";
  }
  // Only an explicit audit ask runs the heavy multi-step audit. Other
  // performance questions ("how is spend pacing?", "why is delivery low?") take
  // the lighter general path, which still pulls a live performance snapshot.
  // "based on the audit, give me the fixes" uses an audit; it doesn't ask for one.
  if (
    EXPLICIT_AUDIT.test(text) &&
    (!EARLIER_REPORT_REFERENCE.test(text) || AUDIT_RERUN_ASK.test(text))
  ) {
    return "audit";
  }
  return "general";
}

/**
 * Does this message build on a report the assistant already wrote in this chat
 * ("based on the audit, give me the optimization steps")? Needs a delivered
 * report in the recent turns, so a first message never counts.
 */
function buildsOnEarlierReport(
  request: string,
  recent: AgentHistoryMessage[],
): boolean {
  const text = request.toLowerCase();
  if (AUDIT_RERUN_ASK.test(text)) return false;
  if (!recent.some((m) => m.role === "assistant" && m.content.length >= 800)) {
    return false;
  }
  return EARLIER_REPORT_REFERENCE.test(text) || NEXT_STEPS_ASK.test(text);
}

/**
 * Same as detectRequestIntent, but keeps short follow-ups ("last 30 days",
 * "entire account") on the audit path when the recent chat is mid-brief.
 */
/** Words that really ask to optimize an existing ad (as opposed to queueing a campaign). */
const EXPLICIT_OPTIMIZE_ASK =
  /\b(optimi[sz]\w*|creative fatigue|refresh (?:the )?ad|improve (?:the )?ad|selected ad|placement optim)/i;

/**
 * Is a campaign build still in progress? True when the operator asked to
 * create a campaign / image or video ad in the recent turns and has not since
 * asked to optimize something. Mid-build replies ("here's the image link",
 * "send it to Approvals") belong to the build, not to the optimize flow.
 */
function campaignBuildOpen(recent: AgentHistoryMessage[]): boolean {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const m = recent[i]!;
    if (m.role !== "user") continue;
    if (EXPLICIT_OPTIMIZE_ASK.test(m.content)) return false;
    if (isCreateCampaignAsk(m.content)) return true;
  }
  return false;
}

export function detectRequestIntentWithHistory(
  request: string,
  history: AgentHistoryMessage[] = [],
): RequestIntent {
  const primary = detectRequestIntent(request);
  const recent = history.slice(-10);
  const buildOpen = campaignBuildOpen(recent);
  // "send it to Approvals" while a campaign is being built queues the
  // campaign; it is not an optimize ask.
  if (primary === "optimize" && buildOpen && !EXPLICIT_OPTIMIZE_ASK.test(request)) {
    return "create_campaign";
  }
  // A short answer ("$1,200/day, 10x") to the strategy brief's own question.
  // Checked before the early return: "my budget is $900 a day" reads as "budget".
  if (primary === "general" || primary === "budget" || primary === "chat") {
    const last = [...recent].reverse().find((m) => m.role === "assistant");
    if (
      last &&
      last.content.length < 2000 &&
      last.content.toLowerCase().includes(STRATEGY_BRIEF_MARKER) &&
      (looksLikeStrategyBriefReply(request) || looksLikeLeadBriefReply(request))
    ) {
      return "strategy";
    }
  }
  // Work on the report already in the chat; never re-run it. Explicit queue /
  // apply asks keep their own optimize path (they are not "audit" or "general").
  if (
    (primary === "audit" || primary === "general") &&
    buildsOnEarlierReport(request, recent)
  ) {
    return "followup";
  }
  if (primary !== "general") return primary;

  // Only a brief that is still open counts. Once a full audit has been
  // delivered (a long reply), a follow-up like "which campaigns are wasting
  // spend?" must not re-run the whole audit.
  const lastAssistant = [...recent].reverse().find((m) => m.role === "assistant");
  const briefStillOpen =
    !lastAssistant || lastAssistant.content.length < 2000;
  const assistantAskedAudit = Boolean(
    lastAssistant &&
      briefStillOpen &&
      /\b(date range|entire ad account|specific campaign|best-practice audit|competitor landing)\b/i.test(
        lastAssistant.content,
      ),
  );
  const userAskedAudit =
    briefStillOpen &&
    recent.some(
      (m) => m.role === "user" && detectRequestIntent(m.content) === "audit",
    );
  if ((assistantAskedAudit || userAskedAudit) && looksLikeAuditBriefReply(request)) {
    return "audit";
  }
  // A short answer to the audit's own clarifying question stays on the audit
  // path even if it can't be parsed — the brief then asks again, instead of
  // a generic reply pretending to be an audit without data.
  const askedForBrief = Boolean(
    lastAssistant &&
      briefStillOpen &&
      /before I run the full audit|what date range should I cover|reply with the missing piece|audit briefing/i.test(
        lastAssistant.content,
      ),
  );
  if (askedForBrief && request.trim().length <= 200 && !/\?\s*$/.test(request.trim())) {
    return "audit";
  }
  // "now do 16th to 17th sept" / "16 sept" after an audit → the same audit
  // for the new period. Questions ("what was spend on 16 sept?") stay Q&A.
  const hadAudit = history.some(
    (m) => m.role === "user" && detectRequestIntent(m.content) === "audit",
  );
  if (
    hadAudit &&
    request.trim().length <= 120 &&
    !/\?\s*$/.test(request.trim()) &&
    parseDateRangeFromText(request)
  ) {
    return "audit";
  }

  const assistantOfferedOptimize = recent.some(
    (m) =>
      m.role === "assistant" &&
      /\b(optimiz|recommendation|rebalance|budget|Approvals|pause|SCALE|TRIM)\b/i.test(
        m.content,
      ),
  );
  const userAskedOptimize = recent.some(
    (m) => m.role === "user" && detectRequestIntent(m.content) === "optimize",
  );
  if (
    (assistantOfferedOptimize || userAskedOptimize) &&
    !buildOpen &&
    /\b(approv|queue|apply|implement|send|optim)/i.test(request)
  ) {
    return "optimize";
  }

  return primary;
}

/**
 * Did the operator ask for generated ad imagery? Only their words may start a
 * batch — UI copy like "Generate images here" must not count.
 */
export function mentionsCreativeGeneration(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  const imagery =
    /\b(?:generat|render|produc|creat|mak|design)\w*\b[^.\n]{0,40}\b(?:images?|stills?|visuals?|(?:image|creative|visual)\s+variations?)\b/i;
  const explicit =
    /\b(?:generate|generating|render|rendering|produce|producing)\b[^.\n]{0,40}\b(?:creatives?|ad\s+images?)\b/i;
  return imagery.test(text) || explicit.test(text);
}

/**
 * Build a request-specific progress checklist (ChatGPT-style dynamic steps).
 */
export function planTaskSteps(
  request: string,
  intentOverride?: RequestIntent,
): TaskStep[] {
  const intent = intentOverride ?? detectRequestIntent(request);
  const base: TaskStep[] = [
    { id: "queued", label: "Queued", state: "pending" },
    { id: "research", label: "Context research", state: "pending" },
  ];

  switch (intent) {
    case "custom":
      return [
        ...base,
        { id: "pull_insights", label: "Pull the requested data", state: "pending" },
        { id: "write_report", label: "Build the answer", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "chat":
    case "followup":
      return [
        { id: "queued", label: "Queued", state: "pending" },
        { id: "write_report", label: "Answer", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "audit":
      return [
        ...base,
        {
          id: "clarify_brief",
          label: "Confirm scope, dates & competitor LPs",
          state: "pending",
        },
        { id: "fetch_overview", label: "Fetch account overview", state: "pending" },
        { id: "list_campaigns", label: "List Meta campaigns", state: "pending" },
        {
          id: "pull_insights",
          label: "Pull spend & performance",
          state: "pending",
        },
        {
          id: "landing_pages",
          label: "Analyse landing pages",
          state: "pending",
        },
        {
          id: "apply_framework",
          label: "Apply audit checklist",
          state: "pending",
        },
        { id: "write_report", label: "Write audit report", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "strategy":
      return [
        ...base,
        { id: "clarify_brief", label: "Confirm the goal & budget", state: "pending" },
        { id: "fetch_overview", label: "Fetch account overview", state: "pending" },
        { id: "pull_insights", label: "Pull spend & return by category", state: "pending" },
        { id: "build_plan", label: "Build the plan", state: "pending" },
        { id: "write_report", label: "Write strategy", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "list_campaigns":
      return [
        ...base,
        { id: "list_campaigns", label: "List Meta campaigns", state: "pending" },
        { id: "write_report", label: "Summarize campaigns", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "budget":
      return [
        ...base,
        { id: "diagnose", label: "Inspect budgets / delivery", state: "pending" },
        { id: "write_report", label: "Draft recommendation", state: "pending" },
        { id: "approval", label: "Queue Approvals (if needed)", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "generate_creatives":
      return [
        ...base,
        { id: "intake", label: "Collect creative brief", state: "pending" },
        { id: "generate_creatives", label: "Generate image stills", state: "pending" },
        { id: "pick_creative", label: "Review & select creative", state: "pending" },
        { id: "complete", label: "Await next instruction", state: "pending" },
      ];
    case "create_campaign":
      return [
        ...base,
        { id: "format_choice", label: "Choose image or video", state: "pending" },
        { id: "intake", label: "Collect campaign brief", state: "pending" },
        { id: "advanced_targeting", label: "Custom audiences & detailed targeting", state: "pending" },
        { id: "creative_asset", label: "Creative URL or generate (image)", state: "pending" },
        { id: "queue_create", label: "Queue campaign create (Approvals)", state: "pending" },
        { id: "proof_campaign", label: "Confirm campaign proof IDs", state: "pending" },
        { id: "ask_website", label: "Ask for website URL", state: "pending" },
        { id: "scrape_services", label: "Scan website services", state: "pending" },
        { id: "pick_services", label: "Operator picks services", state: "pending" },
        { id: "queue_adsets_ads", label: "Queue ad sets + ads", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "scrape_services":
      return [
        ...base,
        { id: "scrape_services", label: "Scrape website services", state: "pending" },
        { id: "pick_services", label: "Present services to pick", state: "pending" },
        { id: "write_report", label: "Next-step guidance", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "ad_copy":
      return [
        ...base,
        { id: "intake", label: "Collect copy brief", state: "pending" },
        { id: "generate_copy", label: "Generate ad copy variants", state: "pending" },
        { id: "pick_copy", label: "Present copies to pick", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "copy_approved":
      return [
        ...base,
        { id: "pick_copy", label: "Confirm approved copy", state: "pending" },
        { id: "complete", label: "Await next instruction", state: "pending" },
      ];
    case "optimize":
      return [
        ...base,
        { id: "list_ads", label: "List account ads", state: "pending" },
        { id: "pick_ad", label: "Pick an ad (creative refresh only)", state: "pending" },
        { id: "optimize", label: "Review live budgets, creative and tracking", state: "pending" },
        { id: "write_report", label: "Present recommendations", state: "pending" },
        { id: "approval", label: "Queue Approvals (if needed)", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "export":
      return [
        ...base,
        { id: "gather", label: "Gather chat + Meta evidence", state: "pending" },
        { id: "draft_report", label: "Draft report (OpenAI)", state: "pending" },
        { id: "write_report", label: "Format report for display", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    case "out_of_scope":
      return [
        ...base,
        { id: "write_report", label: "Scope reminder", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
    default:
      return [
        ...base,
        { id: "diagnose", label: "Gather client Meta context", state: "pending" },
        { id: "write_report", label: "Respond", state: "pending" },
        { id: "complete", label: "Complete", state: "pending" },
      ];
  }
}

export function setStepState(
  steps: TaskStep[],
  id: string,
  state: TaskStepState,
): TaskStep[] {
  return steps.map((s) => (s.id === id ? { ...s, state } : s));
}

export function activateStep(steps: TaskStep[], id: string): TaskStep[] {
  if (!steps.some((s) => s.id === id)) return steps;
  return steps.map((s) => {
    if (s.id === id) return { ...s, state: "active" as const };
    if (s.state === "active") return { ...s, state: "done" as const };
    return s;
  });
}

export function failStep(steps: TaskStep[], id: string): TaskStep[] {
  return steps.map((s) =>
    s.id === id ? { ...s, state: "error" as const } : s,
  );
}

export function completeStepsThrough(steps: TaskStep[], id: string): TaskStep[] {
  const idx = steps.findIndex((s) => s.id === id);
  if (idx < 0) return steps;
  return steps.map((s, i) => {
    if (i < idx) return { ...s, state: s.state === "error" ? s.state : "done" };
    if (i === idx) return { ...s, state: "done" };
    return s;
  });
}

export function markRemainingSkipped(steps: TaskStep[]): TaskStep[] {
  return steps.map((s) =>
    s.state === "pending" || s.state === "active" || s.state === "waiting"
      ? { ...s, state: "skipped" as const }
      : s,
  );
}

/**
 * A turn that ends by asking the operator something has not finished its plan.
 * Park the step in progress as waiting and leave the downstream steps pending —
 * flipping them to "done" made the checklist claim a campaign had been created
 * while the agent was still collecting the brief.
 */
export function holdStepsForOperator(steps: TaskStep[]): TaskStep[] {
  return steps.map((s) =>
    s.state === "active" ? { ...s, state: "waiting" as const } : s,
  );
}

/**
 * Does the reply end by asking the operator something? Only the closing
 * paragraph counts — a "?" inside a URL (`?utm_source=`), code, a table, or an
 * earlier rhetorical question must not park the task as "waiting on you".
 */
export function replyAwaitsOperator(reply: string | null | undefined): boolean {
  if (!reply) return false;
  const cleaned = reply
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<details>[\s\S]*?<\/details>/gi, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ");
  const paragraphs = cleaned
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    // Separators and table rows are layout, not the closing thought.
    .filter((p) => p && !/^(?:-{3,}|\*{3,}|_{3,})$/.test(p))
    .filter((p) => !/^\|[\s\S]*\|$/.test(p));
  const last = paragraphs.at(-1);
  if (!last) return false;
  const lines = last
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // A closing list of questions ("1. Budget? 2. Audience?") is still a question.
  if (lines.length > 1 && lines.some((l) => /\?\s*[*_)]*\s*$/.test(l))) {
    return true;
  }
  const finalSentence =
    last
      .replace(/[*_]+/g, "")
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean)
      .at(-1) ?? "";
  return /\?\s*["')\]]*\s*$/.test(finalSentence.trim());
}
