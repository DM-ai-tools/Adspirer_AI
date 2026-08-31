import { describe, expect, it } from "vitest";
import {
  estimateMetaBudgetImpactCents,
  normalizeMetaApprovalArgs,
} from "@/lib/meta/normalize-approval-args";

describe("normalizeMetaApprovalArgs", () => {
  it("canonicalizes daily_budget to budget_daily", () => {
    const out = normalizeMetaApprovalArgs("create_meta_video_campaign", {
      daily_budget: 5,
      account_id: "act_1",
    });
    expect(out.budget_daily).toBe(5);
    expect(out.daily_budget).toBeUndefined();
  });

  it("strips radius from region locations", () => {
    const out = normalizeMetaApprovalArgs("create_meta_video_campaign", {
      locations: [
        {
          key: "123",
          type: "region",
          radius: 25,
          distance_unit: "kilometer",
        },
      ],
    });
    const loc = (out.locations as Array<Record<string, unknown>>)[0];
    expect(loc.type).toBe("region");
    expect(loc.radius).toBeUndefined();
  });

  it("keeps radius on city locations", () => {
    const out = normalizeMetaApprovalArgs("create_meta_video_campaign", {
      locations: [
        {
          key: "2420605",
          type: "city",
          radius: 25,
          distance_unit: "kilometer",
        },
      ],
    });
    const loc = (out.locations as Array<Record<string, unknown>>)[0];
    expect(loc.radius).toBe(25);
  });

  it("normalizes custom audiences to ID strings", () => {
    const out = normalizeMetaApprovalArgs("create_meta_video_campaign", {
      custom_audiences: [
        { id: "6002714898572", name: "Small business owners", approximate_count: 1000 },
      ],
    });
    expect(out.custom_audiences).toEqual(["6002714898572"]);
  });

  it("removes deprecated video_feeds placement", () => {
    const out = normalizeMetaApprovalArgs("create_meta_video_campaign", {
      facebook_positions: ["feed", "video_feeds", "story"],
    });
    expect(out.facebook_positions).toEqual(["feed", "story"]);
  });
});

describe("estimateMetaBudgetImpactCents", () => {
  it("reads daily_budget alias", () => {
    expect(
      estimateMetaBudgetImpactCents("create_meta_video_campaign", {
        daily_budget: 5,
      }),
    ).toBe(500);
  });
});
