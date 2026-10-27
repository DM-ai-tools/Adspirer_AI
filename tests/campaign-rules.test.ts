import { describe, expect, it } from "vitest";
import {
  attributionOptionsFor,
  conversionLocationsFor,
  performanceGoalsFor,
  suggestCampaignSettings,
  validateCampaignSettings,
  type CampaignObjective,
} from "@/lib/meta/campaign-rules";

const ctx = (objective: CampaignObjective, over = {}) => ({
  objective,
  hasPixel: true,
  hasLeadForm: true,
  ...over,
});

describe("conversionLocationsFor", () => {
  it("lists the five locations for Leads, with messaging, calls and app unsupported", () => {
    const options = conversionLocationsFor("OUTCOME_LEADS");
    expect(options.map((o) => o.id)).toEqual([
      "website",
      "instant_form",
      "messaging",
      "calls",
      "app",
    ]);
    for (const id of ["messaging", "calls", "app"]) {
      const option = options.find((o) => o.id === id)!;
      expect(option.supported).toBe(false);
      expect(option.unsupportedReason).toBe("not supported yet");
    }
    expect(options.find((o) => o.id === "website")!.supported).toBe(true);
    expect(options.find((o) => o.id === "instant_form")!.supported).toBe(true);
  });

  it("has no conversion location for Engagement and Awareness", () => {
    expect(conversionLocationsFor("OUTCOME_ENGAGEMENT")).toEqual([]);
    expect(conversionLocationsFor("OUTCOME_AWARENESS")).toEqual([]);
  });
});

describe("performanceGoalsFor", () => {
  const ids = (objective: CampaignObjective, location?: Parameters<typeof performanceGoalsFor>[1]) =>
    performanceGoalsFor(objective, location).map((g) => g.id);

  it("pins the goal list per objective and location", () => {
    expect(ids("OUTCOME_SALES", "website")).toEqual(["OFFSITE_CONVERSIONS", "VALUE"]);
    expect(ids("OUTCOME_LEADS", "website")).toEqual(["OFFSITE_CONVERSIONS"]);
    expect(ids("OUTCOME_LEADS", "instant_form")).toEqual(["LEAD_GENERATION"]);
    expect(ids("OUTCOME_TRAFFIC", "website")).toEqual(["LINK_CLICKS", "LANDING_PAGE_VIEWS"]);
    expect(ids("OUTCOME_ENGAGEMENT")).toEqual(["POST_ENGAGEMENT"]);
    expect(ids("OUTCOME_AWARENESS")).toEqual(["REACH", "IMPRESSIONS"]);
  });

  it("marks conversion goals as needing an event and supporting attribution", () => {
    const goal = performanceGoalsFor("OUTCOME_LEADS", "website")[0]!;
    expect(goal.needsEvent).toBe(true);
    expect(goal.supportsAttribution).toBe(true);
    const clicks = performanceGoalsFor("OUTCOME_TRAFFIC", "website")[0]!;
    expect(clicks.needsEvent).toBe(false);
    expect(clicks.supportsAttribution).toBe(false);
  });

  it("returns nothing for an unsupported location", () => {
    expect(ids("OUTCOME_LEADS", "messaging")).toEqual([]);
  });
});

describe("attributionOptionsFor", () => {
  it("offers the three windows for conversion goals only", () => {
    expect(attributionOptionsFor("OFFSITE_CONVERSIONS").map((o) => o.id)).toEqual([
      "7d_click_1d_view",
      "7d_click",
      "1d_click",
    ]);
    expect(attributionOptionsFor("LINK_CLICKS")).toEqual([]);
  });
});

