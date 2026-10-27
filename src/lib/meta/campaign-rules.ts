import { ATTRIBUTION_SETTINGS } from "@/lib/clients/goals";

/**
 * Which campaign settings Meta accepts together, held as one table because the
 * Marketing API does not expose these rules. Verified against the Graph API
 * version in META_GRAPH_VERSION; `tests/campaign-rules.test.ts` pins the
 * combinations, so a change here is deliberate.
 */

export type CampaignObjective =
  | "OUTCOME_SALES"
  | "OUTCOME_LEADS"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_AWARENESS";

export type ConversionLocation =
  | "website"
  | "instant_form"
  | "messaging"
  | "calls"
  | "app";

export type BudgetLevel = "campaign" | "ad_set";

export type OptimizationGoal =
  | "OFFSITE_CONVERSIONS"
  | "VALUE"
  | "LEAD_GENERATION"
  | "LINK_CLICKS"
  | "LANDING_PAGE_VIEWS"
  | "POST_ENGAGEMENT"
  | "REACH"
  | "IMPRESSIONS";

export type AttributionSetting = (typeof ATTRIBUTION_SETTINGS)[number];

export type CampaignSettings = {
  budget_level?: BudgetLevel;
  conversion_location?: ConversionLocation;
  optimization_goal?: OptimizationGoal;
  pixel_event_name?: string;
  /** Chosen on the card: the pixel the event belongs to. */
  pixel_id?: string;
  /** Chosen on the card for instant forms. */
  lead_form_id?: string;
  attribution?: AttributionSetting;
  age_min?: number;
  age_max?: number;
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  device_platforms?: ("mobile" | "desktop")[];
  user_device?: string[];
  user_os?: string[];
};

export type OptionInfo<T extends string = string> = {
  id: T;
  label: string;
  description: string;
  supported: boolean;
  unsupportedReason?: string;
};

export type GoalInfo = OptionInfo<OptimizationGoal> & {
  needsEvent: boolean;
  supportsAttribution: boolean;
};

const NOT_SUPPORTED = "not supported yet";

const LOCATION_INFO: Record<ConversionLocation, Omit<OptionInfo<ConversionLocation>, "supported" | "unsupportedReason">> = {
  website: {
    id: "website",
    label: "Website",
    description: "Send people to your website and measure what they do there.",
  },
  instant_form: {
    id: "instant_form",
    label: "Instant forms",
    description: "People fill in a form inside Facebook or Instagram without leaving.",
  },
  messaging: {
    id: "messaging",
    label: "Messaging apps",
    description: "Start conversations in Messenger, Instagram or WhatsApp.",
  },
  calls: {
    id: "calls",
    label: "Calls",
    description: "Get people to phone your business.",
  },
  app: {
    id: "app",
    label: "App",
    description: "Drive installs or activity in your mobile app.",
  },
};

const LOCATION_ORDER: ConversionLocation[] = [
  "website",
  "instant_form",
  "messaging",
  "calls",
  "app",
];

const SUPPORTED_LOCATIONS: Record<CampaignObjective, ConversionLocation[]> = {
  OUTCOME_SALES: ["website"],
  OUTCOME_LEADS: ["website", "instant_form"],
  OUTCOME_TRAFFIC: ["website"],
  OUTCOME_ENGAGEMENT: [],
  OUTCOME_AWARENESS: [],
};

const OBJECTIVES_WITH_LOCATION: CampaignObjective[] = [
  "OUTCOME_SALES",
  "OUTCOME_LEADS",
  "OUTCOME_TRAFFIC",
];

export function conversionLocationsFor(
  objective: CampaignObjective,
): OptionInfo<ConversionLocation>[] {
  if (!OBJECTIVES_WITH_LOCATION.includes(objective)) return [];
  const supported = SUPPORTED_LOCATIONS[objective];
  return LOCATION_ORDER.map((id) =>
    supported.includes(id)
      ? { ...LOCATION_INFO[id], supported: true }
      : { ...LOCATION_INFO[id], supported: false, unsupportedReason: NOT_SUPPORTED },
  );
}

