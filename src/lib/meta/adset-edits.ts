/**
 * Pure rules for editing an existing ad set (schedule, and later bids, placements and
 * audience exclusions). No network: the provider reads the ad set, asks these
 * functions what to send, and refuses with a plain message when the answer is no.
 * Every refusal ends "Nothing was changed." because it happens before the first POST.
 */

import { BID_STRATEGIES } from "@/lib/meta/conventions";
import type { PlacementState } from "@/lib/meta/placement-format";
import { centsToMetaMinor } from "@/lib/meta/currency";

const DAY_MS = 86_400_000;

/**
 * A time as Meta returns or accepts it, in milliseconds. Handles ISO strings with or
 * without a colon in the offset ("+0000"), unix seconds, and treats empty / "0" /
 * unparsable values as "no time" (Meta uses 0 for "no end date").
 */
export function metaTimeMs(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "0") return null;
  if (/^\d{9,}$/.test(text)) return metaTimeMs(Number(text));
  const ms = Date.parse(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(ms) || ms <= 0 ? null : ms;
}

const iso = (ms: number) => new Date(ms).toISOString();

const ZONELESS = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/** A date, or a date and time, with no offset: it means nothing until it is read in a time zone. */
export function isZoneless(value: string): boolean {
  return ZONELESS.test(value.trim());
}

/** How far a zone is ahead of UTC at an instant, in ms. */
function zoneOffsetMs(ts: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - Math.floor(ts / 1000) * 1000;
}

/**
 * The instant a wall-clock time falls on in a time zone, as an ISO string. A date alone means
 * the end (23:59:59) or the start (00:00:00) of that day there. Throws for a zone it does not know.
 */
export function zonedTimeToIso(value: string, timeZone: string, edge: "start" | "end"): string {
  const m = ZONELESS.exec(value.trim());
  if (!m) throw new Error(`"${value}" is not a date or a date and time.`);
  const dateOnly = m[4] === undefined;
  const hour = dateOnly ? (edge === "end" ? 23 : 0) : Number(m[4]);
  const minute = dateOnly ? (edge === "end" ? 59 : 0) : Number(m[5]);
  const second = dateOnly ? (edge === "end" ? 59 : 0) : Number(m[6] ?? 0);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, second);
  // The offset depends on the instant, so settle it twice (this is what makes a daylight-saving change come out right).
  let ts = wall - zoneOffsetMs(wall, timeZone);
  ts = wall - zoneOffsetMs(ts, timeZone);
  return new Date(ts).toISOString();
}

export type ScheduleCurrent = {
  status: string;
  start_time?: string | null;
  end_time?: string | null;
  /** The ad set has a lifetime budget (which needs an end date). */
  lifetime_budget: boolean;
};

export type ScheduleChange = {
  end_time?: string;
  clear_end_time?: boolean;
  start_time?: string;
};

export type SchedulePlan = {
  /** What to POST to the ad set. */
  body: Record<string, string>;
  /** What the change does to how long the ad set spends. */
  direction: "earlier" | "later" | "cleared" | "start_moved";
};

function refuse(message: string): never {
  throw new Error(`${message} Nothing was changed.`);
}

export function planScheduleChange(
  current: ScheduleCurrent,
  change: ScheduleChange,
  now: number = Date.now(),
): SchedulePlan {
  if (!change.end_time && !change.clear_end_time && !change.start_time) {
    refuse("Provide end_time, clear_end_time or start_time.");
  }
  if (change.end_time && change.clear_end_time) refuse("Set an end date or clear it, not both.");

  const currentEnd = metaTimeMs(current.end_time);
  const currentStart = metaTimeMs(current.start_time);
  const body: Record<string, string> = {};

  if (change.clear_end_time) {
    if (current.lifetime_budget) refuse("A lifetime budget needs an end date, so the end date can't be removed.");
    if (currentEnd == null) refuse("This ad set already runs continuously (it has no end date).");
    return { body: { end_time: "0" }, direction: "cleared" };
  }

  let newStart: number | null = null;
  if (change.start_time) {
    newStart = metaTimeMs(change.start_time);
    if (newStart == null) refuse(`start_time "${change.start_time}" is not a valid date/time.`);
    if (currentStart != null && currentStart <= now) {
      refuse(`This ad set has already started (${iso(currentStart)}), so its start can't be changed.`);
    }
    if (newStart <= now) refuse(`start_time ${iso(newStart)} is in the past.`);
    body.start_time = iso(newStart);
  }

  let newEnd: number | null = null;
  if (change.end_time) {
    newEnd = metaTimeMs(change.end_time);
    if (newEnd == null) refuse(`end_time "${change.end_time}" is not a valid date/time.`);
    if (newEnd <= now) refuse(`end_time ${iso(newEnd)} is in the past.`);
    if (currentEnd != null && newEnd === currentEnd) refuse(`This ad set already ends then (${iso(currentEnd)}).`);
    body.end_time = iso(newEnd);
  }

  // The schedule that will result, checked as Meta will check it.
  const start = newStart ?? currentStart;
  const end = newEnd ?? currentEnd;
  if (start != null && end != null) {
    if (end <= start) refuse(`end_time must be after the start (${iso(start)}).`);
    if (!current.lifetime_budget && end - start <= DAY_MS) {
      refuse("A daily budget needs the ad set to run for more than 24 hours between its start and end.");
    }
  }

  if (newEnd != null) {
    return { body, direction: currentEnd == null || newEnd < currentEnd ? "earlier" : "later" };
  }
  return { body, direction: "start_moved" };
}

