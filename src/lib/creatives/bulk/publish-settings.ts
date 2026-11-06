import type { CampaignSettings } from "@/lib/meta/campaign-rules";

/**
 * The campaign settings card's answers as create arguments. The budget level becomes the campaign-budget
 * flag; everything else is passed through as chosen, with empty lists left out.
 */
export function settingsToArgs(settings: CampaignSettings | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!settings) return out;
  const { budget_level, ...rest } = settings;
  if (budget_level) out.campaign_budget_optimization = budget_level === "campaign";
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

/** The objectives the settings card and the create flow support. */
export const PUBLISH_OBJECTIVES: Array<{ value: string; label: string; hint: string }> = [
  { value: "OUTCOME_TRAFFIC", label: "Traffic", hint: "Send people to the landing page" },
  { value: "OUTCOME_LEADS", label: "Leads", hint: "Collect enquiries (needs a pixel or an instant form)" },
  { value: "OUTCOME_SALES", label: "Sales", hint: "Purchases or other conversions (needs a pixel)" },
  { value: "OUTCOME_ENGAGEMENT", label: "Engagement", hint: "Likes, comments, messages" },
  { value: "OUTCOME_AWARENESS", label: "Awareness", hint: "Reach as many people as possible" },
];
