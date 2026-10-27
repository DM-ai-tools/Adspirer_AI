import {
  PLACEMENT_OPTIONS,
  attributionOptionsFor,
  conversionLocationsFor,
  performanceGoalsFor,
  type CampaignObjective,
  type ConversionLocation,
  type OptimizationGoal,
} from "@/lib/meta/campaign-rules";

const OBJECTIVES: CampaignObjective[] = [
  "OUTCOME_SALES",
  "OUTCOME_LEADS",
  "OUTCOME_TRAFFIC",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_AWARENESS",
];
const LOCATIONS: ConversionLocation[] = ["website", "instant_form", "messaging", "calls", "app"];

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
}

function goalLabel(goal: string): string {
  for (const objective of OBJECTIVES) {
    for (const location of [undefined, ...LOCATIONS]) {
      const hit = performanceGoalsFor(objective, location).find((g) => g.id === (goal as OptimizationGoal));
      if (hit) return hit.label;
    }
  }
  return goal;
}

function placementsLine(args: Record<string, unknown>): string | null {
  const platforms = strings(args.publisher_platforms);
  if (!platforms.length) return null;
  return platforms
    .map((platform) => {
      const info = PLACEMENT_OPTIONS.find((p) => p.platform === platform);
      const key = platform === "facebook" ? "facebook_positions" : platform === "instagram" ? "instagram_positions" : null;
      const chosen = key ? strings(args[key]) : [];
      const names = chosen.map((id) => info?.positions.find((p) => p.id === id)?.label ?? id);
      return `${info?.label ?? platform}${names.length ? ` (${names.join(", ")})` : ""}`;
    })
    .join(" · ");
}

/**
 * The campaign settings an approval carries, as rows for the approval card.
 * Empty when the approval used none of them.
 */
export function describeCampaignSettings(args: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string | null]> = [];

  const location = typeof args.conversion_location === "string" ? args.conversion_location : null;
  if (location) {
    const label = LOCATIONS.includes(location as ConversionLocation)
      ? OBJECTIVES.flatMap((o) => conversionLocationsFor(o)).find((l) => l.id === location)?.label
      : null;
    rows.push(["Conversion location", label ?? location]);
  }
  const goal = typeof args.optimization_goal === "string" ? args.optimization_goal : null;
  if (goal) rows.push(["Performance goal", goalLabel(goal)]);
  if (typeof args.pixel_event_name === "string") rows.push(["Conversion event", args.pixel_event_name]);
  if (typeof args.pixel_id === "string") rows.push(["Pixel", args.pixel_id]);
  if (typeof args.attribution === "string") {
    const label = attributionOptionsFor("OFFSITE_CONVERSIONS").find((a) => a.id === args.attribution)?.label;
    rows.push(["Attribution", label ?? args.attribution]);
  }
  rows.push(["Placements", placementsLine(args)]);
  const devices = strings(args.device_platforms);
  if (devices.length) rows.push(["Devices", devices.join(", ")]);
  const models = strings(args.user_device);
  if (models.length) rows.push(["Device models", models.join(", ")]);
  const os = strings(args.user_os);
  if (os.length) rows.push(["Operating systems", os.join(", ")]);

  return rows.filter((row): row is [string, string] => Boolean(row[1]));
}