const GOAL_INFO: Record<OptimizationGoal, Omit<GoalInfo, "supported">> = {
  OFFSITE_CONVERSIONS: {
    id: "OFFSITE_CONVERSIONS",
    label: "Maximise number of conversions",
    description: "Finds people most likely to complete your chosen conversion event.",
    needsEvent: true,
    supportsAttribution: true,
  },
  VALUE: {
    id: "VALUE",
    label: "Maximise value of conversions",
    description: "Finds people likely to spend more. Needs purchase values on your pixel.",
    needsEvent: true,
    supportsAttribution: true,
  },
  LEAD_GENERATION: {
    id: "LEAD_GENERATION",
    label: "Maximise number of leads",
    description: "Gets as many instant-form submissions as the budget allows.",
    needsEvent: false,
    supportsAttribution: false,
  },
  LINK_CLICKS: {
    id: "LINK_CLICKS",
    label: "Maximise link clicks",
    description: "Gets the most clicks to your website for the budget.",
    needsEvent: false,
    supportsAttribution: false,
  },
  LANDING_PAGE_VIEWS: {
    id: "LANDING_PAGE_VIEWS",
    label: "Maximise landing page views",
    description: "Favours people who click and wait for the page to load.",
    needsEvent: false,
    supportsAttribution: false,
  },
  POST_ENGAGEMENT: {
    id: "POST_ENGAGEMENT",
    label: "Maximise engagement",
    description: "Gets the most reactions, comments and shares.",
    needsEvent: false,
    supportsAttribution: false,
  },
  REACH: {
    id: "REACH",
    label: "Maximise reach",
    description: "Shows your ad to as many different people as possible.",
    needsEvent: false,
    supportsAttribution: false,
  },
  IMPRESSIONS: {
    id: "IMPRESSIONS",
    label: "Maximise impressions",
    description: "Shows your ad as many times as possible, including repeats.",
    needsEvent: false,
    supportsAttribution: false,
  },
};

const GOALS: Record<string, OptimizationGoal[]> = {
  "OUTCOME_SALES:website": ["OFFSITE_CONVERSIONS", "VALUE"],
  "OUTCOME_LEADS:website": ["OFFSITE_CONVERSIONS"],
  "OUTCOME_LEADS:instant_form": ["LEAD_GENERATION"],
  "OUTCOME_TRAFFIC:website": ["LINK_CLICKS", "LANDING_PAGE_VIEWS"],
  OUTCOME_ENGAGEMENT: ["POST_ENGAGEMENT"],
  OUTCOME_AWARENESS: ["REACH", "IMPRESSIONS"],
};

export function performanceGoalsFor(
  objective: CampaignObjective,
  location?: ConversionLocation,
): GoalInfo[] {
  const key = OBJECTIVES_WITH_LOCATION.includes(objective)
    ? location
      ? `${objective}:${location}`
      : null
    : objective;
  const ids = (key && GOALS[key]) || [];
  return ids.map((id) => ({ ...GOAL_INFO[id], supported: true }));
}

const ATTRIBUTION_INFO: Record<AttributionSetting, string> = {
  "7d_click_1d_view": "Counts conversions within 7 days of a click or 1 day of a view. Meta's default.",
  "7d_click": "Counts conversions within 7 days of a click only.",
  "1d_click": "Counts conversions within 1 day of a click only. The strictest window.",
};

const ATTRIBUTION_LABEL: Record<AttributionSetting, string> = {
  "7d_click_1d_view": "7-day click, 1-day view",
  "7d_click": "7-day click",
  "1d_click": "1-day click",
};

export function attributionOptionsFor(goal: OptimizationGoal): OptionInfo<AttributionSetting>[] {
  if (!GOAL_INFO[goal].supportsAttribution) return [];
  return ATTRIBUTION_SETTINGS.map((id) => ({
    id,
    label: ATTRIBUTION_LABEL[id],
    description: ATTRIBUTION_INFO[id],
    supported: true,
  }));
}

