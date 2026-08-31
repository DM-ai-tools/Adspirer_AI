import { z } from "zod";
import { registerTool } from "@/lib/tools/registry";
import { ApprovalRequiredError } from "@/lib/errors";
import { executeApprovedAction } from "@/lib/approvals/executor";
import { getDemoStore } from "@/lib/demo/store";
import { getConfig } from "@/lib/config";

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
    .select("id, proposed_args, edited_args, status")
    .eq("client_id", clientId)
    .eq("tool_name", toolName)
    .in("status", ["approved", "edited"])
    .order("created_at", { ascending: false })
    .limit(20);

  const rows = (data ?? []) as Array<{
    id: string;
    proposed_args: Record<string, unknown>;
    edited_args: Record<string, unknown> | null;
    status: string;
  }>;

  const match = rows.find(
    (a) =>
      JSON.stringify(a.edited_args ?? a.proposed_args) === JSON.stringify(args),
  );
  return match?.id ?? null;
}

export const updateAdsetBudgetTool = registerTool({
  name: "update_adset_budget",
  description: "Update an ad set daily budget (requires approval)",
  inputSchema: z.object({
    account_id: z.string().min(1),
    adset_id: z.string().min(1),
    daily_budget_cents: z.number().int().positive(),
    previous_daily_budget_cents: z.number().int().nonnegative().optional(),
  }),
  async execute(args, ctx) {
    return requireAndExecute("update_adset_budget", args, ctx);
  },
});

export const pauseCampaignTool = registerTool({
  name: "pause_campaign",
  description: "Pause a campaign (requires approval)",
  inputSchema: z.object({
    account_id: z.string().min(1),
    campaign_id: z.string().min(1),
  }),
  async execute(args, ctx) {
    return requireAndExecute("pause_campaign", args, ctx);
  },
});

export const resumeCampaignTool = registerTool({
  name: "resume_campaign",
  description: "Resume a paused campaign (requires approval)",
  inputSchema: z.object({
    account_id: z.string().min(1),
    campaign_id: z.string().min(1),
  }),
  async execute(args, ctx) {
    return requireAndExecute("resume_campaign", args, ctx);
  },
});

export const createCampaignTool = registerTool({
  name: "create_campaign",
  description: "Create a new campaign (defaults to PAUSED; requires approval)",
  inputSchema: z.object({
    account_id: z.string().min(1),
    name: z.string().min(1),
    objective: z.string().min(1),
    status: z.enum(["ACTIVE", "PAUSED"]).optional(),
    daily_budget_cents: z.number().int().positive().optional(),
    special_ad_categories: z.array(z.string()).optional(),
  }),
  async execute(args, ctx) {
    // New campaigns are created PAUSED by default.
    const normalized = { ...args, status: args.status ?? "PAUSED" };
    return requireAndExecute("create_campaign", normalized, ctx);
  },
});

export const createMetaImageCampaignTool = registerTool({
  name: "create_meta_image_campaign",
  description:
    "Create a paused Meta image campaign (+ ad set + ad) via Adspirer (requires approval)",
  inputSchema: z.object({
    account_id: z.string().min(1),
    campaign_name: z.string().min(1),
    ad_set_name: z.string().optional(),
    ad_name: z.string().optional(),
    objective: z.string().optional(),
    budget_daily: z.number().positive().optional(),
    budget_lifetime: z.number().positive().optional(),
    end_time: z.string().optional(),
    primary_text: z.string().min(1),
    headline: z.string().min(1),
    description: z.string().max(255).optional(),
    call_to_action: z.string().optional(),
    landing_page_url: z.string().url(),
    display_link: z.string().optional(),
    url_tags: z.string().optional(),
    image_url: z.string().url().optional(),
    existing_image_hash: z.string().optional(),
    age_min: z.number().int().min(18).max(65).optional(),
    age_max: z.number().int().min(18).max(65).optional(),
    genders: z.array(z.enum(["male", "female"])).optional(),
    locations: z.array(z.unknown()).optional(),
    interests: z.array(z.unknown()).optional(),
    behaviors: z.array(z.unknown()).optional(),
    custom_audiences: z.array(z.union([z.string(), z.record(z.string(), z.unknown())])).optional(),
    excluded_custom_audiences: z
      .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
      .optional(),
    facebook_positions: z.array(z.string()).optional(),
    instagram_positions: z.array(z.string()).optional(),
    publisher_platforms: z.array(z.string()).optional(),
    special_ad_categories: z.array(z.string()).optional(),
    campaign_budget_optimization: z.boolean().optional(),
    pixel_id: z.string().optional(),
    pixel_event_name: z.string().optional(),
    instagram_account_id: z.string().optional(),
    facebook_page_id: z.string().optional(),
  }),
  async execute(args, ctx) {
    return requireAndExecute("create_meta_image_campaign", args, ctx);
  },
});

