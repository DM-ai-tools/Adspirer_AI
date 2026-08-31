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

function fallbackTitle(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) return DEFAULT_CHAT_TITLE;
  return cleaned.length > 56 ? `${cleaned.slice(0, 56)}…` : cleaned;
}

/**
 * Generate a short ChatGPT-style conversation title from the first user message.
 */
export async function generateChatTitle(prompt: string): Promise<string> {
  const config = getConfig();
  if (!config.hasOpenAI || !config.OPENAI_API_KEY) {
    return fallbackTitle(prompt);
  }

  try {
    const openai = createOpenAI({ apiKey: config.OPENAI_API_KEY });
    const { text } = await generateText({
      model: openai(config.OPENAI_MODEL),
      temperature: 0.4,
      maxOutputTokens: 40,
      system:
        "You name chat threads. Reply with a concise 3–7 word title only. No quotes, no punctuation at the end, no emojis.",
      prompt: `Name this Meta Ads operator chat based on the first request:\n\n${prompt.slice(0, 1200)}`,
    });

    const title = text
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    return title || fallbackTitle(prompt);
  } catch (error) {
    logger.warn("OpenAI chat title generation failed; using fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackTitle(prompt);
  }
}
