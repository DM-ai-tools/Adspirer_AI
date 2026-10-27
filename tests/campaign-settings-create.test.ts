import { describe, expect, it } from "vitest";
import {
  buildMetaTargeting,
  destinationTypeFor,
  optimizationForObjective,
} from "@/lib/meta/targeting-builder";
import { createMetaImageCampaignSchema } from "@/lib/tools/execute/schemas";
import { normalizeMetaApprovalArgs } from "@/lib/meta/normalize-approval-args";

const baseArgs = {
  account_id: "act_123456",
  campaign_name: "TR_Leads_Broad_AU_202610",
  primary_text: "Primary text",
  headline: "Headline",
  landing_page_url: "https://example.com",
  budget_daily: 20,
  locations: ["AU"],
};

describe("optimizationForObjective", () => {
  it("keeps today's derivation when no goal is chosen", () => {
    expect(optimizationForObjective("OUTCOME_LEADS", { pixel_id: "1" })).toEqual({
      optimization_goal: "OFFSITE_CONVERSIONS",
      billing_event: "IMPRESSIONS",
    });
    expect(optimizationForObjective("OUTCOME_TRAFFIC")).toEqual({
      optimization_goal: "LINK_CLICKS",
      billing_event: "IMPRESSIONS",
    });
    expect(optimizationForObjective("OUTCOME_ENGAGEMENT")).toEqual({
      optimization_goal: "POST_ENGAGEMENT",
      billing_event: "IMPRESSIONS",
    });
    expect(optimizationForObjective("OUTCOME_AWARENESS")).toEqual({
      optimization_goal: "REACH",
      billing_event: "IMPRESSIONS",
    });
  });

  it("uses a chosen goal that is valid for the objective", () => {
    const out = optimizationForObjective("OUTCOME_TRAFFIC", {
      extra_args: { optimization_goal: "LANDING_PAGE_VIEWS", conversion_location: "website" },
    });
    expect(out.optimization_goal).toBe("LANDING_PAGE_VIEWS");
    expect(out.billing_event).toBe("IMPRESSIONS");
  });

  it("rejects a goal that does not fit the objective", () => {
    expect(() =>
      optimizationForObjective("OUTCOME_TRAFFIC", { extra_args: { optimization_goal: "REACH" } }),
    ).toThrow(/not a valid performance goal/);
  });

  it("rejects a conversion goal chosen without a pixel", () => {
    expect(() =>
      optimizationForObjective("OUTCOME_LEADS", {
        extra_args: { optimization_goal: "OFFSITE_CONVERSIONS", conversion_location: "website" },
      }),
    ).toThrow();
  });
});

describe("buildMetaTargeting device and OS", () => {
  it("writes device platforms, devices and OS when given", () => {
    const targeting = buildMetaTargeting({
      locations: ["AU"],
      extra_args: {
        device_platforms: ["mobile"],
        user_device: ["iPhone"],
        user_os: ["iOS"],
      },
    });
    expect(targeting.device_platforms).toEqual(["mobile"]);
    expect(targeting.user_device).toEqual(["iPhone"]);
    expect(targeting.user_os).toEqual(["iOS"]);
  });

  it("leaves them off when not given", () => {
    const targeting = buildMetaTargeting({ locations: ["AU"] });
    expect(targeting).not.toHaveProperty("device_platforms");
    expect(targeting).not.toHaveProperty("user_device");
    expect(targeting).not.toHaveProperty("user_os");
  });
});

describe("destinationTypeFor", () => {
  it("maps conversion locations to Meta destination types", () => {
    expect(destinationTypeFor({ conversion_location: "website" })).toBe("WEBSITE");
    expect(destinationTypeFor({ conversion_location: "instant_form" })).toBe("ON_AD");
  });

  it("keeps today's behaviour when no location is chosen", () => {
    expect(destinationTypeFor({ leadFormId: "55" })).toBe("ON_AD");
    expect(destinationTypeFor({})).toBeUndefined();
    expect(destinationTypeFor({ destination_type: "ON_AD" })).toBe("ON_AD");
  });
});

describe("create tool schema", () => {
  it("accepts the new fields", () => {
    const parsed = createMetaImageCampaignSchema.parse({
      ...baseArgs,
      optimization_goal: "LEAD_GENERATION",
      conversion_location: "instant_form",
      device_platforms: ["mobile"],
      user_device: ["iPhone"],
      user_os: ["iOS"],
      campaign_budget_optimization: true,
    });
    expect(parsed.optimization_goal).toBe("LEAD_GENERATION");
    expect(parsed.conversion_location).toBe("instant_form");
    expect(parsed.user_os).toEqual(["iOS"]);
  });

  it("rejects messaging, calls and app as not supported yet", () => {
    for (const location of ["messaging", "calls", "app"]) {
      const result = createMetaImageCampaignSchema.safeParse({
        ...baseArgs,
        conversion_location: location,
      });
      expect(result.success, location).toBe(false);
      if (!result.success) expect(JSON.stringify(result.error.issues)).toContain("not supported yet");
    }
  });

  it("still parses args that use none of the new fields", () => {
    expect(createMetaImageCampaignSchema.safeParse(baseArgs).success).toBe(true);
  });
});

