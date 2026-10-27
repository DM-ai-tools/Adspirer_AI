import { withSourceIds, type CampaignOptions } from "@/lib/meta/campaign-options";
import {
  performanceGoalsFor,
  suggestCampaignSettings,
  validateCampaignSettings,
  type CampaignSettings,
  type ValidationResult,
} from "@/lib/meta/campaign-rules";

const POSITION_KEY: Record<string, "facebook_positions" | "instagram_positions"> = {
  facebook: "facebook_positions",
  instagram: "instagram_positions",
};

/** A lookup that failed is "unknown", not "none": the server still enforces it at creation. */
function contextOf(options: CampaignOptions) {
  return {
    objective: options.objective,
    hasPixel: options.pixels.length > 0 || !options.pixelsLoaded,
    hasLeadForm: options.leadForms.length > 0 || !options.leadFormsLoaded,
  };
}

/**
 * Apply one change on the card. Fields that depend on the changed one are reset
 * and re-suggested, so the card never holds a combination Meta would reject.
 */
export function applyChange(
  current: CampaignSettings,
  change: Partial<CampaignSettings>,
  options: CampaignOptions,
): CampaignSettings {
  const next: CampaignSettings = { ...current, ...change };
  const pixelEvents = [...new Set(options.pixels.flatMap((p) => p.events))];

  const locationChanged =
    "conversion_location" in change && change.conversion_location !== current.conversion_location;
  const goalChanged =
    "optimization_goal" in change && change.optimization_goal !== current.optimization_goal;

  if (locationChanged || goalChanged) {
    const { settings } = suggestCampaignSettings({
      ...contextOf(options),
      pixelEvents,
      stated: {
        conversion_location: next.conversion_location,
        // A location change picks a new goal; a goal change keeps the chosen one.
        ...(goalChanged ? { optimization_goal: next.optimization_goal } : {}),
      },
    });
    next.conversion_location = settings.conversion_location;
    next.optimization_goal = settings.optimization_goal;
    next.pixel_event_name = settings.pixel_event_name;
    next.attribution = settings.attribution;
    for (const key of ["pixel_event_name", "attribution", "conversion_location", "optimization_goal"] as const) {
      if (next[key] === undefined) delete next[key];
    }
  }

  if ("publisher_platforms" in change) {
    const platforms = change.publisher_platforms ?? [];
    for (const [platform, key] of Object.entries(POSITION_KEY)) {
      if (!platforms.includes(platform)) delete next[key];
    }
  }

  return withSourceIds(next, {
    objective: options.objective,
    pixels: options.pixels,
    leadForms: options.leadForms,
  });
}

export function canConfirm(settings: CampaignSettings, options: CampaignOptions): ValidationResult {
  const verdict = validateCampaignSettings(settings, contextOf(options));
  if (!verdict.ok) return verdict;
  if (settings.conversion_location === "instant_form" && options.leadForms.length && !settings.lead_form_id) {
    return { ok: false, error: "Choose a lead form." };
  }
  const goal = performanceGoalsFor(options.objective, settings.conversion_location).find(
    (g) => g.id === settings.optimization_goal,
  );
  if (goal?.needsEvent && options.pixels.length && !settings.pixel_id) {
    return { ok: false, error: "Choose a pixel." };
  }
  return { ok: true };
}
