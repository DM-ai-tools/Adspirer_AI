/**
 * Operator-facing labels for internal tool ids.
 * Keep raw tool_name in APIs/DB; never show snake_case tool ids in the UI.
 */

const TOOL_LABELS: Record<string, string> = {
  // Diagnose
  list_campaigns: "List campaigns",
  get_campaign_insights: "Pull campaign performance",
  get_account_insights: "Pull account performance",
  list_adsets: "List ad sets",
  list_ads: "List ads",
  analyze_account: "Account diagnostics",
  get_account_overview: "Account overview",
  scrape_website_services: "Scan website services",
  generate_ad_copies: "Generate ad copy",
  get_meta_ad_creatives: "Fetch ad creatives",
  analyze_landing_pages: "Analyse landing pages",
  analyze_brand_url: "Analyse brand URL",
  optimize_meta_budget: "Budget recommendations",
  optimize_meta_placements: "Placement recommendations",
  detect_meta_creative_fatigue: "Creative fatigue check",
  list_competitor_ads_v2: "List competitor ads",

  // Execute
  update_adset_budget: "Update ad set budget",
  pause_campaign: "Pause campaign",
  resume_campaign: "Resume campaign",
  create_campaign: "Create campaign",
  create_meta_image_campaign: "Create image campaign",
  create_meta_video_campaign: "Create video campaign",
  create_meta_image_campaign_v2: "Create image campaign",
  create_meta_video_campaign_v2: "Create video campaign",
  optimize_meta_budget_v2: "Apply budget change",
  optimize_meta_placements_v2: "Apply placement change",
  create_adset: "Create ad set",
  create_ad: "Create ad",
  pause_ad: "Pause ad",
};

/** Progress labels while a diagnose tool is running (keep task-style wording). */
const TOOL_PROGRESS_LABELS: Record<string, string> = {
  list_campaigns: "Listing campaigns…",
  get_campaign_insights: "Pulling campaign performance…",
  get_account_insights: "Pulling account performance…",
  list_adsets: "Listing ad sets…",
  list_ads: "Listing ads…",
  analyze_account: "Running account diagnostics…",
  get_account_overview: "Fetching account overview…",
  scrape_website_services: "Scanning website services…",
  generate_ad_copies: "Generating ad copy…",
  get_meta_ad_creatives: "Fetching ad creatives…",
  analyze_landing_pages: "Analysing landing pages…",
  analyze_brand_url: "Analysing brand URL…",
  optimize_meta_budget: "Reviewing budgets…",
  optimize_meta_placements: "Reviewing placements…",
  detect_meta_creative_fatigue: "Checking creative fatigue…",
  list_competitor_ads_v2: "Loading competitor ads…",
  update_adset_budget: "Preparing budget update…",
  pause_campaign: "Preparing pause…",
  resume_campaign: "Preparing resume…",
  create_campaign: "Preparing campaign create…",
  create_meta_image_campaign: "Preparing image campaign…",
  create_meta_video_campaign: "Preparing video campaign…",
  create_meta_image_campaign_v2: "Preparing image campaign…",
  create_meta_video_campaign_v2: "Preparing video campaign…",
  optimize_meta_budget_v2: "Preparing budget change…",
  optimize_meta_placements_v2: "Preparing placement change…",
  create_adset: "Preparing ad set create…",
  create_ad: "Preparing ad create…",
  pause_ad: "Preparing ad pause…",
};

function titleFromSnake(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\bv2\b/gi, "")
    .replace(/\bmeta\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/** Short action title for cards, approvals, audit summaries. */
export function humanToolLabel(toolName: string | null | undefined): string {
  if (!toolName?.trim()) return "Action";
  const key = toolName.trim();
  return TOOL_LABELS[key] ?? titleFromSnake(key);
}

/** Live status line while a tool runs. */
export function humanToolProgressLabel(
  toolName: string | null | undefined,
): string {
  if (!toolName?.trim()) return "Working…";
  const key = toolName.trim();
  return TOOL_PROGRESS_LABELS[key] ?? `${humanToolLabel(key)}…`;
}

/** Approval / activity status for operators. */
export function humanApprovalStatus(status: string | null | undefined): string {
  switch (status) {
    case "pending":
      return "Pending review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "edited":
      return "Edited";
    case "executing":
      return "Applying…";
    case "executed":
      return "Applied";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status?.trim() || "Unknown";
  }
}

export function humanRecommendationStatus(
  status: string | null | undefined,
): string {
  switch (status) {
    case "open":
      return "Open";
    case "accepted":
      return "Accepted";
    case "dismissed":
      return "Dismissed";
    case "expired":
      return "Expired";
    default:
      return status?.trim() || "Unknown";
  }
}
