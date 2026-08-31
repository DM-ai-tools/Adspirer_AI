import { resolveBudgetDaily } from "@/lib/meta/resolve-budget-daily";

const META_CAMPAIGN_TOOLS = new Set([
  "create_meta_image_campaign",
  "create_meta_video_campaign",
  "create_adset",
  "create_ad",
]);

const RADIUS_LOCATION_TYPES = new Set(["city"]);
const DEPRECATED_FACEBOOK_POSITIONS = new Set(["video_feeds"]);
const SAFE_FACEBOOK_POSITIONS = [
  "feed",
  "story",
  "facebook_reels",
  "marketplace",
];

function asAudienceId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  }
  return null;
}

function normalizeAudienceIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const ids = value
    .map(asAudienceId)
    .filter((id): id is string => Boolean(id));
  return ids.length ? ids : undefined;
}

function normalizeLocations(locations: unknown[]): unknown[] {
  return locations.map((loc) => {
    if (typeof loc === "string") return loc;
    if (!loc || typeof loc !== "object") return loc;
    const row = loc as Record<string, unknown>;
    const key = String(row.key ?? row.id ?? "").trim();
    const type = String(row.type ?? "").toLowerCase();
    if (type === "country" || (!type && /^[a-z]{2}$/i.test(key))) {
      return key.toUpperCase();
    }
    if (!key) return loc;
    const resolvedType = type || "city";
    const entry: Record<string, unknown> = { key, type: resolvedType };
    if (
      RADIUS_LOCATION_TYPES.has(resolvedType) &&
      typeof row.radius === "number" &&
      row.radius > 0
    ) {
      entry.radius = row.radius;
      entry.distance_unit =
        row.distance_unit === "mile" ? "mile" : "kilometer";
    }
    return entry;
  });
}

function sanitizeFacebookPositions(positions: string[]): string[] {
  const filtered = positions.filter((p) => !DEPRECATED_FACEBOOK_POSITIONS.has(p));
  return filtered.length ? filtered : [...SAFE_FACEBOOK_POSITIONS];
}

/**
 * Canonicalize Meta campaign approval args so agent/operator JSON matches what
 * the executor and Graph API expect. Safe to call at queue time and again at execution.
 */
export function normalizeMetaApprovalArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!META_CAMPAIGN_TOOLS.has(toolName)) return args;

  const next: Record<string, unknown> = { ...args };

  const budget = resolveBudgetDaily(next);
  if (budget != null) {
    next.budget_daily = budget;
    delete next.daily_budget;
  }

  const audiences = normalizeAudienceIds(next.custom_audiences);
  if (audiences) next.custom_audiences = audiences;
  else delete next.custom_audiences;

  const excluded = normalizeAudienceIds(next.excluded_custom_audiences);
  if (excluded) next.excluded_custom_audiences = excluded;
  else delete next.excluded_custom_audiences;

  if (Array.isArray(next.locations)) {
    next.locations = normalizeLocations(next.locations);
  }

  if (Array.isArray(next.facebook_positions)) {
    next.facebook_positions = sanitizeFacebookPositions(
      next.facebook_positions.filter((p): p is string => typeof p === "string"),
    );
  }

  return next;
}

export function estimateMetaBudgetImpactCents(
  toolName: string,
  args: Record<string, unknown>,
): number | null {
  if (
    toolName !== "create_meta_image_campaign" &&
    toolName !== "create_meta_video_campaign" &&
    toolName !== "create_adset" &&
    toolName !== "create_campaign"
  ) {
    return null;
  }
  const budget = resolveBudgetDaily(args);
  if (budget != null) return Math.round(budget * 100);
  if (typeof args.daily_budget_cents === "number") {
    return args.daily_budget_cents;
  }
  return null;
}
