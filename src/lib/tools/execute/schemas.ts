import { BID_STRATEGIES } from "@/lib/meta/conventions";
import { ATTRIBUTION_SETTINGS } from "@/lib/clients/goals";
import { z } from "zod";

/**
 * Input schemas for every EXECUTE tool. Kept free of executor imports so the
 * approval service can validate proposed / edited args against the same
 * contract the tool registry uses (no import cycle).
 *
 * Numbers are strict here: `prepareApprovalArgs` coerces numeric strings
 * ("5500") to numbers first and rejects anything else, so a string can never
 * slip past a budget check.
 */

export const META_OBJECTIVES = [
  "OUTCOME_AWARENESS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_LEADS",
  "OUTCOME_APP_PROMOTION",
  "OUTCOME_SALES",
] as const;

const accountId = z.string().min(1, "account_id is required");
const objective = z.enum(META_OBJECTIVES);
const cents = z.number().int("must be whole cents").positive();
const majorBudget = z.number().positive().finite();
const age = z.number().int().min(18).max(65);
const idList = z.array(z.union([z.string(), z.record(z.string(), z.unknown())]));
const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO date/time");

/** Targeting / ad set fields shared by the create tools. */
const targetingFields = {
  age_min: age.optional(),
  age_max: age.optional(),
  genders: z.array(z.string()).optional(),
  locations: z.array(z.unknown()).optional(),
  location_types: z.array(z.string()).optional(),
  interests: z.array(z.unknown()).optional(),
  behaviors: z.array(z.unknown()).optional(),
  life_events: z.array(z.unknown()).optional(),
  job_titles: z.array(z.unknown()).optional(),
  work_employers: z.array(z.unknown()).optional(),
  education_schools: z.array(z.unknown()).optional(),
  education_majors: z.array(z.unknown()).optional(),
  custom_audiences: idList.optional(),
  excluded_custom_audiences: idList.optional(),
  facebook_positions: z.array(z.string()).optional(),
  instagram_positions: z.array(z.string()).optional(),
  publisher_platforms: z.array(z.string()).optional(),
  advantage_audience: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
  pixel_id: z.string().optional(),
  pixel_event_name: z.string().optional(),
  lead_form_id: z.string().optional(),
  destination_type: z.string().optional(),
  dsa_beneficiary: z.string().optional(),
  dsa_payor: z.string().optional(),
  start_time: isoDate.optional(),
  end_time: isoDate.optional(),
  facebook_page_id: z.string().optional(),
  bid_strategy: z.enum(BID_STRATEGIES).optional(),
  /** Cost or bid cap, major units per result. */
  bid_amount: z.number().positive().optional(),
  /** Minimum ROAS, e.g. 2.5 for 2.5×. */
  roas_average_floor: z.number().positive().optional(),
  attribution: z.enum(ATTRIBUTION_SETTINGS).optional(),
  /** Chosen on the campaign settings card; validated against Meta's rules when the ad set is built. */
  optimization_goal: z.string().optional(),
  conversion_location: z
    .enum(["website", "instant_form", "messaging", "calls", "app"])
    .refine((v) => v === "website" || v === "instant_form", {
      message: "That conversion location is not supported yet; use website or instant_form.",
    })
    .optional(),
  device_platforms: z.array(z.enum(["mobile", "desktop"])).optional(),
  user_device: z.array(z.string()).optional(),
  user_os: z.array(z.string()).optional(),
};

/** Creative fields shared by the create tools. */
const creativeFields = {
  description: z.string().max(255).optional(),
  call_to_action: z.string().optional(),
  display_link: z.string().optional(),
  url_tags: z.string().optional(),
  instagram_account_id: z.string().optional(),
  /** Text options Meta rotates (up to 5 each, the ad's own included). */
  primary_texts: z.array(z.string().min(1)).max(5).optional(),
  headlines: z.array(z.string().min(1).max(255)).max(5).optional(),
  descriptions: z.array(z.string().min(1).max(255)).max(5).optional(),
};

/** Further ads in the same ad set (each falls back to the main ad's copy). */
const extraAds = z
  .array(
    z.object({
      primary_text: z.string().min(1).optional(),
      headline: z.string().optional(),
      landing_page_url: z.string().url().optional(),
      image_url: z.string().url().optional(),
      existing_image_hash: z.string().optional(),
      video_url: z.string().url().optional(),
      existing_video_id: z.string().optional(),
      thumbnail_url: z.string().url().optional(),
      name: z.string().optional(),
    }),
  )
  .max(5);

