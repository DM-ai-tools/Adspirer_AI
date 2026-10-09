import { describe, expect, it } from "vitest";
import {
  buildMetaTargeting,
  buildPromotedObject,
  hasTargetingLocation,
  normalizeCallToAction,
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
    // Ids only: Meta resolves names itself and rejects stale/mismatched names.
    expect(targeting.flexible_spec).toEqual([
      {
        interests: [{ id: "6001" }],
        behaviors: [{ id: "7001" }],
      },
    ]);
    expect(targeting.publisher_platforms).toEqual(["facebook", "instagram"]);
    expect(targeting.facebook_positions).toEqual(["feed"]);
  });

  it("rejects targeting without a location instead of defaulting to US", () => {
    expect(() => buildMetaTargeting({})).toThrow(/No targeting location/);
    expect(() => buildMetaTargeting({ locations: ["not-a-country"] })).toThrow(
      /No targeting location/,
    );
    expect(hasTargetingLocation([])).toBe(false);
    expect(hasTargetingLocation(["gb"])).toBe(true);
  });

  it("sets Advantage+ audience explicitly (off unless requested)", () => {
    expect(buildMetaTargeting({ locations: ["GB"] }).targeting_automation).toEqual({
      advantage_audience: 0,
    });
    expect(
      buildMetaTargeting({
        locations: ["GB"],
        extra_args: { advantage_audience: true },
      }).targeting_automation,
    ).toEqual({ advantage_audience: 1 });
  });

  it("maps job titles / employers / life events into flexible_spec", () => {
    const targeting = buildMetaTargeting({
      locations: ["GB"],
      extra_args: {
        job_titles: [{ id: "101" }],
        work_employers: ["202"],
        life_events: [{ id: "303", name: "New job" }],
      },
    });
    expect(targeting.flexible_spec).toEqual([
      {
        work_positions: [{ id: "101" }],
        work_employers: [{ id: "202" }],
        life_events: [{ id: "303" }],
      },
    ]);
  });
});

describe("buildPromotedObject", () => {
  it("defaults the pixel event to LEAD for OUTCOME_LEADS", () => {
    expect(
      buildPromotedObject({ objective: "OUTCOME_LEADS", pixel_id: "999" }),
    ).toEqual({ pixel_id: "999", custom_event_type: "LEAD" });
  });

  it("keeps PURCHASE for OUTCOME_SALES and honours an explicit event", () => {
    expect(
      buildPromotedObject({ objective: "OUTCOME_SALES", pixel_id: "999" }),
    ).toEqual({ pixel_id: "999", custom_event_type: "PURCHASE" });
    expect(
      buildPromotedObject({
        objective: "OUTCOME_LEADS",
        pixel_id: "999",
        pixel_event_name: "complete_registration",
      }),
    ).toEqual({ pixel_id: "999", custom_event_type: "COMPLETE_REGISTRATION" });
  });

  it("uses the page only for instant-form lead ads", () => {
    expect(
      buildPromotedObject({
        objective: "OUTCOME_LEADS",
        pixel_id: "999",
        lead_form_id: "555",
        facebook_page_id: "777",
      }),
    ).toEqual({ page_id: "777" });
    expect(
      optimizationForObjective("OUTCOME_LEADS", {
        extra_args: { lead_form_id: "555" },
      }).optimization_goal,
    ).toBe("LEAD_GENERATION");
  });
});

describe("normalizeCallToAction", () => {
  it("normalises friendly spellings and rejects unknown CTAs", () => {
    expect(normalizeCallToAction("Learn more")).toBe("LEARN_MORE");
    expect(normalizeCallToAction("book-now")).toBe("BOOK_NOW");
    expect(normalizeCallToAction(undefined)).toBeUndefined();
    expect(() => normalizeCallToAction("CLICK_HERE")).toThrow(/not a Meta button type/);
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
