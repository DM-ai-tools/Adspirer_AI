import { describe, expect, it } from "vitest";
import { detectCreativeFormat } from "@/lib/agent/creative-format";
import { composeCampaignSettingsMessage, composeTargetingMessage } from "@/lib/chat/action-messages";
import { emptyTargetingSelection } from "@/lib/adspirer/targeting";

describe("detectCreativeFormat", () => {
  it("reads an explicit image or video ask", () => {
    expect(detectCreativeFormat("I want an image ad/campaign.")).toBe("image");
    expect(detectCreativeFormat("I want a video ad/campaign.")).toBe("video");
    expect(detectCreativeFormat("create a reel campaign for leads")).toBe("video");
  });

  it("does not flip to video because the settings card chose Reels placements", () => {
    const message = composeCampaignSettingsMessage(
      { publisher_platforms: ["instagram"], instagram_positions: ["reels"], optimization_goal: "REACH" },
      {},
    );
    expect(message).toMatch(/reels/i);
    expect(detectCreativeFormat(message)).toBeNull();
  });

  it("does not flip to video because a picked interest has 'video' in its name", () => {
    const selection = {
      ...emptyTargetingSelection(),
      interests: [{ id: "1", name: "Video games" }, { id: "2", name: "Video production" }],
    };
    const message = composeTargetingMessage(selection);
    expect(message).toMatch(/video/i);
    expect(detectCreativeFormat(message)).toBeNull();
  });

  it("still reads the operator's own words around a selection block", () => {
    const block = composeCampaignSettingsMessage({ instagram_positions: ["reels"] }, {});
    expect(detectCreativeFormat(`${block}\n\nThis is for a video campaign.`)).toBe("video");
  });
});
