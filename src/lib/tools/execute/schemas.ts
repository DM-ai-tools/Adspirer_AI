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
};

/** Creative fields shared by the create tools. */
const creativeFields = {
  description: z.string().max(255).optional(),
  call_to_action: z.string().optional(),
  display_link: z.string().optional(),
  url_tags: z.string().optional(),
  instagram_account_id: z.string().optional(),
};

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

/** Every tool the approval executor can actually dispatch to Meta. */
export const EXECUTE_TOOL_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  update_adset_budget: updateAdsetBudgetSchema,
  pause_campaign: pauseCampaignSchema,
  resume_campaign: resumeCampaignSchema,
  create_campaign: createCampaignSchema,
  create_meta_image_campaign: createMetaImageCampaignSchema,
  create_meta_video_campaign: createMetaVideoCampaignSchema,
  create_adset: createAdSetSchema,
  create_ad: createAdSchema,
  pause_ad: pauseAdSchema,
};

export function getExecuteToolSchema(toolName: string): z.ZodType | undefined {
  return EXECUTE_TOOL_SCHEMAS[toolName];
}