// ---------------------------------------------------------------- bid strategy and cap

export type BidCurrent = {
  /** The campaign holds the budget (CBO), so the bid strategy lives on the campaign. */
  cbo: boolean;
  objective?: string | null;
  optimization_goal?: string | null;
  bid_strategy?: string | null;
  /** The current cap in Meta minor units. */
  bid_amount_minor?: number | null;
  /** The current minimum ROAS as a multiple (2.5 = 2.5×). */
  roas_floor?: number | null;
  currency: string;
};

export type BidChange = {
  bid_strategy: string;
  /** Cost cap or bid cap, in major units per result. */
  bid_amount?: number;
  /** Minimum ROAS as a multiple. */
  roas_average_floor?: number;
};

export type BidPlan = {
  body: Record<string, string>;
  fromCapped: boolean;
  toUncapped: boolean;
};

const CAPPED = new Set(["COST_CAP", "LOWEST_COST_WITH_BID_CAP", "LOWEST_COST_WITH_MIN_ROAS"]);

export function planBidChange(current: BidCurrent, change: BidChange): BidPlan {
  const strategy = change.bid_strategy.trim().toUpperCase();
  if (!(BID_STRATEGIES as readonly string[]).includes(strategy)) {
    refuse(`Unknown bid_strategy "${change.bid_strategy}": use one of ${BID_STRATEGIES.join(", ")}.`);
  }
  if (current.cbo) {
    refuse("This ad set is in a campaign that uses a campaign budget, so its bid strategy is set on the campaign in Ads Manager.");
  }

  const hasAmount = change.bid_amount != null;
  const hasFloor = change.roas_average_floor != null;
  const isCap = strategy === "COST_CAP" || strategy === "LOWEST_COST_WITH_BID_CAP";
  const isRoas = strategy === "LOWEST_COST_WITH_MIN_ROAS";
  if (hasAmount && !isCap) refuse("bid_amount only applies to a cost cap or a bid cap.");
  if (hasFloor && !isRoas) refuse("roas_average_floor only applies to a minimum ROAS bid.");

  const body: Record<string, string> = { bid_strategy: strategy };
  const currentStrategy = (current.bid_strategy ?? "").toUpperCase() || null;
  let same = currentStrategy === strategy;

  if (isCap) {
    if (!(change.bid_amount && change.bid_amount > 0)) {
      refuse(`${strategy === "COST_CAP" ? "A cost cap" : "A bid cap"} needs bid_amount (major units, e.g. 30 for 30 per result).`);
    }
    const minor = centsToMetaMinor(Math.round(change.bid_amount * 100), current.currency);
    if (!(minor > 0)) refuse("bid_amount is too small to send to Meta.");
    body.bid_amount = String(minor);
    same = same && current.bid_amount_minor === minor;
  } else if (isRoas) {
    if ((current.objective ?? "").toUpperCase() !== "OUTCOME_SALES") {
      refuse("A minimum ROAS bid only works for Sales campaigns.");
    }
    if ((current.optimization_goal ?? "").toUpperCase() !== "VALUE") {
      refuse(
        `A minimum ROAS bid needs an ad set that optimises for purchase value; this one optimises for ${current.optimization_goal ?? "something else"}.`,
      );
    }
    if (!(change.roas_average_floor && change.roas_average_floor > 0)) {
      refuse("A minimum ROAS bid needs roas_average_floor (e.g. 2.5 for 2.5×).");
    }
    const floor = Math.round(change.roas_average_floor * 10_000);
    body.bid_constraints = JSON.stringify({ roas_average_floor: floor });
    same = same && current.roas_floor != null && Math.round(current.roas_floor * 10_000) === floor;
  }

  if (same) refuse(`This ad set already bids that way (${strategy}).`);
  const fromCapped = currentStrategy != null && CAPPED.has(currentStrategy);
  return { body, fromCapped, toUncapped: strategy === "LOWEST_COST_WITHOUT_CAP" && fromCapped };
}