type BudgetShape = {
  budget_daily?: number;
  budget_lifetime?: number;
  end_time?: string;
  start_time?: string;
};

/** Lifetime budgets need a schedule; a daily and a lifetime budget conflict. */
function checkBudgetSchedule(
  v: BudgetShape,
  ctx: z.RefinementCtx,
  requireBudget: boolean,
): void {
  if (v.budget_daily != null && v.budget_lifetime != null) {
    ctx.addIssue({
      code: "custom",
      path: ["budget_lifetime"],
      message: "Set either budget_daily or budget_lifetime, not both.",
    });
  }
  if (requireBudget && v.budget_daily == null && v.budget_lifetime == null) {
    ctx.addIssue({
      code: "custom",
      path: ["budget_daily"],
      message:
        "A budget is required — set budget_daily (major units, e.g. 20 for 20/day) or budget_lifetime with end_time.",
    });
  }
  if (v.budget_lifetime != null && !v.end_time) {
    ctx.addIssue({
      code: "custom",
      path: ["end_time"],
      message: "budget_lifetime requires end_time (ISO date/time).",
    });
  }
  if (v.end_time) {
    const end = Date.parse(v.end_time);
    if (!Number.isNaN(end) && end <= Date.now()) {
      ctx.addIssue({
        code: "custom",
        path: ["end_time"],
        message: "end_time must be in the future.",
      });
    }
    if (v.start_time) {
      const start = Date.parse(v.start_time);
      if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start) {
        ctx.addIssue({
          code: "custom",
          path: ["end_time"],
          message: "end_time must be after start_time.",
        });
      }
    }
  }
}

export const updateAdsetBudgetSchema = z.object({
  account_id: accountId,
  adset_id: z.string().min(1),
  daily_budget_cents: cents,
  previous_daily_budget_cents: z.number().int().nonnegative().optional(),
});

export const pauseCampaignSchema = z.object({
  account_id: accountId,
  campaign_id: z.string().min(1),
});

export const resumeCampaignSchema = pauseCampaignSchema;

export const createCampaignSchema = z.object({
  account_id: accountId,
  name: z.string().min(1),
  objective,
  status: z.enum(["ACTIVE", "PAUSED"]).optional(),
  daily_budget_cents: cents.optional(),
  special_ad_categories: z.array(z.string()).optional(),
});

const campaignBase = {
  account_id: accountId,
  campaign_name: z.string().min(1),
  ad_set_name: z.string().optional(),
  ad_name: z.string().optional(),
  objective: objective.optional(),
  budget_daily: majorBudget.optional(),
  budget_lifetime: majorBudget.optional(),
  primary_text: z.string().min(1),
  landing_page_url: z.string().url(),
  special_ad_categories: z.array(z.string()).optional(),
  campaign_budget_optimization: z.boolean().optional(),
  extra_ads: extraAds.optional(),
  ...targetingFields,
  ...creativeFields,
};

export const createMetaImageCampaignSchema = z
  .object({
    ...campaignBase,
    headline: z.string().min(1),
    image_url: z.string().url().optional(),
    existing_image_hash: z.string().optional(),
  })
  .superRefine((v, ctx) => checkBudgetSchedule(v, ctx, true));

export const createMetaVideoCampaignSchema = z
  .object({
    ...campaignBase,
    headline: z.string().optional(),
    video_url: z.string().url().optional(),
    existing_video_id: z.string().optional(),
    thumbnail_url: z.string().url().optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.video_url && !v.existing_video_id) {
      ctx.addIssue({
        code: "custom",
        path: ["video_url"],
        message: "Provide video_url or existing_video_id",
      });
    }
    checkBudgetSchedule(v, ctx, true);
  });

export const createAdSetSchema = z
  .object({
    account_id: accountId,
    campaign_id: z.string().min(1),
    name: z.string().optional(),
    budget_daily: majorBudget.optional(),
    budget_lifetime: majorBudget.optional(),
    ad_type: z.enum(["image", "video", "carousel"]).optional().default("image"),
    landing_page_url: z.string().url(),
    primary_text: z.string().min(1),
    headline: z.string().optional(),
    image_url: z.string().url().optional(),
    video_url: z.string().url().optional(),
    existing_video_id: z.string().optional(),
    thumbnail_url: z.string().url().optional(),
    objective: objective.optional(),
    campaign_budget_optimization: z.boolean().optional(),
    ...targetingFields,
    ...creativeFields,
  })
  // The budget may legitimately be absent under a CBO campaign; the provider
  // checks that against the live campaign.
  .superRefine((v, ctx) => checkBudgetSchedule(v, ctx, false));

