import { describe, expect, it } from "vitest";
import { excludedIdsOf, mergeExclusions, sameIds } from "@/lib/meta/adset-edits";

const targeting = () => ({
  geo_locations: { countries: ["AU"] },
  age_min: 25,
  age_max: 55,
  targeting_automation: { advantage_audience: 1 },
  flexible_spec: [{ interests: [{ id: "600", name: "Dental" }] }],
  custom_audiences: [{ id: "10", name: "Website visitors" }],
  excluded_custom_audiences: [
    { id: "2", name: "Customers" },
    { id: "3", name: "Recent leads" },
  ],
  publisher_platforms: ["facebook"],
  facebook_positions: ["feed"],
  something_meta_adds_later: { x: 1 },
});

const withoutExclusions = (t: Record<string, unknown>) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "excluded_custom_audiences"));

describe("excludedIdsOf", () => {
  it("reads the ids, whatever shape Meta returns", () => {
    expect(excludedIdsOf(targeting())).toEqual(["2", "3"]);
    expect(excludedIdsOf({ excluded_custom_audiences: [{ id: 5 }, "6"] })).toEqual(["5", "6"]);
    expect(excludedIdsOf({})).toEqual([]);
    expect(excludedIdsOf(null)).toEqual([]);
  });
});

describe("mergeExclusions", () => {
  it("adds an exclusion, keeps the existing ones with their names, and changes nothing else", () => {
    const input = targeting();
    const out = mergeExclusions(input, { add: ["4"] });
    expect(out.before).toEqual(["2", "3"]);
    expect(out.after).toEqual(["2", "3", "4"]);
    expect(out.targeting.excluded_custom_audiences).toEqual([{ id: "2", name: "Customers" }, { id: "3", name: "Recent leads" }, { id: "4" }]);
    expect(withoutExclusions(out.targeting)).toEqual(withoutExclusions(targeting()));
    expect(input).toEqual(targeting());
  });

  it("removes only the audiences named", () => {
    const out = mergeExclusions(targeting(), { remove: ["2"] });
    expect(out.after).toEqual(["3"]);
    expect(out.targeting.excluded_custom_audiences).toEqual([{ id: "3", name: "Recent leads" }]);
  });

  it("removing the last exclusion removes the key", () => {
    const out = mergeExclusions(targeting(), { remove: ["2", "3"] });
    expect("excluded_custom_audiences" in out.targeting).toBe(false);
    expect(out.after).toEqual([]);
  });

  it("adding one already excluded does not duplicate it", () => {
    const out = mergeExclusions(targeting(), { add: ["2", "2", "4"] });
    expect(out.after).toEqual(["2", "3", "4"]);
  });

  it("add and remove together", () => {
    expect(mergeExclusions(targeting(), { add: ["4"], remove: ["2"] }).after).toEqual(["3", "4"]);
  });

  it("refuses to exclude an audience the ad set targets", () => {
    expect(() => mergeExclusions(targeting(), { add: ["10"] })).toThrow(/already targeted.*Nothing was changed/);
  });

  it("refuses the same audience in both lists", () => {
    expect(() => mergeExclusions(targeting(), { add: ["4"], remove: ["4"] })).toThrow(/both/);
  });

  it("refuses an empty request", () => {
    expect(() => mergeExclusions(targeting(), {})).toThrow(/Provide/);
  });

  it("refuses an ad set whose targeting could not be read", () => {
    expect(() => mergeExclusions(null, { add: ["4"] })).toThrow(/targeting.*Nothing was changed/);
  });
});

describe("sameIds", () => {
  it("ignores order", () => {
    expect(sameIds(["1", "2"], ["2", "1"])).toBe(true);
    expect(sameIds(["1"], ["1", "2"])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
});