describe("validateCampaignSettings", () => {
  it("accepts an empty selection", () => {
    expect(validateCampaignSettings({}, ctx("OUTCOME_LEADS"))).toEqual({ ok: true });
  });

  it("rejects unsupported conversion locations", () => {
    const result = validateCampaignSettings({ conversion_location: "messaging" }, ctx("OUTCOME_LEADS"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not supported yet");
  });

  it("rejects a conversion goal with no pixel", () => {
    const result = validateCampaignSettings(
      { conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS" },
      ctx("OUTCOME_LEADS", { hasPixel: false }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects instant-form lead generation with no lead form", () => {
    const result = validateCampaignSettings(
      { conversion_location: "instant_form", optimization_goal: "LEAD_GENERATION" },
      ctx("OUTCOME_LEADS", { hasLeadForm: false }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a goal that does not belong to the objective", () => {
    const result = validateCampaignSettings({ optimization_goal: "REACH" }, ctx("OUTCOME_LEADS"));
    expect(result.ok).toBe(false);
  });

  it("rejects bad ages", () => {
    expect(validateCampaignSettings({ age_min: 40, age_max: 30 }, ctx("OUTCOME_TRAFFIC")).ok).toBe(false);
    expect(validateCampaignSettings({ age_min: 16 }, ctx("OUTCOME_TRAFFIC")).ok).toBe(false);
  });

  it("rejects an attribution window on a goal without attribution", () => {
    const result = validateCampaignSettings(
      { conversion_location: "website", optimization_goal: "LINK_CLICKS", attribution: "7d_click" },
      ctx("OUTCOME_TRAFFIC"),
    );
    expect(result.ok).toBe(false);
  });
});

describe("suggestCampaignSettings", () => {
  it("suggests a website conversion setup when a pixel exists", () => {
    const { settings, reasons } = suggestCampaignSettings({
      objective: "OUTCOME_LEADS",
      hasPixel: true,
      hasLeadForm: false,
      pixelEvents: ["Lead", "PageView"],
    });
    expect(settings).toMatchObject({
      conversion_location: "website",
      optimization_goal: "OFFSITE_CONVERSIONS",
      pixel_event_name: "LEAD",
      attribution: "7d_click_1d_view",
      budget_level: "campaign",
    });
    for (const key of ["conversion_location", "optimization_goal", "pixel_event_name", "attribution", "budget_level"] as const) {
      expect(reasons[key]).toBeTruthy();
    }
  });

  it("suggests instant forms when there is a lead form and no pixel", () => {
    const { settings } = suggestCampaignSettings({
      objective: "OUTCOME_LEADS",
      hasPixel: false,
      hasLeadForm: true,
    });
    expect(settings.conversion_location).toBe("instant_form");
    expect(settings.optimization_goal).toBe("LEAD_GENERATION");
  });

  it("keeps a valid stated goal", () => {
    const { settings } = suggestCampaignSettings({
      objective: "OUTCOME_TRAFFIC",
      hasPixel: false,
      hasLeadForm: false,
      stated: { optimization_goal: "LANDING_PAGE_VIEWS" },
    });
    expect(settings.optimization_goal).toBe("LANDING_PAGE_VIEWS");
  });

  it("suggests no conversion fields for Awareness", () => {
    const { settings } = suggestCampaignSettings({
      objective: "OUTCOME_AWARENESS",
      hasPixel: true,
      hasLeadForm: true,
    });
    expect(settings.conversion_location).toBeUndefined();
    expect(settings.pixel_event_name).toBeUndefined();
    expect(settings.optimization_goal).toBe("REACH");
  });
});

describe("suggestion reasons without a pixel", () => {
  it("says the pixel is missing instead of praising conversions", () => {
    const { settings, reasons } = suggestCampaignSettings({
      objective: "OUTCOME_SALES",
      hasPixel: false,
      hasLeadForm: false,
    });
    expect(settings.optimization_goal).toBe("OFFSITE_CONVERSIONS");
    expect(reasons.optimization_goal).toMatch(/no pixel/i);
  });
});

describe("conversion events", () => {
  it("I5: only Meta's own conversion events are accepted", async () => {
    const { META_CONVERSION_EVENTS } = await import("@/lib/meta/campaign-rules");
    expect(META_CONVERSION_EVENTS).toEqual(expect.arrayContaining(["PURCHASE", "LEAD", "COMPLETE_REGISTRATION"]));
    expect(META_CONVERSION_EVENTS).not.toContain("SUBSCRIBED_BUTTON_CLICK");
    expect(META_CONVERSION_EVENTS).not.toContain("MICRODATA");
    const bad = validateCampaignSettings(
      { conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS", pixel_event_name: "MY_CUSTOM_EVENT" },
      ctx("OUTCOME_LEADS"),
    );
    expect(bad.ok).toBe(false);
    const good = validateCampaignSettings(
      { conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS", pixel_event_name: "LEAD" },
      ctx("OUTCOME_LEADS"),
    );
    expect(good.ok).toBe(true);
  });
});
