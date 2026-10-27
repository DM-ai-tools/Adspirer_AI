import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import type { AgentHistoryMessage } from "@/lib/agent/history";
import {
  detectRequestIntentWithHistory,
  type RequestIntent,
} from "@/lib/agent/task-plan";

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
  export: "Wants a downloadable report / PDF / Word document / summary of the session.",
  create_campaign:
    "Wants to build or launch a campaign, ad set or ad, or is mid-way through doing so (sending an image link, picking settings).",
  generate_creatives: "Wants ad images / creatives generated.",
  scrape_services: "Wants services or offerings pulled from a website.",
  ad_copy: "Wants ad copy, headlines or primary text written.",
  copy_approved: "Chose an approved ad copy variant.",
  general:
    "Any other question about the client's ads, spend, results, tracking, analytics (Meta, GA4, Search Console, Google Ads, Shopify) that needs fresh data.",
  chat: "Greeting, thanks, or a short definitional question needing no data.",
  out_of_scope: "Nothing to do with ads, analytics or this client's marketing.",
};

const INTENTS = Object.keys(INTENT_GUIDE) as RequestIntent[];

const CLASSIFY_TIMEOUT_MS = 5_000;
/** Earlier assistant turns are only needed for their shape, not their detail. */
const ASSISTANT_EXCERPT_CHARS = 700;
const USER_EXCERPT_CHARS = 500;
const HISTORY_TURNS = 6;

const SYSTEM = [
  "You route messages in an agency's Meta Ads workspace assistant. Read the operator's latest message IN CONTEXT of the recent conversation and pick what they actually want. Operators phrase things in their own words, with typos and shorthand; judge meaning, never keywords.",
  "Key rule: mentioning an earlier report (\"based on the audit\", \"from those findings\") means they want to USE it (followup), not run it again. Choose audit only when they want a new audit run or are answering the audit's own question.",
  "If the assistant's last message asked the operator a question (scope, dates, goal, budget, an image link), a short reply is most likely the answer to it and stays on that flow.",
  "Intents:",
  ...INTENTS.map((i) => `- ${i}: ${INTENT_GUIDE[i]}`),
  'Reply with JSON only: {"intent":"<one of the names above>"}',
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
      maxOutputTokens: 40,
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
      maxOutputTokens: 40,
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
export async function classifyIntent(
  request: string,
  history: AgentHistoryMessage[] = [],
): Promise<RequestIntent> {
  try {
    const reply = await askModel(buildClassifierPrompt(request, history));
    const intent = reply ? parseIntentReply(reply) : null;
    if (intent) return intent;
  } catch (error) {
    logger.warn("Intent classifier failed; using keyword fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return detectRequestIntentWithHistory(request, history);
}
