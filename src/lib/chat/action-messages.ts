import {
  targetingSelectionToCreateArgs,
  type CampaignTargetingSelection,
} from "@/lib/adspirer/targeting";

export type CopyVariant = {
  id: string;
  angle: string;
  primary_text: string;
  headline: string;
  description?: string;
  cta?: string;
};

export type ServiceOption = {
  id: string;
  name: string;
  description?: string;
};

/** User-facing message when a copy variant is approved (no agent directives). */
export function composeCopyApprovedMessage(picked: CopyVariant): string {
  return [
    `Approved ad copy variant ${picked.id} (${picked.angle}):`,
    `- Headline: ${picked.headline}`,
    `- Primary text: ${picked.primary_text}`,
    picked.description ? `- Description: ${picked.description}` : null,
    picked.cta ? `- CTA: ${picked.cta}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function composeTargetingMessage(
  selection: CampaignTargetingSelection,
): string {
  const args = targetingSelectionToCreateArgs(selection);
  const labels: string[] = [];
  if (selection.custom_audiences.length) {
    labels.push(
      `Custom audiences: ${selection.custom_audiences.map((a) => a.name).join(", ")}`,
    );
  }
  if (selection.interests.length) {
    labels.push(
      `Interests: ${selection.interests.map((i) => i.name).join(", ")}`,
    );
  }
  if (selection.behaviors.length) {
    labels.push(
      `Behaviors: ${selection.behaviors.map((b) => b.name).join(", ")}`,
    );
  }
  if (selection.locations.length) {
    labels.push(
      `Locations: ${selection.locations.map((l) => l.name).join(", ")}`,
    );
  }
  if (selection.publisher_platforms.length) {
    labels.push(`Placements: ${selection.publisher_platforms.join(", ")}`);
  }

  return [
    "Advanced targeting selections:",
    Object.keys(args).length
      ? `\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
      : "- (none)",
    labels.length ? "" : null,
    ...labels.map((l) => `- ${l}`),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function composeSkipTargetingMessage(): string {
  return "Skip advanced targeting — use broad / Advantage+ defaults (no custom_audiences or detailed interests/behaviors/locations).";
}

export function composeServicesMessage(services: ServiceOption[]): string {
  const lines = services.map(
    (s) =>
      `- ${s.id}: ${s.name}${s.description ? ` (${s.description})` : ""}`,
  );
  return ["Selected services:", ...lines].join("\n");
}

export function composeOptimizeAdMessage(ad: {
  id: string;
  name: string;
}): string {
  return `Optimize ad ${ad.id} (${ad.name}).`;
}

export function composeFormatChoiceMessage(format: "image" | "video"): string {
  return format === "image"
    ? "I want an image ad/campaign."
    : "I want a video ad/campaign.";
}

export function composeImageSourceMessage(
  source: "url" | "generate",
): string {
  return source === "url"
    ? "I have an image URL or Meta image hash."
    : "Generate image creatives from my ad copy and landing page.";
}

export function composeVideoSourceMessage(
  source: "url" | "meta_id",
): string {
  return source === "url"
    ? "I have a public video URL."
    : "I have an existing Meta video ID.";
}

/**
 * Merge new picker text into the composer without auto-sending.
 * Replaces a prior block from the same picker when the user edits again.
 */
export function mergeComposerDraft(
  current: string,
  block: string,
  marker: string,
): string {
  const start = `<!-- ${marker} -->`;
  const end = `<!-- /${marker} -->`;
  const wrapped = `${start}\n${block.trim()}\n${end}`;
  const pattern = new RegExp(
    `${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "g",
  );
  const stripped = current.replace(pattern, "").trim();
  return stripped ? `${stripped}\n\n${wrapped}` : wrapped;
}

/** Strip HTML comment markers before sending to the agent. */
export function stripComposerMarkers(text: string): string {
  return text
    .replace(/<!--\s*\/?[\w-]+\s*-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
