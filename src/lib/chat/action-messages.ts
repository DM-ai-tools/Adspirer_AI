import type { CampaignSettings } from "@/lib/meta/campaign-rules";
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
    "",
    "I'm approving this copy only for now — not creating a campaign yet.",
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

const SETTING_LABELS: Record<string, string> = {
  budget_level: "Budget level",
  conversion_location: "Conversion location",
  optimization_goal: "Performance goal",
  pixel_event_name: "Conversion event",
  pixel_id: "Pixel",
  lead_form_id: "Lead form",
  attribution: "Attribution",
  age: "Age",
  publisher_platforms: "Platforms",
  facebook_positions: "Facebook placements",
  instagram_positions: "Instagram placements",
  device_platforms: "Devices",
  user_device: "Device models",
  user_os: "Operating systems",
};

/**
 * The card's confirmed choices as a chat message: readable lines for the
 * operator and the create args as JSON for the model to pass on verbatim.
 */
export function composeCampaignSettingsMessage(
  settings: CampaignSettings,
  labels: Partial<Record<keyof CampaignSettings, string>>,
): string {
  const { budget_level, ...rest } = settings;
  const args: Record<string, unknown> = {};
  if (budget_level) args.campaign_budget_optimization = budget_level === "campaign";
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || (Array.isArray(value) && !value.length)) continue;
    args[key] = value;
  }

  const show = (key: keyof CampaignSettings): string => {
    const value = settings[key];
    return labels[key] ?? (Array.isArray(value) ? value.join(", ") : String(value));
  };
  const lines: string[] = [];
  for (const key of [
    "budget_level",
    "conversion_location",
    "optimization_goal",
    "pixel_event_name",
    "pixel_id",
    "lead_form_id",
    "attribution",
  ] as const) {
    if (settings[key]) lines.push(`${SETTING_LABELS[key]}: ${show(key)}`);
  }
  if (settings.age_min != null || settings.age_max != null) {
    lines.push(`${SETTING_LABELS.age}: ${settings.age_min ?? 18}–${settings.age_max ?? 65}`);
  }
  for (const key of [
    "publisher_platforms",
    "facebook_positions",
    "instagram_positions",
    "device_platforms",
    "user_device",
    "user_os",
  ] as const) {
    if (settings[key]?.length) lines.push(`${SETTING_LABELS[key]}: ${show(key)}`);
  }

  return [
    "Campaign settings selections:",
    Object.keys(args).length
      ? `\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``
      : "- (none)",
    lines.length ? "" : null,
    ...lines.map((l) => `- ${l}`),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function composeSkipCampaignSettingsMessage(): string {
  return "Campaign settings selections: none. Keep the defaults for performance goal, attribution, age and placements.";
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

/** The operator supplied (or uploaded) the creative; the URL is the public HTTPS link. */
export function composeMediaUrlMessage(kind: "image" | "video", url: string): string {
  return kind === "image"
    ? `Use this image URL for the ad: ${url}`
    : `Use this video URL for the ad: ${url}`;
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
