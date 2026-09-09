import { describe, expect, it } from "vitest";
import {
  buildMetaTargeting,
  optimizationForObjective,
} from "@/lib/meta/targeting-builder";

describe("buildMetaTargeting", () => {
  it("maps locations, audiences, interests, placements", () => {
    const targeting = buildMetaTargeting({
      age_min: 25,
      age_max: 54,
      genders: ["female"],
      locations: [
        "IN",
        {
          key: "1021841",
          type: "city",
          radius: 20,
          distance_unit: "kilometer",
        },
      ],
      publisher_platforms: ["facebook", "instagram"],
      extra_args: {
        custom_audiences: ["1201"],
        interests: [{ id: "6001", name: "Fitness" }],
        behaviors: [{ id: "7001", name: "Engaged shoppers" }],
        facebook_positions: ["feed"],
      },
    });

    expect(targeting.age_min).toBe(25);
    expect(targeting.genders).toEqual([2]);
    expect(targeting.geo_locations).toEqual({
      countries: ["IN"],
      cities: [
        { key: "1021841", radius: 20, distance_unit: "kilometer" },
      ],
    });
    expect(targeting.custom_audiences).toEqual([{ id: "1201" }]);
    expect(targeting.flexible_spec).toEqual([
      {
        interests: [{ id: "6001", name: "Fitness" }],
        behaviors: [{ id: "7001", name: "Engaged shoppers" }],
      },
    ]);
    expect(targeting.publisher_platforms).toEqual(["facebook", "instagram"]);
    expect(targeting.facebook_positions).toEqual(["feed"]);
  });

  it("defaults geo to US when no locations provided", () => {
    const targeting = buildMetaTargeting({});
    expect(targeting.geo_locations).toEqual({ countries: ["US"] });
  });
});

describe("optimizationForObjective", () => {
  it("maps sales to offsite conversions when pixel_id is set", () => {
    expect(
      optimizationForObjective("OUTCOME_SALES", {
        pixel_id: "123456789",
      }).optimization_goal,
    ).toBe("OFFSITE_CONVERSIONS");
  });

  it("falls back to link clicks for sales/leads without a pixel", () => {
    expect(optimizationForObjective("OUTCOME_SALES").optimization_goal).toBe(
      "LINK_CLICKS",
    );
    expect(optimizationForObjective("OUTCOME_LEADS").optimization_goal).toBe(
      "LINK_CLICKS",
    );
  });
});
