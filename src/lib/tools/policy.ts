import type { ToolSafetyClass } from "@/types";
import { ToolClassificationError } from "@/lib/errors";

/**
 * Explicit safety registry. Unknown tools are BLOCKED (fail closed).
 * The policy gate is authoritative — LLM prompts are advisory only.
 */
const TOOL_POLICY: Record<string, ToolSafetyClass> = {
  // Diagnose
  list_campaigns: "diagnose",
  get_campaign_insights: "diagnose",
  get_account_insights: "diagnose",
  list_adsets: "diagnose",
  list_ads: "diagnose",
  analyze_account: "diagnose",
  get_account_overview: "diagnose",
  scrape_website_services: "diagnose",
  generate_ad_copies: "diagnose",
  get_meta_ad_creatives: "diagnose",
  analyze_brand_url: "diagnose",
  optimize_meta_budget: "diagnose",
  optimize_meta_placements: "diagnose",
  detect_meta_creative_fatigue: "diagnose",
  list_competitor_ads_v2: "diagnose",

  // Execute
  update_adset_budget: "execute",
  pause_campaign: "execute",
  resume_campaign: "execute",
  create_campaign: "execute",
  create_meta_image_campaign: "execute",
  create_meta_video_campaign: "execute",
  create_meta_image_campaign_v2: "execute",
  create_meta_video_campaign_v2: "execute",
  optimize_meta_budget_v2: "execute",
  optimize_meta_placements_v2: "execute",
  create_adset: "execute",
  create_ad: "execute",
  pause_ad: "execute",
};

export function classify(toolName: string): ToolSafetyClass {
  const safety = TOOL_POLICY[toolName];
  if (!safety) return "blocked";
  return safety;
}

export function assertNotBlocked(toolName: string): ToolSafetyClass {
  const safety = classify(toolName);
  if (safety === "blocked") {
    throw new ToolClassificationError(`Tool is blocked: ${toolName}`, {
      toolName,
    });
  }
  return safety;
}

export function listClassifiedTools(): Array<{
  name: string;
  safety: ToolSafetyClass;
}> {
  return Object.entries(TOOL_POLICY).map(([name, safety]) => ({ name, safety }));
}

export function getPolicyMap(): Readonly<Record<string, ToolSafetyClass>> {
  return TOOL_POLICY;
}
