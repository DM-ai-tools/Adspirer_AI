import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/observability/logger";
import { DEFAULT_CHAT_TITLE } from "@/lib/agent/title-format";

export {
  DEFAULT_CHAT_TITLE,
  DEFAULT_V2_CHAT_TITLE,
  V2_CHAT_TITLE_PREFIX,
  isDefaultConversationTitle,
  isV2ChatTitle,
  withV2ChatTitle,
} from "@/lib/agent/title-format";

/** Extra signals that make a title specific to this thread. */
export type ChatTitleContext = {
  /** Client (brand) the conversation belongs to. */
  clientName?: string | null;
  /** Campaign / ad / account names mentioned in or relevant to the request. */
  entityNames?: string[];
  /** Short excerpt of the first assistant reply (for canned starter prompts). */
  replyExcerpt?: string | null;
};

/** Filler words that make every thread look the same in the sidebar. */
const GENERIC_TITLE_WORDS =
  /\b(?:recent|latest|request|requests|inquiry|enquiry|query|chat|conversation|assistance|help|session|discussion)\b/gi;

function fallbackTitle(prompt: string, context?: ChatTitleContext): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return DEFAULT_CHAT_TITLE;
  const base = cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned;
  const client = context?.clientName?.trim();
  return client && !base.toLowerCase().includes(client.toLowerCase())
    ? `${client} · ${base}`
    : base;
}

/** Strip quotes, generic filler words and trailing punctuation. */
export function cleanChatTitle(raw: string): string {
  return raw
    .replace(/^["'“”\s]+|["'“”\s]+$/g, "")
    .replace(GENERIC_TITLE_WORDS, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s·:,-]+|[\s·:,.!?-]+$/g, "")
    .trim()
    .slice(0, 80);
}

/**
 * Generate a short, specific conversation title (one cheap model call).
 * Uses the client name and any campaign / ad names so threads for the same
 * client do not all read "Campaign Audit Request".
 */
export async function generateChatTitle(
  prompt: string,
  context?: ChatTitleContext,
): Promise<string> {
  const config = getConfig();
  if (!config.hasOpenAI || !config.OPENAI_API_KEY) {
    return fallbackTitle(prompt, context);
  }

  const entityNames = (context?.entityNames ?? [])
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 6);
  const reply = context?.replyExcerpt
    ?.replace(/[#*_`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

  try {
    const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
    const { text } = await generateText({
      model: openai(config.OPENAI_MODEL),
      temperature: 0.3,
      maxOutputTokens: 30,
      system: [
        "You name chat threads in an agency's Meta Ads workspace.",
        "Reply with ONE specific title of 3–6 words and nothing else.",
        "Lead with the client, campaign, or ad name when one is given, then the topic (e.g. \"TR Lead Gen budget review\", \"Echelonn creative audit\").",
        "Never use generic words such as Recent, Latest, Request, Inquiry, Chat, Help, or Session.",
        "No quotes, no emojis, no trailing punctuation.",
      ].join(" "),
      prompt: [
        context?.clientName ? `Client: ${context.clientName}` : null,
        entityNames.length
          ? `Names mentioned: ${entityNames.join("; ")}`
          : null,
        `Operator's first message: ${prompt.slice(0, 800)}`,
        reply ? `Start of the assistant's reply: ${reply}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    });

    const title = cleanChatTitle(text);
    return title.split(" ").length >= 2 ? title : fallbackTitle(prompt, context);
  } catch (error) {
    logger.warn("OpenAI chat title generation failed; using fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackTitle(prompt, context);
  }
}