/** Meta placement enums. `video_feeds` is deprecated and deliberately absent. */
export const PLACEMENT_OPTIONS = [
  {
    platform: "facebook",
    label: "Facebook",
    description: "Where your ad appears on Facebook.",
    positions: [
      { id: "feed", label: "Feed" },
      { id: "story", label: "Stories" },
      { id: "facebook_reels", label: "Reels" },
      { id: "marketplace", label: "Marketplace" },
    ],
  },
  {
    platform: "instagram",
    label: "Instagram",
    description: "Where your ad appears on Instagram.",
    positions: [
      { id: "stream", label: "Feed" },
      { id: "story", label: "Stories" },
      { id: "reels", label: "Reels" },
      { id: "explore", label: "Explore" },
    ],
  },
  {
    platform: "audience_network",
    label: "Audience Network",
    description: "Partner apps and sites outside Facebook and Instagram.",
    positions: [
      { id: "classic", label: "Native, banner and interstitial" },
      { id: "rewarded_video", label: "Rewarded video" },
    ],
  },
  {
    platform: "messenger",
    label: "Messenger",
    description: "Inside Messenger.",
    positions: [
      { id: "messenger_home", label: "Inbox" },
      { id: "story", label: "Stories" },
    ],
  },
] as const;

/**
 * Pixel events Meta accepts as `promoted_object.custom_event_type` for a
 * conversion goal. Automatic and custom pixel events are not in this set.
 */
export const META_CONVERSION_EVENTS = [
  "PURCHASE",
  "LEAD",
  "COMPLETE_REGISTRATION",
  "ADD_TO_CART",
  "ADD_TO_WISHLIST",
  "INITIATE_CHECKOUT",
  "ADD_PAYMENT_INFO",
  "CONTACT",
  "CUSTOMIZE_PRODUCT",
  "DONATE",
  "FIND_LOCATION",
  "SCHEDULE",
  "START_TRIAL",
  "SUBMIT_APPLICATION",
  "SUBSCRIBE",
] as const;

export type ValidationContext = {
  objective: CampaignObjective;
  hasPixel: boolean;
  hasLeadForm: boolean;
};

export type ValidationResult = { ok: true } | { ok: false; error: string };

const fail = (error: string): ValidationResult => ({ ok: false, error });

export function validateCampaignSettings(
  settings: CampaignSettings,
  ctx: ValidationContext,
): ValidationResult {
  const { objective } = ctx;

  if (settings.conversion_location) {
    const info = LOCATION_INFO[settings.conversion_location];
    if (!info) return fail(`Unknown conversion location "${settings.conversion_location}".`);
    if (!SUPPORTED_LOCATIONS[objective].includes(settings.conversion_location)) {
      const known = LOCATION_ORDER.includes(settings.conversion_location);
      return fail(
        known && !(["website", "instant_form"] as ConversionLocation[]).includes(settings.conversion_location)
          ? `${info.label} is ${NOT_SUPPORTED}. Use website or instant forms.`
          : `${info.label} is not available for ${objective}.`,
      );
    }
  }

  if (settings.optimization_goal) {
    const goals = performanceGoalsFor(objective, settings.conversion_location);
    const goal = goals.find((g) => g.id === settings.optimization_goal);
    if (!goal) {
      return fail(
        `${settings.optimization_goal} is not a valid performance goal for ${objective}${
          settings.conversion_location ? ` with ${settings.conversion_location}` : ""
        }.`,
      );
    }
    if (goal.needsEvent && !ctx.hasPixel) {
      return fail(
        `${goal.label} needs a Meta pixel on this ad account. Add a pixel or choose another goal.`,
      );
    }
    if (goal.id === "LEAD_GENERATION" && !ctx.hasLeadForm) {
      return fail("Instant-form leads need a lead form. Create one on the Facebook Page first.");
    }
    if (
      goal.needsEvent &&
      settings.pixel_event_name &&
      !(META_CONVERSION_EVENTS as readonly string[]).includes(settings.pixel_event_name.toUpperCase())
    ) {
      return fail(
        `${settings.pixel_event_name} is not a conversion event Meta accepts. Choose one of: ${META_CONVERSION_EVENTS.join(", ")}.`,
      );
    }
    if (settings.attribution && !goal.supportsAttribution) {
      return fail(`An attribution window cannot be set when optimizing for ${goal.label.toLowerCase()}.`);
    }
  } else if (settings.attribution) {
    return fail("Choose a performance goal that supports attribution before setting a window.");
  }

  if (typeof settings.age_min === "number" && settings.age_min < 18) {
    return fail("Minimum age must be at least 18.");
  }
  if (typeof settings.age_max === "number" && settings.age_max > 65) {
    return fail("Maximum age cannot be above 65.");
  }
  if (
    typeof settings.age_min === "number" &&
    typeof settings.age_max === "number" &&
    settings.age_min > settings.age_max
  ) {
    return fail("Minimum age cannot be higher than maximum age.");
  }

  return { ok: true };
}