export const createAdSchema = z
  .object({
    account_id: accountId,
    ad_set_id: z.string().min(1).optional(),
    adset_id: z.string().optional(),
    campaign_id: z.string().optional(),
    campaign_name: z.string().optional(),
    ad_set_name: z.string().optional(),
    ad_name: z.string().optional(),
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
    facebook_page_id: z.string().optional(),
    lead_form_id: z.string().optional(),
    ...creativeFields,
  })
  .refine(
    (v) =>
      Boolean(
        v.ad_set_id ||
          v.adset_id ||
          v.campaign_id ||
          (v.campaign_name && v.ad_set_name),
      ),
    {
      message:
        "Provide ad_set_id, or both campaign_name and ad_set_name for lookup",
    },
  );

export const pauseAdSchema = z.object({
  account_id: accountId,
  ad_id: z.string().min(1),
});

export const resumeAdSchema = pauseAdSchema;

/** Campaign budget (CBO / Advantage+ campaign budget) — daily only. */
export const updateCampaignBudgetSchema = z.object({
  account_id: accountId,
  campaign_id: z.string().min(1),
  daily_budget_cents: cents,
  previous_daily_budget_cents: z.number().int().nonnegative().optional(),
});

export const pauseAdSetSchema = z.object({
  account_id: accountId,
  adset_id: z.string().min(1, "adset_id is required"),
});

export const resumeAdSetSchema = pauseAdSetSchema;

/** Move or clear an ad set's end date, or move the start of an ad set that has not started. */
export const updateAdsetScheduleSchema = z
  .object({
    account_id: accountId,
    adset_id: z.string().min(1, "adset_id is required"),
    end_time: isoDate.optional(),
    clear_end_time: z.boolean().optional(),
    start_time: isoDate.optional(),
  })
  .superRefine((v, ctx) => {
    if (!v.end_time && !v.clear_end_time && !v.start_time) {
      ctx.addIssue({ code: "custom", path: [], message: "Provide end_time, clear_end_time or start_time." });
    }
    if (v.end_time && v.clear_end_time) {
      ctx.addIssue({ code: "custom", path: ["clear_end_time"], message: "Set an end date or clear it, not both." });
    }
    if (v.end_time && Date.parse(v.end_time) <= Date.now()) {
      ctx.addIssue({ code: "custom", path: ["end_time"], message: "end_time must be in the future." });
    }
    if (v.start_time && Date.parse(v.start_time) <= Date.now()) {
      ctx.addIssue({ code: "custom", path: ["start_time"], message: "start_time must be in the future." });
    }
  });

/** Change an ad set's bid strategy and cap (ad sets that hold their own budget). */
export const updateAdsetBidSchema = z
  .object({
    account_id: accountId,
    adset_id: z.string().min(1, "adset_id is required"),
    bid_strategy: z.enum(BID_STRATEGIES),
    /** Cost cap or bid cap, major units per result. */
    bid_amount: z.number().positive().finite().optional(),
    /** Minimum ROAS as a multiple, e.g. 2.5 for 2.5×. */
    roas_average_floor: z.number().positive().finite().optional(),
  })
  .superRefine((v, ctx) => {
    const isCap = v.bid_strategy === "COST_CAP" || v.bid_strategy === "LOWEST_COST_WITH_BID_CAP";
    if (isCap && v.bid_amount == null) {
      ctx.addIssue({
        code: "custom",
        path: ["bid_amount"],
        message: `${v.bid_strategy === "COST_CAP" ? "A cost cap" : "A bid cap"} needs bid_amount (major units, e.g. 30 for 30 per result).`,
      });
    }
    if (v.bid_strategy === "LOWEST_COST_WITH_MIN_ROAS" && v.roas_average_floor == null) {
      ctx.addIssue({ code: "custom", path: ["roas_average_floor"], message: "A minimum ROAS bid needs roas_average_floor (e.g. 2.5 for 2.5×)." });
    }
    if (v.bid_amount != null && !isCap) {
      ctx.addIssue({ code: "custom", path: ["bid_amount"], message: "bid_amount only applies to a cost cap or a bid cap." });
    }
    if (v.roas_average_floor != null && v.bid_strategy !== "LOWEST_COST_WITH_MIN_ROAS") {
      ctx.addIssue({ code: "custom", path: ["roas_average_floor"], message: "roas_average_floor only applies to a minimum ROAS bid." });
    }
  });

