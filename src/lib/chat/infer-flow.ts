import type { Message } from "@/types";

/** High-level chat intent inferred from recent user messages (newest first). */
export type ConversationFlow =
  | "ad_copy"
  | "create_campaign"
  | "scrape_services"
  | "optimize"
  | "general";

/**
 * Infer what the operator is doing so we only show UI that matches their path.
 * Prevents e.g. creative pickers appearing during an ad-copy-only flow.
 */
export function inferConversationFlow(
  messages: readonly Message[],
): ConversationFlow {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const text = m.content.toLowerCase();

    if (
      /\bapproved ad copy variant\b/.test(text) ||
      /\buse approved ad copy variant\b/.test(text)
    ) {
      return "ad_copy";
    }
    if (
      /\badvanced targeting selections\b/.test(text) ||
      /\bskip advanced targeting\b/.test(text) ||
      /\buse broad\b.*\badvantage\+/i.test(m.content)
    ) {
      return "ad_copy";
    }
    if (
      /\b(ad copy|write copy|generate copy|copy variants|headline|primary text)\b/.test(
        text,
      ) &&
      !/\bcreate\b.*\bcampaign\b/.test(text)
    ) {
      return "ad_copy";
    }
    if (
      /\boptimize selected ad\b/.test(text) ||
      (/\boptimiz/.test(text) && /\bselected ad\b/.test(text))
    ) {
      return "optimize";
    }
    if (
      /\bcreate paused ad sets\b/.test(text) ||
      /\bselected services\b/.test(text)
    ) {
      return "scrape_services";
    }
    if (
      /\b(image|video) ad\b/.test(text) ||
      /\bcreate_meta_/.test(text) ||
      (/\bcreate\b/.test(text) && /\bcampaign\b/.test(text))
    ) {
      return "create_campaign";
    }
  }
  return "general";
}

/** Creative / format pickers only belong on an explicit campaign-create path. */
export function showCampaignCreativeUi(flow: ConversationFlow): boolean {
  return flow === "create_campaign";
}
