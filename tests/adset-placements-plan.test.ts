import { describe, expect, it } from "vitest";
import { mergePlacements, placementStateOf, placementsEqual, type PlacementState } from "@/lib/meta/adset-edits";

const PLACEMENT_KEYS = [
  "publisher_platforms",
  "facebook_positions",
  "instagram_positions",
  "audience_network_positions",
  "messenger_positions",
  "device_platforms",
];

/** A realistic ad set targeting object: everything an ad set carries, not just placements. */
const targeting = () => ({
  geo_locations: { countries: ["AU"], location_types: ["home", "recent"] },
  age_min: 25,
  age_max: 55,
  genders: [1],
  flexible_spec: [{ interests: [{ id: "600", name: "Dental" }] }],
  custom_audiences: [{ id: "1" }],
  excluded_custom_audiences: [{ id: "2" }],
  targeting_automation: { advantage_audience: 1 },
  some_key_added_by_meta_later: { x: 1 },
  publisher_platforms: ["facebook", "instagram", "audience_network"],
  facebook_positions: ["feed", "story"],
  instagram_positions: ["stream", "reels"],
  audience_network_positions: ["classic"],
  device_platforms: ["mobile"],
});

const withoutPlacements = (t: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(t).filter(([k]) => !PLACEMENT_KEYS.includes(k)));

describe("placementStateOf", () => {
  it("reads the six placement keys, with null meaning automatic", () => {
    expect(placementStateOf(targeting())).toEqual({
      publisher_platforms: ["facebook", "instagram", "audience_network"],
      facebook_positions: ["feed", "story"],
      instagram_positions: ["stream", "reels"],
      audience_network_positions: ["classic"],
      messenger_positions: null,
      device_platforms: ["mobile"],
    });
    expect(placementStateOf({ geo_locations: {} }).publisher_platforms).toBeNull();
    expect(placementStateOf(null).publisher_platforms).toBeNull();
  });
});

describe("mergePlacements", () => {
  it("removing one platform changes only the placement keys: everything else is kept exactly", () => {
    const input = targeting();
    const out = mergePlacements(input, {
      publisher_platforms: ["facebook", "instagram"],
      facebook_positions: ["feed", "story"],
      instagram_positions: ["stream", "reels"],
    });
    expect(withoutPlacements(out.targeting)).toEqual(withoutPlacements(targeting()));
    expect(out.targeting.publisher_platforms).toEqual(["facebook", "instagram"]);
    expect("audience_network_positions" in out.targeting).toBe(false);
    expect(out.targeting.device_platforms).toEqual(["mobile"]);
    expect(out.before.publisher_platforms).toEqual(["facebook", "instagram", "audience_network"]);
    expect(out.after.publisher_platforms).toEqual(["facebook", "instagram"]);
    // The input object is never modified.
    expect(input).toEqual(targeting());
  });

  it("a platform kept without new positions keeps the ones it has; one newly added gets none unless named (all positions); unchosen platforms lose theirs", () => {
    const out = mergePlacements(targeting(), { publisher_platforms: ["instagram", "messenger"] });
    expect(out.targeting.instagram_positions).toEqual(["stream", "reels"]);
    expect("messenger_positions" in out.targeting).toBe(false);
    expect("facebook_positions" in out.targeting).toBe(false);
    expect("audience_network_positions" in out.targeting).toBe(false);
  });

  it("automatic (Advantage+) placements remove all six keys and keep the rest", () => {
    const out = mergePlacements(targeting(), { advantage_placements: true });
    for (const key of PLACEMENT_KEYS) expect(key in out.targeting, key).toBe(false);
    expect(out.targeting).toEqual(withoutPlacements(targeting()));
    expect(out.after).toEqual({
      publisher_platforms: null,
      facebook_positions: null,
      instagram_positions: null,
      audience_network_positions: null,
      messenger_positions: null,
      device_platforms: null,
    });
  });

  it("moving from automatic to manual works", () => {
    const out = mergePlacements(withoutPlacements(targeting()), { publisher_platforms: ["facebook"] });
    expect(out.before.publisher_platforms).toBeNull();
    expect(out.targeting.publisher_platforms).toEqual(["facebook"]);
    expect("facebook_positions" in out.targeting).toBe(false);
  });

  it("refuses positions for a platform that is not chosen", () => {
    expect(() => mergePlacements(targeting(), { publisher_platforms: ["facebook"], instagram_positions: ["stream"] })).toThrow(
      /instagram_positions.*not selected/,
    );
    expect(() => mergePlacements(targeting(), { advantage_placements: true, facebook_positions: ["feed"] })).toThrow(/not selected|Advantage/);
  });

  it("refuses to leave no placement at all", () => {
    expect(() => mergePlacements(targeting(), { publisher_platforms: [] })).toThrow(/At least one placement must remain/);
    expect(() => mergePlacements(targeting(), {})).toThrow(/Provide advantage_placements or publisher_platforms/);
  });

  it("refuses both automatic and manual placements together", () => {
    expect(() => mergePlacements(targeting(), { advantage_placements: true, publisher_platforms: ["facebook"] })).toThrow(/not both/);
  });

  it("drops the deprecated video_feeds position", () => {
    const out = mergePlacements(targeting(), { publisher_platforms: ["facebook"], facebook_positions: ["feed", "video_feeds"] });
    expect(out.targeting.facebook_positions).toEqual(["feed"]);
  });

  it("device targeting: provided replaces, empty clears, absent keeps", () => {
    expect(mergePlacements(targeting(), { publisher_platforms: ["facebook"], device_platforms: ["desktop"] }).targeting.device_platforms).toEqual(["desktop"]);
    expect("device_platforms" in mergePlacements(targeting(), { publisher_platforms: ["facebook"], device_platforms: [] }).targeting).toBe(false);
    expect(mergePlacements(targeting(), { publisher_platforms: ["facebook"] }).targeting.device_platforms).toEqual(["mobile"]);
  });

  it("an ad set that has no targeting object cannot be edited", () => {
    expect(() => mergePlacements(null, { advantage_placements: true })).toThrow(/targeting.*Nothing was changed/);
  });
});

describe("placementsEqual", () => {
  const a: PlacementState = placementStateOf(targeting());
  it("ignores order and compares null with null", () => {
    expect(placementsEqual(a, { ...a, publisher_platforms: ["audience_network", "facebook", "instagram"] })).toBe(true);
    expect(placementsEqual(a, { ...a, facebook_positions: ["feed"] })).toBe(false);
    expect(placementsEqual(placementStateOf({}), placementStateOf({}))).toBe(true);
    expect(placementsEqual(a, placementStateOf({}))).toBe(false);
  });
});