// ---------------------------------------------------------------- placements

export type { PlacementState } from "@/lib/meta/placement-format";

export type PlacementChange = {
  /** Automatic (Advantage+) placements: removes every manual placement setting. */
  advantage_placements?: boolean;
  /** Manual placements: the platforms to run on (at least one). */
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
  audience_network_positions?: string[];
  messenger_positions?: string[];
  /** mobile / desktop. Provided replaces, an empty list clears the restriction, absent keeps it. */
  device_platforms?: string[];
};

const PLATFORMS = ["facebook", "instagram", "audience_network", "messenger"] as const;
const PLACEMENT_KEYS = [
  "publisher_platforms",
  "facebook_positions",
  "instagram_positions",
  "audience_network_positions",
  "messenger_positions",
  "device_platforms",
] as const;

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length && value.every((v) => typeof v === "string") ? [...(value as string[])] : null;

/** The placement settings in a targeting object; null means automatic / not set. */
export function placementStateOf(targeting: unknown): PlacementState {
  const t = (targeting && typeof targeting === "object" ? targeting : {}) as Record<string, unknown>;
  return {
    publisher_platforms: stringList(t.publisher_platforms),
    facebook_positions: stringList(t.facebook_positions),
    instagram_positions: stringList(t.instagram_positions),
    audience_network_positions: stringList(t.audience_network_positions),
    messenger_positions: stringList(t.messenger_positions),
    device_platforms: stringList(t.device_platforms),
  };
}

const sorted = (list: string[] | null) => (list ? [...list].sort().join(",") : null);

/** Same placements, ignoring the order of the lists. */
export function placementsEqual(a: PlacementState, b: PlacementState): boolean {
  return PLACEMENT_KEYS.every((key) => sorted(a[key]) === sorted(b[key]));
}

/**
 * Does what Meta returned satisfy what was asked? The platforms and device targeting must match
 * exactly. Positions we set must come back as set; positions we left open ("all positions") may
 * come back filled in by Meta without that being a mismatch.
 */
export function placementsSatisfy(actual: PlacementState, requested: PlacementState): boolean {
  if (sorted(actual.publisher_platforms) !== sorted(requested.publisher_platforms)) return false;
  if (sorted(actual.device_platforms) !== sorted(requested.device_platforms)) return false;
  return (["facebook_positions", "instagram_positions", "audience_network_positions", "messenger_positions"] as const).every(
    (key) => requested[key] === null || sorted(actual[key]) === sorted(requested[key]),
  );
}

/**
 * The targeting object with only the placement settings changed: every other key (places,
 * ages, audiences, exclusions, interests, anything Meta adds later) is carried over exactly.
 * Meta takes a whole targeting object on update, so the caller posts this whole object.
 * The input is never modified.
 */
