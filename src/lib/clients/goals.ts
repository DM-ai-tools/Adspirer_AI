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

/**
 * A stored profile, keeping every field that still validates: one bad or
 * unknown field drops only itself (and is logged), never the guardrails.
 */
export function parseGoalsProfile(value: unknown): GoalsProfile {
  const parsed = goalsProfileSchema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (key === "policy" && field && typeof field === "object" && !Array.isArray(field)) {
      // Same rule one level down: a bad policy field drops only itself.
      const policy: Record<string, unknown> = {};
      for (const [name, v] of Object.entries(field as Record<string, unknown>)) {
        const one = goalsProfileSchema.safeParse({ policy: { [name]: v } });
        if (one.success) Object.assign(policy, one.data.policy);
        else dropped.push(`policy.${name}`);
      }
      if (Object.keys(policy).length) kept.policy = policy;
      continue;
    }
    const one = goalsProfileSchema.safeParse({ [key]: field });
    if (one.success) Object.assign(kept, one.data);
    else dropped.push(key);
  }
  if (dropped.length) console.warn(`Ignoring invalid goals profile fields: ${dropped.join(", ")}`);
  return kept as GoalsProfile;
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

/**
 * The client's targets as context lines for the agent, so any turn can answer
 * "what's our target ROAS?" without guessing. Only fields the client set are listed.
 */
export function describeGoalsForAgent(goals: ResolvedGoals, currency: string): string[] {
  const money = (cents: number) => `${(cents / 100).toFixed(2)} ${currency}`;
  const lines = [
    goals.business_model ? `- Business model: ${goals.business_model}` : null,
    goals.optimisation_event ? `- Optimises for: ${goals.optimisation_event}` : null,
    goals.target_roas != null ? `- Target ROAS: ${goals.target_roas}×` : null,
    goals.target_cpa_cents != null ? `- Target CPA: ${money(goals.target_cpa_cents)}` : null,
    goals.gross_margin_pct != null ? `- Gross margin: ${goals.gross_margin_pct}%` : null,
    goals.break_even_roas != null ? `- Break-even ROAS: ${goals.break_even_roas}×` : null,
    goals.average_value_cents != null ? `- Average order / lead value: ${money(goals.average_value_cents)}` : null,
    goals.break_even_cpa_cents != null ? `- Break-even CPA: ${money(goals.break_even_cpa_cents)}` : null,
    goals.daily_account_cap_cents != null ? `- Daily account cap: ${money(goals.daily_account_cap_cents)}` : null,
    goals.monthly_cap_cents != null ? `- Monthly cap: ${money(goals.monthly_cap_cents)}` : null,
    goals.allowed_countries?.length ? `- Allowed countries: ${goals.allowed_countries.join(", ")}` : null,
    goals.special_ad_category && goals.special_ad_category !== "NONE"
      ? `- Special ad category: ${goals.special_ad_category}`
      : null,
    goals.compliance_notes ? `- Compliance notes: ${goals.compliance_notes}` : null,
  ].filter((line): line is string => line !== null);
  return lines.length
    ? lines
    : ["- No goals set yet — targets and caps can be added under the client's Settings. Ask before assuming a target."];
}

// ---------------------------------------------------------------------------
// Settings form ⇄ profile. Money fields are typed in major units (60 = $60).

const MONEY_FIELDS = [
  ["target_cpa", "target_cpa_cents"],
  ["average_value", "average_value_cents"],
  ["daily_account_cap", "daily_account_cap_cents"],
  ["monthly_cap", "monthly_cap_cents"],
] as const;
const NUMBER_FIELDS = ["target_roas", "gross_margin_pct", "max_budget_change_pct"] as const;
const TEXT_FIELDS = ["business_model", "attribution", "special_ad_category", "compliance_notes"] as const;
const POLICY_FIELDS = [
  "scale_step_pct",
  "kill_multiple",
  "min_days_of_data",
  "prospecting_frequency_max",
  "retargeting_frequency_max",
] as const;

const filled = (v: string | undefined) => (v ?? "").trim();

/**
 * Settings form values → profile (unvalidated; the API validates it).
 * Blank fields are left out so the defaults apply.
 */
export function goalsProfileFromForm(values: Record<string, string | undefined>): Record<string, unknown> {
  const profile: Record<string, unknown> = {};
  for (const [field, key] of MONEY_FIELDS) {
    if (filled(values[field])) profile[key] = Math.round(Number(filled(values[field])) * 100);
  }
  for (const field of NUMBER_FIELDS) {
    if (filled(values[field])) profile[field] = Number(filled(values[field]));
  }
  for (const field of TEXT_FIELDS) {
    if (filled(values[field])) profile[field] = filled(values[field]);
  }
  if (filled(values.optimisation_event)) profile.optimisation_event = filled(values.optimisation_event).toUpperCase();
  const countries = filled(values.allowed_countries)
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  if (countries.length) profile.allowed_countries = countries;
  const policy: Record<string, number> = {};
  for (const field of POLICY_FIELDS) {
    if (filled(values[field])) policy[field] = Number(filled(values[field]));
  }
  if (Object.keys(policy).length) profile.policy = policy;
  return profile;
}

/** Stored profile → form values (cents shown as major units). */
export function goalsFormValues(profile: GoalsProfile): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [field, key] of MONEY_FIELDS) {
    const cents = profile[key];
    if (cents != null) values[field] = String(cents / 100);
  }
  for (const field of NUMBER_FIELDS) {
    if (profile[field] != null) values[field] = String(profile[field]);
  }
  for (const field of TEXT_FIELDS) {
    if (profile[field] != null) values[field] = String(profile[field]);
  }
  if (profile.optimisation_event) values.optimisation_event = profile.optimisation_event;
  if (profile.allowed_countries?.length) values.allowed_countries = profile.allowed_countries.join(", ");
  for (const field of POLICY_FIELDS) {
    const v = profile.policy?.[field];
    if (v != null) values[field] = String(v);
  }
  return values;
}