export const createMetaVideoCampaignTool = registerTool({
  name: "create_meta_video_campaign",
  description:
    "Create a paused Meta video campaign (+ ad set + ad) via Adspirer (requires approval). Needs video_url or existing_video_id.",
  inputSchema: z
    .object({
      account_id: z.string().min(1),
      campaign_name: z.string().min(1),
      ad_set_name: z.string().optional(),
      ad_name: z.string().optional(),
      objective: z.string().optional(),
      budget_daily: z.number().positive().optional(),
      budget_lifetime: z.number().positive().optional(),
      end_time: z.string().optional(),
      primary_text: z.string().min(1),
      headline: z.string().optional(),
      description: z.string().max(255).optional(),
      call_to_action: z.string().optional(),
      landing_page_url: z.string().url(),
      display_link: z.string().optional(),
      url_tags: z.string().optional(),
      video_url: z.string().url().optional(),
      existing_video_id: z.string().optional(),
      thumbnail_url: z.string().url().optional(),
      age_min: z.number().int().min(18).max(65).optional(),
      age_max: z.number().int().min(18).max(65).optional(),
      genders: z.array(z.enum(["male", "female"])).optional(),
      locations: z.array(z.unknown()).optional(),
      interests: z.array(z.unknown()).optional(),
      behaviors: z.array(z.unknown()).optional(),
      custom_audiences: z
        .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
        .optional(),
      excluded_custom_audiences: z
        .array(z.union([z.string(), z.record(z.string(), z.unknown())]))
        .optional(),
      facebook_positions: z.array(z.string()).optional(),
      instagram_positions: z.array(z.string()).optional(),
      publisher_platforms: z.array(z.string()).optional(),
      special_ad_categories: z.array(z.string()).optional(),
      campaign_budget_optimization: z.boolean().optional(),
      pixel_id: z.string().optional(),
      pixel_event_name: z.string().optional(),
      instagram_account_id: z.string().optional(),
      facebook_page_id: z.string().optional(),
    })
    .refine((v) => Boolean(v.video_url || v.existing_video_id), {
      message: "Provide video_url or existing_video_id",
    }),
  async execute(args, ctx) {
    return requireAndExecute("create_meta_video_campaign", args, ctx);
  },
});

export const createAdSetTool = registerTool({
  name: "create_adset",
  description:
    "Add a Meta ad set via Adspirer (requires approval). Adspirer requires ad_type, primary_text, and landing_page_url. For video use ad_type=video with video_url or existing_video_id. Creates PAUSED.",
  inputSchema: z.object({
    account_id: z.string().min(1),
    campaign_id: z.string().min(1),
    name: z.string().optional(),
    budget_daily: z.number().positive().optional(),
    ad_type: z.enum(["image", "video", "carousel"]).optional().default("image"),
    landing_page_url: z.string().url(),
    primary_text: z.string().min(1),
    headline: z.string().optional(),
    image_url: z.string().url().optional(),
    video_url: z.string().url().optional(),
    existing_video_id: z.string().optional(),
    thumbnail_url: z.string().url().optional(),
    age_min: z.number().int().min(18).max(65).optional(),
    age_max: z.number().int().min(18).max(65).optional(),
  }),
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
    "Add a Meta ad to an ad set via Adspirer (requires approval). For video ads set ad_type=video and pass video_url or existing_video_id.",
  inputSchema: z.object({
    account_id: z.string().min(1),
    ad_set_id: z.string().min(1),
    ad_type: z.enum(["image", "video", "carousel"]).optional(),
    primary_text: z.string().min(1),
    landing_page_url: z.string().url(),
    headline: z.string().optional(),
    image_url: z.string().url().optional(),
    existing_image_hash: z.string().optional(),
    video_url: z.string().url().optional(),
    existing_video_id: z.string().optional(),
    thumbnail_url: z.string().url().optional(),
    name: z.string().optional(),
  }),
  async execute(args, ctx) {
    return requireAndExecute("create_ad", args, ctx);
  },
});

export const pauseAdTool = registerTool({
  name: "pause_ad",
  description: "Pause an ad (requires approval)",
  inputSchema: z.object({
    account_id: z.string().min(1),
    ad_id: z.string().min(1),
  }),
  async execute(args, ctx) {
    return requireAndExecute("pause_ad", args, ctx);
  },
});