export function mergePlacements(
  targeting: Record<string, unknown> | null | undefined,
  change: PlacementChange,
): { targeting: Record<string, unknown>; before: PlacementState; after: PlacementState } {
  if (!targeting || typeof targeting !== "object" || Array.isArray(targeting)) {
    refuse("Could not read this ad set's targeting.");
  }
  const before = placementStateOf(targeting);
  const next: Record<string, unknown> = { ...targeting };
  const positionKeys = PLATFORMS.map((p) => `${p}_positions` as const);

  if (change.advantage_placements && change.publisher_platforms) {
    refuse("Set advantage_placements or publisher_platforms, not both.");
  }

  if (change.advantage_placements) {
    for (const key of positionKeys) {
      if (change[key]?.length) refuse(`${key} is not selected: automatic (Advantage+) placements take no positions.`);
    }
    for (const key of PLACEMENT_KEYS) delete next[key];
  } else {
    if (!change.publisher_platforms) refuse("Provide advantage_placements or publisher_platforms.");
    const platforms = [...new Set(change.publisher_platforms)];
    if (!platforms.length) refuse("At least one placement must remain.");
    for (const p of platforms) {
      if (!(PLATFORMS as readonly string[]).includes(p)) refuse(`Unknown placement platform "${p}".`);
    }
    for (const platform of PLATFORMS) {
      const key = `${platform}_positions` as const;
      const given = change[key];
      if (given?.length && !platforms.includes(platform)) {
        refuse(`${key} was given for ${platform}, which is not selected.`);
      }
      if (given?.length && !given.every((x) => /^[a-z_]+$/.test(x))) refuse(`${key} has a position that is not a valid name.`);
    }
    next.publisher_platforms = platforms;
    for (const platform of PLATFORMS) {
      const key = `${platform}_positions` as const;
      if (!platforms.includes(platform)) {
        delete next[key];
        continue;
      }
      // A list the operator gave replaces what is there; an empty list means "all positions" and
      // clears it; nothing given keeps what is there. Positions are never invented: a platform
      // that ran everywhere before still does.
      const asked = change[key];
      let positions: string[] | null = asked !== undefined ? (asked.length ? [...asked] : null) : stringList(targeting[key]);
      if (positions && platform === "facebook") {
        // video_feeds is deprecated in Meta's current API.
        const usable = positions.filter((x) => x !== "video_feeds");
        if (!usable.length && asked?.length) refuse("video_feeds is no longer a Facebook position, so there is nothing left to set.");
        positions = usable.length ? usable : null;
      }
      if (positions) next[key] = positions;
      else delete next[key];
    }
    if (change.device_platforms !== undefined) {
      if (change.device_platforms.length) next.device_platforms = [...change.device_platforms];
      else delete next.device_platforms;
    }
  }
  return { targeting: next, before, after: placementStateOf(next) };
}

// ---------------------------------------------------------------- audience exclusions

export type ExclusionChange = {
  /** Custom audience ids to exclude. */
  add?: string[];
  /** Custom audience ids to stop excluding. */
  remove?: string[];
};

const idOfAudience = (item: unknown): string => {
  if (typeof item === "string" || typeof item === "number") return String(item).trim();
  if (item && typeof item === "object" && "id" in item) return String((item as { id: unknown }).id).trim();
  return "";
};

/** The ids of the custom audiences a targeting object excludes. */
export function excludedIdsOf(targeting: unknown): string[] {
  const list = (targeting as { excluded_custom_audiences?: unknown } | null)?.excluded_custom_audiences;
  return Array.isArray(list) ? list.map(idOfAudience).filter(Boolean) : [];
}

/** The same ids, ignoring order. */
export function sameIds(a: string[], b: string[]): boolean {
  return [...a].sort().join(",") === [...b].sort().join(",");
}

/**
 * The targeting object with only the excluded custom audiences changed: every other key is
 * carried over exactly, and exclusions that stay keep their names. The input is never modified.
 */
export function mergeExclusions(
  targeting: Record<string, unknown> | null | undefined,
  change: ExclusionChange,
): { targeting: Record<string, unknown>; before: string[]; after: string[] } {
  if (!targeting || typeof targeting !== "object" || Array.isArray(targeting)) {
    refuse("Could not read this ad set's targeting.");
  }
  const clean = (ids: string[] | undefined) => [...new Set((ids ?? []).map((id) => String(id).trim()).filter(Boolean))];
  const add = clean(change.add);
  const remove = clean(change.remove);
  if (!add.length && !remove.length) {
    refuse("Provide add_excluded_custom_audiences or remove_excluded_custom_audiences.");
  }
  if (add.some((id) => remove.includes(id))) refuse("The same audience is in both add and remove.");

  const included = new Set(
    (Array.isArray(targeting.custom_audiences) ? targeting.custom_audiences : []).map(idOfAudience).filter(Boolean),
  );
  for (const id of add) {
    if (included.has(id)) refuse(`Audience ${id} is already targeted (included) in this ad set, so it can't also be excluded.`);
  }

  const existing = Array.isArray(targeting.excluded_custom_audiences) ? targeting.excluded_custom_audiences : [];
  const kept = existing.filter((item) => !remove.includes(idOfAudience(item)));
  const have = new Set(kept.map(idOfAudience));
  for (const id of add) {
    if (!have.has(id)) {
      kept.push({ id });
      have.add(id);
    }
  }
  const next: Record<string, unknown> = { ...targeting };
  if (kept.length) next.excluded_custom_audiences = kept;
  else delete next.excluded_custom_audiences;
  return { targeting: next, before: excludedIdsOf(targeting), after: kept.map(idOfAudience) };
}
