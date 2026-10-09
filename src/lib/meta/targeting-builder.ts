/**
 * Build Meta Graph API targeting / creative payloads from our create inputs.
 */

type IdName = { id?: string; name?: string } | string;

function asId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  }
  return null;
}

function asIdName(value: unknown): { id: string; name?: string } | null {
  if (typeof value === "string" && value.trim()) return { id: value.trim() };
  if (value && typeof value === "object") {
    const id = asId(value);
    if (!id) return null;
    const name =
      typeof (value as { name?: unknown }).name === "string"
        ? (value as { name: string }).name
        : undefined;
    return { id, name };
  }
  return null;
}

function mapGenders(genders?: string[]): number[] | undefined {
  if (!genders?.length) return undefined;
  const mapped: number[] = [];
  for (const g of genders) {
    const n = g.toLowerCase();
    if (n === "male" || n === "1") mapped.push(1);
    else if (n === "female" || n === "2") mapped.push(2);
  }
  return mapped.length ? mapped : undefined;
}

type GeoLocations = {
  countries?: string[];
  cities?: Array<Record<string, unknown>>;
  regions?: Array<Record<string, unknown>>;
  zips?: Array<Record<string, unknown>>;
  places?: Array<Record<string, unknown>>;
  location_types?: string[];
};

const RADIUS_GEO_TYPES = new Set(["city"]);

function mapLocations(locations: unknown[] | undefined): GeoLocations {
  const geo: GeoLocations = {
    countries: [],
    cities: [],
    regions: [],
    zips: [],
    places: [],
  };

  for (const loc of locations ?? []) {
    if (typeof loc === "string") {
      const code = loc.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(code)) geo.countries!.push(code);
      continue;
    }
    if (!loc || typeof loc !== "object") continue;
    const row = loc as Record<string, unknown>;
    const key = String(row.key ?? row.id ?? "").trim();
    const type = String(row.type ?? "").toLowerCase();

    if (type === "country" || (!type && /^[a-z]{2}$/i.test(key))) {
      geo.countries!.push(key.toUpperCase());
      continue;
    }
    if (!key) continue;
    const entry: Record<string, unknown> = { key };
    // Meta only allows radius on cities — regions/countries/zips reject it (subcode 1487079).
    const resolvedType =
      type === "region"
        ? "region"
        : type === "zip"
          ? "zip"
          : type === "place"
            ? "place"
            : type === "city"
              ? "city"
              : "city";
    if (RADIUS_GEO_TYPES.has(resolvedType)) {
      const radius =
        typeof row.radius === "number" && row.radius > 0 ? row.radius : undefined;
      const distance_unit =
        row.distance_unit === "mile" || row.distance_unit === "kilometer"
          ? row.distance_unit
          : "kilometer";
      if (radius) {
        entry.radius = radius;
        entry.distance_unit = distance_unit;
      }
    }
    if (resolvedType === "region") geo.regions!.push(entry);
    else if (resolvedType === "zip") geo.zips!.push(entry);
    else if (resolvedType === "place") geo.places!.push(entry);
    else geo.cities!.push(entry);
  }

  if (!geo.countries!.length) delete geo.countries;
  if (!geo.cities!.length) delete geo.cities;
  if (!geo.regions!.length) delete geo.regions;
  if (!geo.zips!.length) delete geo.zips;
  if (!geo.places!.length) delete geo.places;

  return geo;
}

function hasAnyGeo(geo: GeoLocations): boolean {
  return Boolean(
    geo.countries || geo.cities || geo.regions || geo.zips || geo.places,
  );
}

export const MISSING_LOCATION_MESSAGE =
  'No targeting location was provided. Add `locations` (e.g. ["GB"] for a country, or {"key": "<Meta city key>", "type": "city", "radius": 15}) — a country is never guessed for you.';

/** True when `locations` contains at least one usable country/city/region/zip/place. */
export function hasTargetingLocation(locations: unknown): boolean {
  if (!Array.isArray(locations)) return false;
  return hasAnyGeo(mapLocations(locations));
}

function mapIdList(values: unknown): Array<{ id: string }> | undefined {
  if (!Array.isArray(values) || !values.length) return undefined;
  const ids = values
    .map((v) => asId(v))
    .filter((id): id is string => Boolean(id))
    .map((id) => ({ id }));
  return ids.length ? ids : undefined;
}

/** Our arg name → Meta flexible_spec key. Ids only: Meta resolves names. */
const FLEXIBLE_SPEC_KEYS: Array<[string, string]> = [
  ["interests", "interests"],
  ["behaviors", "behaviors"],
  ["life_events", "life_events"],
  ["job_titles", "work_positions"],
  ["work_employers", "work_employers"],
  ["education_schools", "education_schools"],
  ["education_majors", "education_majors"],
];

