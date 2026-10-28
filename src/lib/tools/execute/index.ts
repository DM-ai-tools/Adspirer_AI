import { registerTool } from "@/lib/tools/registry";
import { ApprovalRequiredError } from "@/lib/errors";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { getDemoStore } from "@/lib/demo/store";
import { getConfig } from "@/lib/config";
import { findMatchingApproval } from "@/lib/tools/execute/match-approval";
import { mapApprovalRow } from "@/lib/db/live-maps";
import {
  createAdSchema,
  createAdSetSchema,
  createCampaignSchema,
  createMetaImageCampaignSchema,
  createMetaVideoCampaignSchema,
  pauseAdSchema,
  pauseAdSetSchema,
  pauseCampaignSchema,
  resumeAdSchema,
  resumeAdSetSchema,
  resumeCampaignSchema,
  updateAdsetBudgetSchema,
  updateAdsetAudienceExclusionsSchema,
  updateAdsetBidSchema,
  updateAdsetPlacementsSchema,
  updateAdsetScheduleSchema,
  updateCampaignBudgetSchema,
} from "@/lib/tools/execute/schemas";

export { EXECUTE_TOOL_SCHEMAS, getExecuteToolSchema } from "@/lib/tools/execute/schemas";

/**
 * Execute tools never call the provider directly without a valid approved approval.
 * They resolve an approval (from ctx.approvalId or matching pending→approved record)
 * and route through the approval executor (idempotency + mode enforcement).
 */
async function requireAndExecute(
  toolName: string,
  args: Record<string, unknown>,
  ctx: { clientId: string; approvalId?: string; userId: string },
) {
  const approvalId = ctx.approvalId ?? (await findApprovedApprovalId(toolName, ctx.clientId, args));
  if (!approvalId) {
    throw new ApprovalRequiredError(
      `Execute tool "${toolName}" requires a valid approved approval before calling the provider`,
      { toolName, clientId: ctx.clientId },
    );
  }

  return executeApprovedAction({
    approvalId,
    executedBy: ctx.userId,
    overrideArgs: args,
  });
}

async function findApprovedApprovalId(
  toolName: string,
  clientId: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const config = getConfig();
  if (config.isDemoMode || !config.hasSupabase) {
    const match = getDemoStore().approvals.find(
      (a) =>
        a.client_id === clientId &&
        a.tool_name === toolName &&
        (a.status === "approved" || a.status === "edited") &&
        JSON.stringify(a.edited_args ?? a.proposed_args) === JSON.stringify(args),
    );
    return match?.id ?? null;
  }

  const { createAdminClient } = await import("@/lib/supabase/admin");
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("approvals")
    .select("*")
    .eq("client_id", clientId)
    .eq("tool_name", toolName)
    .in("status", ["approved", "edited"])
    .order("created_at", { ascending: false })
    .limit(20);

  // The table stores args as original_input / editable_input: map the rows.
  return findMatchingApproval(
    ((data ?? []) as Array<Record<string, unknown>>).map(mapApprovalRow),
    args,
  );
}

export const updateAdsetBudgetTool = registerTool({
  name: "update_adset_budget",
  description: "Update an ad set daily budget (requires approval)",
  inputSchema: updateAdsetBudgetSchema,
  async execute(args, ctx) {
    return requireAndExecute("update_adset_budget", args, ctx);
  },
});

export const pauseCampaignTool = registerTool({
  name: "pause_campaign",
  description: "Pause a campaign (requires approval)",
  inputSchema: pauseCampaignSchema,
  async execute(args, ctx) {
    return requireAndExecute("pause_campaign", args, ctx);
  },
});

export const resumeCampaignTool = registerTool({
  name: "resume_campaign",
  description: "Resume a paused campaign (requires approval)",
  inputSchema: resumeCampaignSchema,
  async execute(args, ctx) {
    return requireAndExecute("resume_campaign", args, ctx);
  },
});

export const createCampaignTool = registerTool({
  name: "create_campaign",
  description: "Create a new campaign (defaults to PAUSED; requires approval)",
  inputSchema: createCampaignSchema,
  async execute(args, ctx) {
    // New campaigns are created PAUSED by default.
    const normalized = { ...args, status: args.status ?? "PAUSED" };
    return requireAndExecute("create_campaign", normalized, ctx);
  },
});

export const createMetaImageCampaignTool = registerTool({
  name: "create_meta_image_campaign",
  description:
    "Create a paused Meta image campaign (+ ad set + ad) (requires approval). Needs locations and budget_daily or budget_lifetime + end_time.",
  inputSchema: createMetaImageCampaignSchema,
  async execute(args, ctx) {
    return requireAndExecute("create_meta_image_campaign", args, ctx);
  },
});