describe("normalizeMetaApprovalArgs", () => {
  it("keeps the new fields", () => {
    const out = normalizeMetaApprovalArgs("create_meta_image_campaign", {
      ...baseArgs,
      optimization_goal: "LEAD_GENERATION",
      conversion_location: "instant_form",
      device_platforms: ["mobile"],
      user_device: ["iPhone"],
      user_os: ["iOS"],
    });
    expect(out.optimization_goal).toBe("LEAD_GENERATION");
    expect(out.conversion_location).toBe("instant_form");
    expect(out.device_platforms).toEqual(["mobile"]);
    expect(out.user_device).toEqual(["iPhone"]);
    expect(out.user_os).toEqual(["iOS"]);
  });
});

describe("approval execution passthrough", () => {
  it("forwards the card's settings to the ad set builder", async () => {
    const { collectPassthrough } = await import("@/lib/approvals/executor");
    const extra = collectPassthrough({
      ...baseArgs,
      optimization_goal: "LEAD_GENERATION",
      conversion_location: "instant_form",
      device_platforms: ["mobile"],
      user_device: ["iPhone"],
      user_os: ["iOS"],
    });
    expect(extra).toMatchObject({
      optimization_goal: "LEAD_GENERATION",
      conversion_location: "instant_form",
      device_platforms: ["mobile"],
      user_device: ["iPhone"],
      user_os: ["iOS"],
    });
  });
});

describe("final review fixes: targeting builder", () => {
  it("C1: Engagement and Awareness accept their chosen goal without a conversion location", () => {
    expect(
      optimizationForObjective("OUTCOME_ENGAGEMENT", { extra_args: { optimization_goal: "POST_ENGAGEMENT" } }).optimization_goal,
    ).toBe("POST_ENGAGEMENT");
    expect(
      optimizationForObjective("OUTCOME_AWARENESS", { extra_args: { optimization_goal: "IMPRESSIONS" } }).optimization_goal,
    ).toBe("IMPRESSIONS");
    expect(
      optimizationForObjective("OUTCOME_AWARENESS", { extra_args: { optimization_goal: "REACH" } }).optimization_goal,
    ).toBe("REACH");
  });

  it("I4: a website location ignores a lead form, so the pixel goes in the promoted object", async () => {
    const { buildPromotedObject, resolveLeadFormId } = await import("@/lib/meta/targeting-builder");
    const extra = { conversion_location: "website", lead_form_id: "55", pixel_id: "9" };
    expect(resolveLeadFormId({ lead_form_id: "55", extra_args: extra })).toBeUndefined();
    expect(
      buildPromotedObject({
        objective: "OUTCOME_LEADS",
        lead_form_id: "55",
        facebook_page_id: "p1",
        pixel_id: "9",
        extra_args: extra,
      }),
    ).toMatchObject({ pixel_id: "9", custom_event_type: "LEAD" });
  });

  it("I4: an instant-form location keeps using the lead form", async () => {
    const { resolveLeadFormId } = await import("@/lib/meta/targeting-builder");
    expect(
      resolveLeadFormId({ extra_args: { conversion_location: "instant_form", lead_form_id: "55" } }),
    ).toBe("55");
  });

  it("I8: a destination type that contradicts the conversion location is rejected", () => {
    expect(() =>
      destinationTypeFor({ conversion_location: "website", destination_type: "MESSENGER" }),
    ).toThrow(/destination_type/);
    expect(destinationTypeFor({ conversion_location: "website", destination_type: "WEBSITE" })).toBe("WEBSITE");
  });

  it("I8: a chosen goal that the bid strategy would override is rejected, not changed", async () => {
    const { reconcileGoalWithBid } = await import("@/lib/meta/targeting-builder");
    expect(reconcileGoalWithBid("OFFSITE_CONVERSIONS", undefined, false)).toBe("OFFSITE_CONVERSIONS");
    expect(reconcileGoalWithBid("OFFSITE_CONVERSIONS", undefined, true)).toBe("VALUE");
    expect(reconcileGoalWithBid("VALUE", "VALUE", true)).toBe("VALUE");
    expect(() => reconcileGoalWithBid("OFFSITE_CONVERSIONS", "OFFSITE_CONVERSIONS", true)).toThrow(/minimum ROAS|VALUE/);
  });
});