export type SuggestionContext = ValidationContext & {
  pixelEvents?: string[];
  stated?: Partial<CampaignSettings>;
};

export type Suggestion = {
  settings: CampaignSettings;
  reasons: Partial<Record<keyof CampaignSettings, string>>;
};

/** The pixel event a goal usually wants: leads → LEAD, sales → PURCHASE. */
function defaultEvent(objective: CampaignObjective, events: string[] | undefined): string | undefined {
  const wanted = objective === "OUTCOME_LEADS" ? "LEAD" : "PURCHASE";
  if (!events?.length) return wanted;
  const match = events.find((e) => e.toUpperCase().replace(/[\s_-]/g, "") === wanted);
  return match ? match.toUpperCase().replace(/[\s-]/g, "_") : wanted;
}

/**
 * Deterministic defaults and the reason for each, from the objective and what
 * the account has. Anything the operator already stated is kept when valid.
 */
export function suggestCampaignSettings(ctx: SuggestionContext): Suggestion {
  const { objective, stated = {} } = ctx;
  const settings: CampaignSettings = {};
  const reasons: Suggestion["reasons"] = {};

  settings.budget_level = stated.budget_level ?? "campaign";
  reasons.budget_level =
    stated.budget_level != null
      ? "As you asked."
      : "Campaign budget lets Meta shift spend to the best ad set automatically.";

  const locations = conversionLocationsFor(objective).filter((l) => l.supported);
  if (locations.length) {
    const statedLocation = locations.find((l) => l.id === stated.conversion_location);
    let location = statedLocation?.id;
    if (location) {
      reasons.conversion_location = "As you asked.";
    } else if (objective === "OUTCOME_LEADS" && !ctx.hasPixel && ctx.hasLeadForm) {
      location = "instant_form";
      reasons.conversion_location = "No pixel found, but a lead form exists.";
    } else {
      location = "website";
      reasons.conversion_location = ctx.hasPixel
        ? "Your pixel can measure conversions on your website."
        : "Sends people to your landing page.";
    }
    settings.conversion_location = location;
  }

  const goals = performanceGoalsFor(objective, settings.conversion_location);
  const statedGoal = goals.find((g) => g.id === stated.optimization_goal);
  let goal = statedGoal;
  if (goal) {
    reasons.optimization_goal = "As you asked.";
  } else {
    goal = goals.find((g) => !g.needsEvent || ctx.hasPixel) ?? goals[0];
    if (goal) {
      reasons.optimization_goal = goal.needsEvent
        ? ctx.hasPixel
          ? "Conversions are the strongest signal when a pixel is available."
          : "This is the standard goal for this objective, but there is no pixel on this account yet; add one before continuing."
        : "The standard goal for this objective.";
    }
  }
  if (goal) settings.optimization_goal = goal.id;

  if (goal?.needsEvent) {
    settings.pixel_event_name = stated.pixel_event_name ?? defaultEvent(objective, ctx.pixelEvents);
    reasons.pixel_event_name =
      stated.pixel_event_name != null
        ? "As you asked."
        : objective === "OUTCOME_LEADS"
          ? "Lead is the event that marks a lead on your site."
          : "Purchase is the event that marks a sale.";
  }
  if (goal?.supportsAttribution) {
    settings.attribution = stated.attribution ?? "7d_click_1d_view";
    reasons.attribution =
      stated.attribution != null ? "As you asked." : "Meta's default window; counts clicks and views.";
  }

  for (const key of ["pixel_id", "lead_form_id", "age_min", "age_max", "publisher_platforms", "facebook_positions", "instagram_positions", "device_platforms", "user_device", "user_os"] as const) {
    if (stated[key] != null) (settings as Record<string, unknown>)[key] = stated[key];
  }

  return { settings, reasons };
}
