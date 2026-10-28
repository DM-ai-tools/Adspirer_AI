/**
 * What an optimization step is, who can do it, and which tool does it when the
 * answer is "this app". The single source of truth: the writer's prompt block,
 * the "who does what" table and the checkpoint owner tags are all generated
 * from here, so they cannot drift apart.
 */

export const FOCUS_AREAS = [
  "budget",
  "bids",
  "placements",
  "audiences",
  "creative",
  "schedule",
  "tracking",
  "structure",
  "reactivation",
  "landing_page",
] as const;

export type Focus = (typeof FOCUS_AREAS)[number];

export type ActionOwner = "app" | "ads_manager" | "developer" | "landing_page" | "client";

export type Capability = {
  id: string;
  label: string;
  focus: Focus;
  owner: ActionOwner;
  /** The execute tool that does it; only for `owner: "app"` entries that map to one. */
  tool?: string;
  note: string;
};

export const CAPABILITIES: readonly Capability[] = [
  // ---- This app, through Approvals ----
  { id: "budget_adset", label: "Change an ad set's daily budget", focus: "budget", owner: "app", tool: "update_adset_budget", note: "Ad sets that hold their own daily budget." },
  { id: "budget_campaign", label: "Change a campaign's daily budget", focus: "budget", owner: "app", tool: "update_campaign_budget", note: "Campaigns that use a campaign budget (CBO / Advantage+ campaign budget)." },
  { id: "pause_adset", label: "Pause an ad set", focus: "budget", owner: "app", tool: "pause_adset", note: "Stops spend on an ad set that spends without results." },
  { id: "resume_adset", label: "Resume an ad set", focus: "reactivation", owner: "app", tool: "resume_adset", note: "Restarts spend; needs an admin to approve." },
  { id: "pause_campaign", label: "Pause a campaign", focus: "budget", owner: "app", tool: "pause_campaign", note: "Stops spend on a whole campaign." },
  { id: "resume_campaign", label: "Resume a campaign", focus: "reactivation", owner: "app", tool: "resume_campaign", note: "Restarts spend; needs an admin to approve." },
  { id: "pause_ad", label: "Pause an ad", focus: "creative", owner: "app", tool: "pause_ad", note: "Retires a fatigued or poor ad (never the only live ad in its ad set)." },
  { id: "resume_ad", label: "Resume an ad", focus: "creative", owner: "app", tool: "resume_ad", note: "Turns a paused ad back on inside its ad set's budget." },
  { id: "audience_exclusions", label: "Exclude audiences from an ad set", focus: "audiences", owner: "app", tool: "update_adset_audience_exclusions", note: "Exclude (or stop excluding) custom audiences such as existing customers; the rest of the targeting is kept." },
  { id: "placements", label: "Change an ad set's placements", focus: "placements", owner: "app", tool: "update_adset_placements", note: "Choose platforms and positions, or switch to automatic (Advantage+) placements; the rest of the targeting is kept." },
  { id: "bid_adset", label: "Change an ad set's bid strategy and cap", focus: "bids", owner: "app", tool: "update_adset_bid", note: "Cost cap, bid cap, minimum ROAS or no cap, for ad sets that hold their own budget; Meta restarts learning after a bid change." },
  { id: "schedule", label: "Change an ad set's end date or start", focus: "schedule", owner: "app", tool: "update_adset_schedule", note: "Move or clear an end date, or move the start of an ad set that has not started." },
  { id: "create_adset", label: "Create an ad set", focus: "structure", owner: "app", tool: "create_adset", note: "New ad sets are created PAUSED." },
  { id: "create_ad", label: "Create an ad", focus: "creative", owner: "app", tool: "create_ad", note: "New ads are created PAUSED; an existing ad's creative cannot be edited in place, so a replacement is a new ad plus pausing the old one." },
  { id: "create_image_campaign", label: "Create an image campaign", focus: "structure", owner: "app", tool: "create_meta_image_campaign", note: "Campaign, ad set and ad, created PAUSED." },
  { id: "create_video_campaign", label: "Create a video campaign", focus: "structure", owner: "app", tool: "create_meta_video_campaign", note: "Needs a video from the client; created PAUSED." },
  { id: "create_campaign", label: "Create an empty campaign", focus: "structure", owner: "app", tool: "create_campaign", note: "Created PAUSED." },
  { id: "creative_generation", label: "Write ad copy and generate ad images", focus: "creative", owner: "app", note: "Copy and images are produced in the chat; using them in Meta is a queued create." },

  // ---- Someone else ----
  { id: "tracking_setup", label: "Install or repair the Meta pixel, Conversions API and event de-duplication", focus: "tracking", owner: "developer", note: "Needs access to the website or tag manager." },
  { id: "event_matching", label: "Events Manager settings (advanced matching, unused pixels)", focus: "tracking", owner: "ads_manager", note: "Changed in Events Manager." },
  { id: "attribution_window", label: "Align attribution settings on existing ad sets", focus: "tracking", owner: "ads_manager", note: "Changed on the ad set in Ads Manager." },
  { id: "landing_page_quality", label: "Fix landing page speed, message match or form friction", focus: "landing_page", owner: "landing_page", note: "Needs whoever edits the landing page." },
  { id: "naming_archive", label: "Rename or archive campaigns", focus: "structure", owner: "ads_manager", note: "Done in Ads Manager." },
  { id: "audience_health", label: "Rebuild, broaden or refresh audiences", focus: "audiences", owner: "ads_manager", note: "Done in Ads Manager or Audiences." },
  { id: "ad_policy_appeal", label: "Appeal or fix a rejected ad", focus: "creative", owner: "ads_manager", note: "Appealed in Ads Manager." },
  { id: "url_tags_existing", label: "Add UTM tags to existing ads", focus: "tracking", owner: "ads_manager", note: "An existing ad's URL parameters are edited in Ads Manager." },
  { id: "cbo_bids", label: "Change the bid strategy of a campaign-budget campaign", focus: "bids", owner: "ads_manager", note: "Bid strategy for campaign-budget campaigns is set on the campaign in Ads Manager." },
  { id: "edit_discipline", label: "Avoid edits that reset learning", focus: "structure", owner: "client", note: "A working agreement, not a setting." },
  { id: "account_billing", label: "Fix payment, account status or the account spending limit", focus: "structure", owner: "client", note: "Billing and Business Settings." },
  { id: "video_production", label: "Produce video and new creative formats", focus: "creative", owner: "client", note: "The app does not generate video." },
  { id: "targets_and_offer", label: "Set budget targets, margins and the offer", focus: "structure", owner: "client", note: "A business decision." },
];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** Which optimization areas a tool serves (used to match a queue request to proposals). */
const TOOL_FOCUS: Record<string, Focus[]> = {
  update_adset_budget: ["budget"],
  update_campaign_budget: ["budget"],
  pause_adset: ["budget"],
  pause_campaign: ["budget"],
  resume_adset: ["reactivation"],
  resume_campaign: ["reactivation"],
  pause_ad: ["creative"],
  resume_ad: ["reactivation"],
  update_adset_schedule: ["schedule"],
  update_adset_bid: ["bids"],
  update_adset_placements: ["placements"],
  update_adset_audience_exclusions: ["audiences"],
  create_ad: ["creative", "structure"],
  create_adset: ["structure"],
  create_campaign: ["structure"],
  create_meta_image_campaign: ["structure"],
  create_meta_video_campaign: ["structure"],
};

