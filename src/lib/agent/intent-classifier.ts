import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import type { RequestIntent } from "@/lib/agent/task-plan";
import {
  asksForOptimization,
  normalizeBrief,
  parseBriefReply,
  rulesBrief,
  type RequestBrief,
} from "@/lib/agent/request-brief";

/** Every intent the classifier may return, with what it means for the router. */
const INTENT_GUIDE: Record<RequestIntent, string> = {
  audit:
    "Asks to RUN a new (or re-run an) audit / health check / full review of the account or campaigns, or answers the audit's own scope / date / landing-page question. NOT a request to use an audit that is already in the chat.",
  followup:
    "Builds on a report or answer already in the chat and wants something derived from it: optimization steps, what to fix first, which recommendations you can do, explain a finding, prioritise, summarise one part. Needs no new data and must NOT repeat the report.",
  optimize:
    "Wants changes made or queued in Meta: optimize the ads / budget / placements, apply or queue recommendations to Approvals, pause or resume things.",
  strategy:
    "Wants a plan to reach a goal (leads, ROAS, budget) or answers the strategy brief's own question (goal, budget).",
  budget: "Asks about or wants to change budgets or bids.",
  list_campaigns: "Asks to list or show campaigns.",
  export: "Wants the conversation itself, or a report already in it, as a downloadable PDF / Word document. Not for new data: if they name metrics, a period or a breakdown to compile, that is custom.",
  create_campaign:
    "Wants to build or launch a campaign, ad set or ad, or is mid-way through doing so (sending an image link, picking settings).",
  generate_creatives: "Wants ad images / creatives generated.",
  scrape_services: "Wants services or offerings pulled from a website.",
  ad_copy: "Wants ad copy, headlines or primary text written.",
  copy_approved: "Chose an approved ad copy variant.",
  custom:
    "A specific deliverable or analysis the other intents do not exactly cover: named metrics or columns, a date range, a breakdown (per week, per day, per campaign, per placement), a chosen format such as an Excel sheet or table, or a comparison. The data must be fetched fresh and shaped to what they asked. Choose custom over forcing a near-fit such as audit or export.",
  general:
    "Any other question about the client's ads, spend, results, tracking, analytics (Meta, GA4, Search Console, Google Ads, Shopify) that needs fresh data.",
  chat:
    "Greeting, thanks, small talk, or a question answered from expertise without this client's data: definitions, how Meta features or the auction work, best practice, strategy advice in general, a second opinion on an idea, adjacent marketing questions (TikTok / LinkedIn / Google strategy in general, landing pages, offers, email). If the answer depends on THIS client's numbers or settings, it is general instead.",
  out_of_scope:
    "Nothing to do with marketing or advertising at all (weather, recipes, general coding, personal questions). Questions about other ad platforms, marketing in general, or things the workspace can't do yet are NOT out_of_scope: use chat or the matching intent.",
};

const INTENTS = Object.keys(INTENT_GUIDE) as RequestIntent[];

const CLASSIFY_TIMEOUT_MS = 8_000;
/** Room for the whole brief (intent, mode, focus, scope, queue selection). */
const CLASSIFY_MAX_OUTPUT_TOKENS = 400;
/** Earlier assistant turns are only needed for their shape, not their detail. */
const ASSISTANT_EXCERPT_CHARS = 700;
const USER_EXCERPT_CHARS = 500;
const HISTORY_TURNS = 6;