/** Change where an ad set's ads run: manual platforms and positions, or automatic (Advantage+) placements. */
const placementPlatform = z.enum(["facebook", "instagram", "audience_network", "messenger"]);
const placementPositions = z.array(z.string().regex(/^[a-z_]+$/, "Use Meta's position names, e.g. feed")).optional();
export const updateAdsetPlacementsSchema = z
  .object({
    account_id: accountId,
    adset_id: z.string().min(1, "adset_id is required"),
    advantage_placements: z.boolean().optional(),
    publisher_platforms: z.array(placementPlatform).min(1).optional(),
    facebook_positions: placementPositions,
    instagram_positions: placementPositions,
    audience_network_positions: placementPositions,
    messenger_positions: placementPositions,
    /** Provided replaces, an empty list clears the device restriction, absent keeps it. */
    device_platforms: z.array(z.enum(["mobile", "desktop"])).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.advantage_placements && v.publisher_platforms) {
      ctx.addIssue({ code: "custom", path: ["publisher_platforms"], message: "Set advantage_placements or publisher_platforms, not both." });
    }
    if (!v.advantage_placements && !v.publisher_platforms) {
      ctx.addIssue({ code: "custom", path: [], message: "Provide advantage_placements or publisher_platforms." });
    }
    for (const platform of placementPlatform.options) {
      const key = `${platform}_positions` as const;
      if (v[key]?.length && (v.advantage_placements || !v.publisher_platforms?.includes(platform))) {
        ctx.addIssue({ code: "custom", path: [key], message: `${key} was given for ${platform}, which is not selected.` });
      }
    }
    if (v.advantage_placements && v.device_platforms?.length) {
      ctx.addIssue({ code: "custom", path: ["device_platforms"], message: "Automatic placements take no device restriction." });
    }
  });

/** Exclude (or stop excluding) custom audiences on an ad set; the rest of the targeting is kept. */
export const updateAdsetAudienceExclusionsSchema = z
  .object({
    account_id: accountId,
    adset_id: z.string().min(1, "adset_id is required"),
    add_excluded_custom_audiences: z.array(z.string().min(1)).optional(),
    remove_excluded_custom_audiences: z.array(z.string().min(1)).optional(),
  })
  .superRefine((v, ctx) => {
    const add = v.add_excluded_custom_audiences ?? [];
    const remove = v.remove_excluded_custom_audiences ?? [];
    if (!add.length && !remove.length) {
      ctx.addIssue({ code: "custom", path: [], message: "Provide add_excluded_custom_audiences or remove_excluded_custom_audiences." });
    }
    if (add.some((id) => remove.includes(id))) {
      ctx.addIssue({ code: "custom", path: ["remove_excluded_custom_audiences"], message: "The same audience is in both add and remove." });
    }
  });

/** Every tool the approval executor can actually dispatch to Meta. */
export const EXECUTE_TOOL_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  update_adset_budget: updateAdsetBudgetSchema,
  update_campaign_budget: updateCampaignBudgetSchema,
  pause_campaign: pauseCampaignSchema,
  resume_campaign: resumeCampaignSchema,
  pause_adset: pauseAdSetSchema,
  resume_adset: resumeAdSetSchema,
  resume_ad: resumeAdSchema,
  create_campaign: createCampaignSchema,
  create_meta_image_campaign: createMetaImageCampaignSchema,
  create_meta_video_campaign: createMetaVideoCampaignSchema,
  create_adset: createAdSetSchema,
  create_ad: createAdSchema,
  pause_ad: pauseAdSchema,
  update_adset_schedule: updateAdsetScheduleSchema,
  update_adset_bid: updateAdsetBidSchema,
  update_adset_placements: updateAdsetPlacementsSchema,
  update_adset_audience_exclusions: updateAdsetAudienceExclusionsSchema,
};

export function getExecuteToolSchema(toolName: string): z.ZodType | undefined {
  return EXECUTE_TOOL_SCHEMAS[toolName];
}