export const createMetaVideoCampaignTool = registerTool({
  name: "create_meta_video_campaign",
  description:
    "Create a paused Meta video campaign (+ ad set + ad) (requires approval). Needs video_url or existing_video_id, locations, and a budget.",
  inputSchema: createMetaVideoCampaignSchema,
  async execute(args, ctx) {
    return requireAndExecute("create_meta_video_campaign", args, ctx);
  },
});

export const createAdSetTool = registerTool({
  name: "create_adset",
  description:
    "Add a Meta ad set (requires approval). Requires ad_type, primary_text, landing_page_url and locations. For video use ad_type=video with video_url or existing_video_id. Creates PAUSED.",
  inputSchema: createAdSetSchema,
  async execute(args, ctx) {
    return requireAndExecute("create_adset", {
      ...args,
      ad_type: args.ad_type ?? "image",
    }, ctx);
  },
});

export const createAdTool = registerTool({
  name: "create_ad",
  description:
    "Add a Meta ad to an ad set (requires approval). For video ads set ad_type=video and pass video_url or existing_video_id.",
  inputSchema: createAdSchema,
  async execute(args, ctx) {
    return requireAndExecute("create_ad", args, ctx);
  },
});

export const pauseAdTool = registerTool({
  name: "pause_ad",
  description: "Pause an ad (requires approval)",
  inputSchema: pauseAdSchema,
  async execute(args, ctx) {
    return requireAndExecute("pause_ad", args, ctx);
  },
});

export const resumeAdTool = registerTool({
  name: "resume_ad",
  description: "Resume a paused ad so it can spend again (requires approval)",
  inputSchema: resumeAdSchema,
  async execute(args, ctx) {
    return requireAndExecute("resume_ad", args, ctx);
  },
});

export const updateCampaignBudgetTool = registerTool({
  name: "update_campaign_budget",
  description:
    "Update the daily budget of a campaign that uses a campaign budget (CBO / Advantage+ campaign budget) (requires approval). For campaigns whose ad sets hold the budgets, use update_adset_budget.",
  inputSchema: updateCampaignBudgetSchema,
  async execute(args, ctx) {
    return requireAndExecute("update_campaign_budget", args, ctx);
  },
});

export const updateAdsetScheduleTool = registerTool({
  name: "update_adset_schedule",
  description:
    "Change an ad set's end date (or clear it so it runs until paused), or move the start of an ad set that has not started (requires approval)",
  inputSchema: updateAdsetScheduleSchema,
  async execute(args, ctx) {
    return requireAndExecute("update_adset_schedule", args, ctx);
  },
});

export const updateAdsetBidTool = registerTool({
  name: "update_adset_bid",
  description:
    "Change an ad set's bid strategy: cost cap, bid cap, minimum ROAS or no cap (requires approval). Ad sets under a campaign budget are changed on the campaign in Ads Manager; Meta restarts learning after a bid change.",
  inputSchema: updateAdsetBidSchema,
  async execute(args, ctx) {
    return requireAndExecute("update_adset_bid", args, ctx);
  },
});

export const updateAdsetPlacementsTool = registerTool({
  name: "update_adset_placements",
  description:
    "Change where an ad set's ads run: choose platforms and positions, or switch to automatic (Advantage+) placements (requires approval). Only the placements change; the rest of the targeting is kept.",
  inputSchema: updateAdsetPlacementsSchema,
  async execute(args, ctx) {
    return requireAndExecute("update_adset_placements", args, ctx);
  },
});

export const updateAdsetAudienceExclusionsTool = registerTool({
  name: "update_adset_audience_exclusions",
  description:
    "Exclude (or stop excluding) custom audiences on an ad set, for example existing customers from prospecting (requires approval). Only the exclusions change; the rest of the targeting is kept.",
  inputSchema: updateAdsetAudienceExclusionsSchema,
  async execute(args, ctx) {
    return requireAndExecute("update_adset_audience_exclusions", args, ctx);
  },
});

export const pauseAdSetTool = registerTool({
  name: "pause_adset",
  description: "Pause an ad set (requires approval)",
  inputSchema: pauseAdSetSchema,
  async execute(args, ctx) {
    return requireAndExecute("pause_adset", args, ctx);
  },
});

export const resumeAdSetTool = registerTool({
  name: "resume_adset",
  description: "Resume a paused ad set so it can spend again (requires approval)",
  inputSchema: resumeAdSetSchema,
  async execute(args, ctx) {
    return requireAndExecute("resume_adset", args, ctx);
  },
});