const SYSTEM = [
  "You route messages in an agency's Meta Ads workspace assistant. Read the operator's latest message IN CONTEXT of the recent conversation and pick what they actually want. Operators phrase things in their own words, with typos and shorthand; judge meaning, never keywords.",
  "Never force a request into the nearest intent. If it asks for something specific (particular metrics, a period, a breakdown, a file format), that is custom, even when it says \"report\". audit and export are only for a plain request to run an audit or to download the conversation.",
  "Key rule: mentioning an earlier report (\"based on the audit\", \"from those findings\") means they want to USE it (followup), not run it again. Choose audit only when they want a new audit run or are answering the audit's own question.",
  "If the assistant's last message asked the operator a question (scope, dates, goal, budget, an image link), a short reply is most likely the answer to it and stays on that flow.",
  "The workflows (audit, strategy, optimize, export, create_campaign, ad_copy, generate_creatives, scrape_services) run a fixed, heavy process: pick one only when the operator clearly wants that workflow. A question about performance, a \"why\", an opinion, a quick check, or a mix of things is general (needs this client's data) or chat (answered from expertise); those are answered conversationally and can still read any data. Asking what to optimise or fix across the account (or a named campaign) is still optimize, because that flow builds the numbered list of changes they can queue.",
  "Intents:",
  ...INTENTS.map((i) => `- ${i}: ${INTENT_GUIDE[i]}`),
  "Also read what the operator wants done, and reply with JSON only, exactly this shape:",
  '{"intent":"<one of the names above>","mode":"analyse|act","focus":[],"scope":[],"periodStated":false,"optimizationAsk":false,"queue":{"requested":false,"all":false,"refs":[],"focus":[],"entities":[]},"exclude":[]}',
  '- "mode": "act" ONLY when the operator asks for changes to be made or queued (pause, resume, change a budget, apply, queue, send to Approvals). A question, or asking what to optimise, is "analyse". When unsure, "analyse".',
  '- "focus": any of budget, bids, placements, audiences, creative, schedule, tracking, structure, reactivation, landing_page that the message is about. Empty when it names no area.',
  '- "scope": campaign, ad set or ad names or ids, copied exactly as the operator typed them. Empty when they mean the whole account.',
  '- "periodStated": true when the message itself gives a period (last 14 days, 1-15 Oct). Never write dates.',
  '- "optimizationAsk": true when they want optimisation steps, fixes or advice on what to change.',
  '- "queue": only when "mode" is "act". "refs" are proposal numbers they typed (#2 -> 2). "all" is true for "all of these / everything / them". "focus" is only for picking among proposals already shown ("queue the budget changes"); leave it empty for a direct instruction like "pause X" or "set the budget of X to 60". "entities" are the names they want changed.',
  '- "exclude": names the operator said not to touch.',
].join("\n");

function excerpt(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}… [${text.length} chars total]` : flat;
}

export function buildClassifierPrompt(
  request: string,
  history: AgentHistoryMessage[],
): string {
  const turns = history
    .filter((m) => m.role !== "system" && m.content.trim())
    .slice(-HISTORY_TURNS)
    .map((m) =>
      m.role === "assistant"
        ? `Assistant: ${excerpt(m.content, ASSISTANT_EXCERPT_CHARS)}`
        : `Operator: ${excerpt(m.content, USER_EXCERPT_CHARS)}`,
    );
  return [
    turns.length ? `Recent conversation:\n${turns.join("\n")}` : "Recent conversation: (none)",
    "",
    `Operator's latest message: ${request.slice(0, 1500)}`,
  ].join("\n");
}

export function parseIntentReply(reply: string): RequestIntent | null {
  const match = reply.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const value = (JSON.parse(match[0]) as { intent?: unknown }).intent;
    return typeof value === "string" && (INTENTS as string[]).includes(value)
      ? (value as RequestIntent)
      : null;
  } catch {
    return null;
  }
}

async function askModel(prompt: string): Promise<string | null> {
  const config = getConfig();
  const { generateText } = await import("ai");
  const abortSignal = AbortSignal.timeout(CLASSIFY_TIMEOUT_MS);
  if (config.hasOpenAI && config.OPENAI_API_KEY) {
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
    const { text } = await generateText({
      model: openai(config.OPENAI_MODEL),
      temperature: 0,
      maxOutputTokens: CLASSIFY_MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      prompt,
      abortSignal,
    });
    return text;
  }
  if (config.hasAnthropic && config.ANTHROPIC_API_KEY) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: config.ANTHROPIC_API_KEY });
    const { text } = await generateText({
      model: anthropic(config.ANTHROPIC_MODEL),
      temperature: 0,
      maxOutputTokens: CLASSIFY_MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      prompt,
      abortSignal,
    });
    return text;
  }
  return null;
}

/**
 * What the operator wants, decided by a model that reads the message with the
 * recent chat. The keyword rules in task-plan.ts are only the fallback for when
 * no model is configured or the call fails or times out.
 */
export async function classifyRequest(
  request: string,
  history: AgentHistoryMessage[] = [],
): Promise<RequestBrief> {
  let brief: RequestBrief | null = null;
  try {
    const reply = await askModel(buildClassifierPrompt(request, history));
    brief = reply ? parseBriefReply(reply, request, history) : null;
  } catch (error) {
    logger.warn("Intent classifier failed; using keyword fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // A model that only named the intent still gets the optimisation-ask check the rules make.
  const base = brief
    ? { ...brief, optimizationAsk: brief.optimizationAsk || asksForOptimization(request) }
    : rulesBrief(request, history);
  return normalizeBrief(base, request, history);
}

/** The intent alone (callers that do not need the rest of the brief). */
export async function classifyIntent(
  request: string,
  history: AgentHistoryMessage[] = [],
): Promise<RequestIntent> {
  return (await classifyRequest(request, history)).intent;
}