export function focusesOfTool(tool: string): Focus[] {
  return TOOL_FOCUS[tool] ? [...TOOL_FOCUS[tool]] : [];
}

/** What an operator calls a change: spending more, spending less, stopping, restarting. */
export const CHANGE_KINDS = ["increase", "decrease", "pause", "resume"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** What a tool does to an entity. "create" tools never answer an instruction to change something. */
export type ToolKind = "pause" | "resume" | "budget" | "schedule" | "bid" | "placements" | "audiences" | "create";

const TOOL_KIND: Record<string, ToolKind> = {
  pause_adset: "pause",
  pause_campaign: "pause",
  pause_ad: "pause",
  resume_adset: "resume",
  resume_campaign: "resume",
  resume_ad: "resume",
  update_adset_budget: "budget",
  update_campaign_budget: "budget",
  update_adset_schedule: "schedule",
  update_adset_bid: "bid",
  update_adset_placements: "placements",
  update_adset_audience_exclusions: "audiences",
  create_ad: "create",
  create_adset: "create",
  create_campaign: "create",
  create_meta_image_campaign: "create",
  create_meta_video_campaign: "create",
};

/** null for a tool this map does not know: it is never treated as a change the operator asked for. */
export function toolKindOf(tool: string): ToolKind | null {
  return TOOL_KIND[tool] ?? null;
}

/** Checkpoint id → the capability whose owner has to fix it. */
const CHECKPOINT_CAPABILITY: Record<string, string> = {
  T1: "tracking_setup",
  T2: "tracking_setup",
  T3: "tracking_setup",
  T4: "tracking_setup",
  T5: "tracking_setup",
  T6: "tracking_setup",
  T7: "event_matching",
  T8: "attribution_window",
  T9: "tracking_setup",
  T10: "event_matching",
  S1: "resume_adset",
  S2: "create_ad",
  S3: "naming_archive",
  S4: "naming_archive",
  S5: "account_billing",
  B1: "budget_adset",
  B2: "edit_discipline",
  B3: "budget_adset",
  B4: "cbo_bids",
  B5: "account_billing",
  B6: "budget_adset",
  B7: "budget_adset",
  A1: "audience_health",
  A2: "audience_exclusions",
  A3: "audience_health",
  A4: "placements",
  A5: "placements",
  C1: "ad_policy_appeal",
  C2: "creative_generation",
  C3: "video_production",
  C4: "pause_ad",
  C5: "url_tags_existing",
  C6: "create_ad",
  C7: "video_production",
  F1: "create_adset",
  F2: "budget_adset",
  F3: "budget_adset",
  F4: "creative_generation",
  F5: "landing_page_quality",
};

export function ownerForCheckpoint(id: string): { owner: ActionOwner; capabilityId: string } {
  const capabilityId = CHECKPOINT_CAPABILITY[id];
  const capability = capabilityId ? BY_ID.get(capabilityId) : undefined;
  if (!capability) throw new Error(`No owner is mapped for checkpoint ${id}.`);
  return { owner: capability.owner, capabilityId: capability.id };
}

export function ownerLabel(owner: ActionOwner): string {
  switch (owner) {
    case "app":
      return "this app";
    case "ads_manager":
      return "someone in Ads Manager";
    case "developer":
      return "a developer";
    case "landing_page":
      return "the landing page owner";
    case "client":
      return "the client";
  }
}

/** The capability list the writer is given: what Approvals can change, and what needs someone else. */
export function capabilityPromptBlock(): string {
  const app = CAPABILITIES.filter((c) => c.owner === "app");
  const others = CAPABILITIES.filter((c) => c.owner !== "app");
  return [
    "## What can be done, and by whom",
    "Say which steps this app can do and which need someone else. Never list a step as doable in the app unless it is in the first list.",
    "",
    "Changes this app can queue in Approvals (nothing changes in Meta until approved):",
    ...app.map((c) => `- ${c.label}${c.tool ? ` (\`${c.tool}\`)` : ""}: ${c.note}`),
    "",
    "Needs someone else (name who):",
    ...others.map((c) => `- ${c.label} — ${ownerLabel(c.owner)}. ${c.note}`),
  ].join("\n");
}
