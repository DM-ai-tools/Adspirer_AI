import { describe, expect, it } from "vitest";
import {
  targetingSelectionToCreateArgs,
  parseCustomAudiences,
  parseTargetingOptions,
} from "@/lib/adspirer/targeting";

describe("targetingSelectionToCreateArgs", () => {
  it("maps picker selections into Adspirer create fields", () => {
    const args = targetingSelectionToCreateArgs({
      custom_audiences: [{ id: "1201", name: "Visitors" }],
      excluded_custom_audiences: [],
      interests: [{ id: "6001", name: "Digital marketing" }],
      behaviors: [{ id: "7001", name: "Engaged shoppers" }],
      locations: [{ id: "AU", name: "Australia", key: "AU" }],
    });
    expect(args.custom_audiences).toEqual(["1201"]);
    expect(args.interests).toEqual([
      { id: "6001", name: "Digital marketing" },
    ]);
    expect(args.behaviors).toEqual([{ id: "7001", name: "Engaged shoppers" }]);
    expect(args.locations).toEqual(["AU"]);
  });

  it("sends country codes as strings and cities as keyed objects with radius", () => {
    const args = targetingSelectionToCreateArgs({
      custom_audiences: [],
      excluded_custom_audiences: [],
      interests: [],
      behaviors: [],
      locations: [
        { id: "US", name: "United States", key: "US", type: "country" },
        {
          id: "812057",
          name: "London",
          key: "812057",
          type: "city",
          radius: 15,
          distance_unit: "kilometer",
        },
      ],
    });
    expect(args.locations).toEqual([
      "US",
      { key: "812057", type: "city", radius: 15, distance_unit: "kilometer" },
    ]);
  });
});

describe("Adspirer targeting parsers", () => {
  it("reads audiences from structured payloads", () => {
    const audiences = parseCustomAudiences({
      text: "",
      structured: {
        audiences: [
          { id: "1", name: "Lookalike", subtype: "LOOKALIKE", approximate_count: 1000 },
        ],
      },
    });
    expect(audiences).toHaveLength(1);
    expect(audiences[0].name).toBe("Lookalike");
  });

  it("reads audiences from the markdown table Adspirer actually returns", () => {
    const audiences = parseCustomAudiences({
      text: [
        "**Custom Audiences for Ad Account 3946886575540648**",
        "",
        "**Total: 3 audiences**",
        "",
        "| ID | Name | Type | Size | Status |",
        "|----|------|------|------|--------|",
        "| `120238928082860685` | Lookalike (AU, 1% to 2%) - Traffic Ra... | LOOKALIKE | -1 | Expired |",
        "| `120238928077070685` | Traffic Radius Qualified Prospects Li... | CUSTOM | 1,900 | Active |",
        "| `120211314618730685` | Traffic Radius Instagram Engagers | IG_BUSINESS | 1,200 | Active |",
        "",
        "**Usage:** Pass audience IDs to campaign creation tools:",
      ].join("\n"),
      structured: null,
    });
    expect(audiences).toHaveLength(3);
    expect(audiences[1]).toMatchObject({
      id: "120238928077070685",
      subtype: "CUSTOM",
      approximate_count: 1900,
      delivery_status: "Active",
    });
    expect(audiences[0].approximate_count).toBeNull();
    expect(audiences[2].name).toBe("Traffic Radius Instagram Engagers");
  });

  it("reads locations from a targeting table when structured is absent", () => {
    const options = parseTargetingOptions(
      {
        text: [
          "## Meta Targeting Search: Location",
          "",
          "| Location | Key | Type | Country | Region |",
          "|----------|-----|------|---------|--------|",
          "| United States | US | country | United States | N/A |",
          "| London | 812057 | city | United Kingdom | England |",
        ].join("\n"),
        structured: null,
      },
      "location",
    );
    expect(options[0]).toMatchObject({
      id: "US",
      name: "United States",
      type: "country",
      key: "US",
    });
    expect(options[1]).toMatchObject({
      id: "812057",
      name: "London",
      type: "city",
      path: "England, United Kingdom",
    });
  });

  it("keeps interest paths and lower-bound sizes from structured results", () => {
    const options = parseTargetingOptions(
      {
        text: "",
        structured: {
          results: [
            {
              id: "6003384248805",
              name: "Fitness and wellness",
              type: "interest",
              audience_size_lower_bound: 1_083_752_219,
              path: ["Interests", "Fitness and wellness"],
            },
          ],
        },
      },
      "interest",
    );
    expect(options[0]).toMatchObject({
      id: "6003384248805",
      audience_size: 1_083_752_219,
      path: "Interests > Fitness and wellness",
    });
  });

  it("reads interests from structured search results", () => {
    const options = parseTargetingOptions(
      {
        text: "",
        structured: {
          results: [{ id: "6001", name: "Fitness", audience_size: 50_000 }],
        },
      },
      "interest",
    );
    expect(options[0]).toMatchObject({ id: "6001", name: "Fitness", type: "interest" });
  });
});