function mapFlexibleSpec(extra: Record<string, unknown> | undefined) {
  if (!extra) return undefined;
  const spec: Record<string, Array<{ id: string }>> = {};
  for (const [argKey, metaKey] of FLEXIBLE_SPEC_KEYS) {
    const raw = extra[argKey];
    if (!Array.isArray(raw)) continue;
    const ids = (raw as IdName[])
      .map(asIdName)
      .filter((x): x is { id: string; name?: string } => Boolean(x))
      .map((x) => ({ id: x.id }));
    if (ids.length) spec[metaKey] = ids;
  }
  return Object.keys(spec).length ? [spec] : undefined;
}

const DEPRECATED_FACEBOOK_POSITIONS = new Set(["video_feeds"]);

/** v24+ safe defaults — video_feeds is deprecated (subcode 2490562). */
const DEFAULT_PLATFORM_POSITIONS: Record<string, string[]> = {
  facebook: ["feed", "story", "facebook_reels", "marketplace"],
  instagram: ["stream", "story", "reels", "explore"],
  audience_network: ["classic", "rewarded_video"],
  messenger: ["messenger_home", "story"],
};

function sanitizeFacebookPositions(positions: string[]): string[] {
  const filtered = positions.filter((p) => !DEPRECATED_FACEBOOK_POSITIONS.has(p));
  return filtered.length ? filtered : DEFAULT_PLATFORM_POSITIONS.facebook;
}

function applyPublisherPlatforms(
  targeting: Record<string, unknown>,
  platforms: string[] | undefined,
  extra: Record<string, unknown>,
): void {
  if (!platforms?.length) return;

  targeting.publisher_platforms = platforms;

  if (platforms.includes("facebook")) {
    const raw =
      Array.isArray(extra.facebook_positions) && extra.facebook_positions.length
        ? (extra.facebook_positions as string[])
        : DEFAULT_PLATFORM_POSITIONS.facebook;
    targeting.facebook_positions = sanitizeFacebookPositions(raw);
  }
  if (platforms.includes("instagram")) {
    targeting.instagram_positions =
      Array.isArray(extra.instagram_positions) &&
      extra.instagram_positions.length
        ? extra.instagram_positions
        : DEFAULT_PLATFORM_POSITIONS.instagram;
  }
  if (platforms.includes("audience_network")) {
    targeting.audience_network_positions =
      Array.isArray(extra.audience_network_positions) &&
      extra.audience_network_positions.length
        ? extra.audience_network_positions
        : DEFAULT_PLATFORM_POSITIONS.audience_network;
  }
  if (platforms.includes("messenger")) {
    targeting.messenger_positions =
      Array.isArray(extra.messenger_positions) &&
      extra.messenger_positions.length
        ? extra.messenger_positions
        : DEFAULT_PLATFORM_POSITIONS.messenger;
  }
}

export function buildMetaTargeting(input: {
  age_min?: number;
  age_max?: number;
  genders?: string[];
  locations?: unknown[];
  publisher_platforms?: string[];
  extra_args?: Record<string, unknown>;
}): Record<string, unknown> {
  const extra = input.extra_args ?? {};
  const geo = mapLocations(input.locations);
  if (!hasAnyGeo(geo)) {
    throw new Error(MISSING_LOCATION_MESSAGE);
  }
  if (Array.isArray(extra.location_types) && extra.location_types.length) {
    geo.location_types = extra.location_types as string[];
  }

  const targeting: Record<string, unknown> = {
    geo_locations: geo,
  };

  if (typeof input.age_min === "number") targeting.age_min = input.age_min;
  if (typeof input.age_max === "number") targeting.age_max = input.age_max;

  const genders = mapGenders(input.genders);
  if (genders) targeting.genders = genders;

  const flexible = mapFlexibleSpec(extra);
  if (flexible) targeting.flexible_spec = flexible;

  const customAudiences = mapIdList(extra.custom_audiences);
  if (customAudiences) targeting.custom_audiences = customAudiences;

  const excluded = mapIdList(extra.excluded_custom_audiences);
  if (excluded) targeting.excluded_custom_audiences = excluded;

  const platforms =
    input.publisher_platforms ??
    (Array.isArray(extra.publisher_platforms)
      ? (extra.publisher_platforms as string[])
      : undefined);
  applyPublisherPlatforms(targeting, platforms, extra);

  // Meta requires an explicit Advantage+ audience choice on new ad sets.
  // Off (0) unless the proposal asks for it.
  targeting.targeting_automation = {
    advantage_audience: isTruthyFlag(extra.advantage_audience) ? 1 : 0,
  };

  return targeting;
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
}

function optionalTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Instant-form lead ads: `lead_form_id` from the args (top level or extra). */
export function resolveLeadFormId(input: {
  lead_form_id?: string;
  extra_args?: Record<string, unknown>;
}): string | undefined {
  return (
    optionalTrimmed(input.lead_form_id) ??
    optionalTrimmed(input.extra_args?.lead_form_id)
  );
}

function resolvePixelId(input: {
  pixel_id?: string;
  extra_args?: Record<string, unknown>;
}): string | undefined {
  const direct =
    typeof input.pixel_id === "string" && input.pixel_id.trim()
      ? input.pixel_id.trim()
      : undefined;
  const fromExtra =
    typeof input.extra_args?.pixel_id === "string" &&
    input.extra_args.pixel_id.trim()
      ? input.extra_args.pixel_id.trim()
      : undefined;
  return direct ?? fromExtra;
}

