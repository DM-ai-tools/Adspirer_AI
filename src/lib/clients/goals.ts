import { z } from "zod";

/**
 * A client's goals and guardrails: the targets every decision rule is
 * measured against, and the limits approvals enforce. Stored as
 * `clients.goals_profile` (jsonb). Money is in app cents, in the client's
 * currency. Everything is optional; `resolveGoals` fills the defaults.
 */

const cents = z.number().int("must be whole cents").positive();

export const BUSINESS_MODELS = ["ecommerce", "lead_gen", "local_service", "b2b", "other"] as const;
export const ATTRIBUTION_SETTINGS = ["7d_click_1d_view", "7d_click", "1d_click"] as const;
export const SPECIAL_AD_CATEGORIES = [
  "NONE",
  "HOUSING",
  "EMPLOYMENT",
  "CREDIT",
  "FINANCIAL_PRODUCTS_SERVICES",
] as const;

export const goalsPolicySchema = z
  .object({
    /** Budget increase per scale step, %. */
    scale_step_pct: z.number().min(1).max(100),
    /** Pause or trim after spend ≥ this × target CPA with no results. */
    kill_multiple: z.number().min(1).max(10),
    /** Days of data before any kill or scale call. */
    min_days_of_data: z.number().int().min(1).max(90),
    prospecting_frequency_max: z.number().min(1).max(20),
    retargeting_frequency_max: z.number().min(1).max(30),
  })
  .partial()
  .strict();

export const goalsProfileSchema = z
  .object({
    business_model: z.enum(BUSINESS_MODELS),
    /** Pixel event or "INSTANT_FORM" the campaigns optimise for (e.g. LEAD, PURCHASE). */
    optimisation_event: z.string().trim().min(1).max(80),
    target_cpa_cents: cents,
    target_roas: z.number().positive().max(100),
    average_value_cents: cents,
    gross_margin_pct: z.number().min(0).max(100),
    attribution: z.enum(ATTRIBUTION_SETTINGS),
    /** Sum of all live daily budgets on the account may not exceed this. */
    daily_account_cap_cents: cents,
    /** A budget increase above this % is high risk (admin approval). */
    max_budget_change_pct: z.number().min(1).max(1000),
    monthly_cap_cents: cents,
    allowed_countries: z.array(z.string().regex(/^[A-Z]{2}$/, "use 2-letter country codes")).max(250),
    special_ad_category: z.enum(SPECIAL_AD_CATEGORIES),
    compliance_notes: z.string().max(2000),
    policy: goalsPolicySchema,
  })
  .partial()
  .strict();

export type GoalsProfile = z.infer<typeof goalsProfileSchema>;
export type GoalsPolicy = Required<z.infer<typeof goalsPolicySchema>>;

/** The plan's defaults, used wherever the client hasn't set a value. */
export const GOALS_DEFAULTS = {
  attribution: "7d_click_1d_view" as (typeof ATTRIBUTION_SETTINGS)[number],
  max_budget_change_pct: 20,
  policy: {
    scale_step_pct: 20,
    kill_multiple: 3,
    min_days_of_data: 7,
    prospecting_frequency_max: 3,
    retargeting_frequency_max: 6,
  } satisfies GoalsPolicy,
};

export type ResolvedGoals = Omit<GoalsProfile, "policy" | "attribution" | "max_budget_change_pct"> & {
  attribution: (typeof ATTRIBUTION_SETTINGS)[number];
  max_budget_change_pct: number;
  policy: GoalsPolicy;
  /** Average value × margin: the most a result can cost before it loses money. */
  break_even_cpa_cents: number | null;
  /** 1 ÷ margin. */
  break_even_roas: number | null;
};

/** A stored profile that no longer validates is dropped, never fatal. */
export function parseGoalsProfile(value: unknown): GoalsProfile {
  const parsed = goalsProfileSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export function resolveGoals(client: { goals_profile?: GoalsProfile | null }): ResolvedGoals {
  const profile = client.goals_profile ?? {};
  const margin = profile.gross_margin_pct != null ? profile.gross_margin_pct / 100 : null;
  return {
    ...profile,
    attribution: profile.attribution ?? GOALS_DEFAULTS.attribution,
    max_budget_change_pct: profile.max_budget_change_pct ?? GOALS_DEFAULTS.max_budget_change_pct,
    policy: { ...GOALS_DEFAULTS.policy, ...(profile.policy ?? {}) },
    break_even_cpa_cents:
      profile.average_value_cents != null && margin != null && margin > 0
        ? Math.round(profile.average_value_cents * margin)
        : null,
    break_even_roas: margin != null && margin > 0 ? Math.round((1 / margin) * 100) / 100 : null,
  };
}
