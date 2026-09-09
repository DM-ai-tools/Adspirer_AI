import type { Message } from "@/types";

/** High-level chat intent inferred from recent user messages (newest first). */
export type ConversationFlow =
  | "ad_copy"
  | "creative_images"
  | "create_campaign"
  | "scrape_services"
  | "optimize"
  | "general";

function isCreateCampaignAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (/\bcreate_meta_/.test(t)) return true;
  if (/\bi want an (image|video) ad\/campaign\b/.test(t)) return true;
  if (/\b(image|video)\s+ad\b/.test(t) && /\b(create|build|launch)\b/.test(t)) {
    return true;
  }
  if (/\b(create|build|launch|publish)\b/.test(t) && /\bcampaign\b/.test(t)) {
    return true;
  }
  if (
    /\b(create|build|launch)\b/.test(t) &&
    /\bads?\b/.test(t) &&
    !/\b(ad\s*cop(?:y|ies)|copies|headlines?|primary text|script|images?|stills?|creatives?)\b/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

function isCreativeImageAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (
    /\b(generate|create|make|produce|design)\b/.test(t) &&
    /\b(images?|stills?|creatives?|visuals?)\b/.test(t)
  ) {
    return true;
  }
  if (
    /\b(images?|stills?|creatives?)\b/.test(t) &&
    /\b(generate|create|make|reference|brand)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

function isAdCopyAsk(text: string): boolean {
  const t = text.toLowerCase();
  if (
    /\b(ad\s*cop(?:y|ies)|write copy|generate copy|copy variants|recreate.*copy)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(headline|primary text|video script|scripts?)\b/.test(t) &&
    !isCreateCampaignAsk(t) &&
    !isCreativeImageAsk(t)
  ) {
    return true;
  }
  return false;
}

function earlierCreateCampaignIntent(
  messages: readonly Message[],
  beforeIndex: number,
): boolean {
  for (let j = beforeIndex - 1; j >= 0; j -= 1) {
    const m = messages[j];
    if (m.role !== "user") continue;
    if (isCreateCampaignAsk(m.content)) return true;
    if (
      (isAdCopyAsk(m.content) || isCreativeImageAsk(m.content)) &&
      !isCreateCampaignAsk(m.content)
    ) {
      return false;
    }
  }
  return false;
}

/**
 * Infer what the operator is doing so we only show UI that matches their path.
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
      if (earlierCreateCampaignIntent(messages, i)) {
        return "create_campaign";
      }
      return "ad_copy";
    }
    if (
      /\badvanced targeting selections\b/.test(text) ||
      /\bskip advanced targeting\b/.test(text) ||
      /\buse broad\b.*\badvantage\+/i.test(m.content)
    ) {
      return "create_campaign";
    }
    if (isCreativeImageAsk(text) && !isCreateCampaignAsk(text)) {
      return "creative_images";
    }
    if (isAdCopyAsk(text) && !isCreateCampaignAsk(text)) {
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
    if (isCreateCampaignAsk(text)) {
      return "create_campaign";
    }
  }
  return "general";
}

/** Format / video / targeting pickers only on an explicit campaign-create path. */
export function showCampaignCreativeUi(flow: ConversationFlow): boolean {
  return flow === "create_campaign";
}

/** Image generate/choice UI for campaign create OR standalone image asks. */
export function showImageChoiceUi(flow: ConversationFlow): boolean {
  return flow === "create_campaign" || flow === "creative_images";
}