export function optimizationForObjective(
  objective?: string,
  options?: { pixel_id?: string; extra_args?: Record<string, unknown> },
): {
  optimization_goal: string;
  billing_event: string;
} {
  const hasPixel = Boolean(resolvePixelId(options ?? {}));
  const upper = (objective ?? "OUTCOME_TRAFFIC").toUpperCase();

  // Instant-form lead ads optimise for on-Facebook leads, not pixel events.
  if (upper === "OUTCOME_LEADS" && resolveLeadFormId(options ?? {})) {
    return {
      optimization_goal: "LEAD_GENERATION",
      billing_event: "IMPRESSIONS",
    };
  }

  switch (upper) {
    case "OUTCOME_SALES":
    case "OUTCOME_LEADS":
      // OFFSITE_CONVERSIONS requires pixel_id in promoted_object (subcode 1815143).
      if (hasPixel) {
        return {
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
        };
      }
      return {
        optimization_goal: "LINK_CLICKS",
        billing_event: "IMPRESSIONS",
      };
    case "OUTCOME_ENGAGEMENT":
      return {
        optimization_goal: "POST_ENGAGEMENT",
        billing_event: "IMPRESSIONS",
      };
    case "OUTCOME_AWARENESS":
      return { optimization_goal: "REACH", billing_event: "IMPRESSIONS" };
    case "OUTCOME_APP_PROMOTION":
      return {
        optimization_goal: "APP_INSTALLS",
        billing_event: "IMPRESSIONS",
      };
    default:
      return {
        optimization_goal: "LINK_CLICKS",
        billing_event: "IMPRESSIONS",
      };
  }
}

export function buildPromotedObject(input: {
  objective?: string;
  lead_form_id?: string;
  facebook_page_id?: string;
  pixel_id?: string;
  pixel_event_name?: string;
  extra_args?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const pageId =
    input.facebook_page_id ??
    (typeof input.extra_args?.facebook_page_id === "string"
      ? input.extra_args.facebook_page_id
      : undefined);
  const pixelId = resolvePixelId(input);
  const objective = (input.objective ?? "").toUpperCase();
  // Default conversion event follows the objective: leads → LEAD, sales → PURCHASE.
  const eventName = (
    optionalTrimmed(input.pixel_event_name) ??
    optionalTrimmed(input.extra_args?.pixel_event_name) ??
    (objective === "OUTCOME_LEADS" ? "LEAD" : "PURCHASE")
  ).toUpperCase();

  if (objective === "OUTCOME_LEADS" && resolveLeadFormId(input)) {
    // Instant forms: Meta wants just the page that owns the form.
    return pageId ? { page_id: pageId } : undefined;
  }
  if (objective === "OUTCOME_SALES" || objective === "OUTCOME_LEADS") {
    if (!pixelId) return pageId ? { page_id: pageId } : undefined;
    return {
      pixel_id: pixelId,
      custom_event_type: eventName,
      ...(pageId ? { page_id: pageId } : {}),
    };
  }
  if (pageId) return { page_id: pageId };
  return undefined;
}

/**
 * Meta call_to_action.type values accepted on link / video creatives.
 * https://developers.facebook.com/docs/marketing-api/reference/ad-creative-link-data-call-to-action
 */
export const META_CTA_TYPES = [
  "LEARN_MORE",
  "SIGN_UP",
  "CONTACT_US",
  "BOOK_TRAVEL",
  "BOOK_NOW",
  "APPLY_NOW",
  "GET_QUOTE",
  "GET_OFFER",
  "GET_DIRECTIONS",
  "SHOP_NOW",
  "SUBSCRIBE",
  "DOWNLOAD",
  "ORDER_NOW",
  "BUY_NOW",
  "BUY_TICKETS",
  "WATCH_MORE",
  "WATCH_VIDEO",
  "SEND_MESSAGE",
  "MESSAGE_PAGE",
  "WHATSAPP_MESSAGE",
  "CALL_NOW",
  "INSTALL_APP",
  "USE_APP",
  "PLAY_GAME",
  "LISTEN_NOW",
  "DONATE_NOW",
  "REQUEST_TIME",
  "SEE_MENU",
  "GET_SHOWTIMES",
  "OPEN_LINK",
  "NO_BUTTON",
] as const;

const CTA_SET = new Set<string>(META_CTA_TYPES);

/**
 * Normalise a CTA ("Learn more", "learn-more" → LEARN_MORE) and reject values
 * Meta does not accept, instead of letting the creative POST fail mid-run.
 */
export function normalizeCallToAction(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error("call_to_action must be a text value such as LEARN_MORE.");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toUpperCase().replace(/[\s-]+/g, "_");
  if (!CTA_SET.has(normalized)) {
    throw new Error(
      `call_to_action "${trimmed}" is not a Meta button type. Use one of: ${META_CTA_TYPES.join(", ")}.`,
    );
  }
  return normalized;
}
