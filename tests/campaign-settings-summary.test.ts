import { describe, expect, it } from "vitest";
import { describeCampaignSettings } from "@/lib/meta/campaign-settings-summary";

describe("describeCampaignSettings (approval rows)", () => {
  it("shows every setting the operator chose, in plain words", () => {
    const rows = describeCampaignSettings({
      conversion_location: "instant_form",
      optimization_goal: "LEAD_GENERATION",
      pixel_event_name: "LEAD",
      attribution: "7d_click_1d_view",
      publisher_platforms: ["facebook", "instagram"],
      instagram_positions: ["reels"],
      device_platforms: ["mobile"],
      user_os: ["iOS"],
      user_device: ["iPhone"],
      pixel_id: "p1",
    });
    const map = Object.fromEntries(rows);
    expect(map["Conversion location"]).toBe("Instant forms");
    expect(map["Performance goal"]).toBe("Maximise number of leads");
    expect(map["Conversion event"]).toBe("LEAD");
    expect(map["Attribution"]).toBe("7-day click, 1-day view");
    expect(map["Placements"]).toContain("Facebook");
    expect(map["Placements"]).toContain("Instagram (Reels)");
    expect(map["Devices"]).toBe("mobile");
    expect(map["Operating systems"]).toBe("iOS");
    expect(map["Device models"]).toBe("iPhone");
    expect(map["Pixel"]).toBe("p1");
  });

  it("returns nothing for an approval that used none of the new settings", () => {
    expect(describeCampaignSettings({ campaign_name: "x", budget_daily: 5 })).toEqual([]);
  });
});
