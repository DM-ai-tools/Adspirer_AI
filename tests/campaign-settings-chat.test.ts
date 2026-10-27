import { describe, expect, it } from "vitest";
import {
  extractCampaignSettingsPicker,
  humanizeAgentReply,
  stripMachineJson,
} from "@/lib/agent/reply-format";
import { composeCampaignSettingsMessage } from "@/lib/chat/action-messages";
import { inferConversationFlow } from "@/lib/chat/infer-flow";
import { detectRequestIntent, detectRequestIntentWithHistory } from "@/lib/agent/task-plan";
import type { Message } from "@/types";

const reply = [
  "Next, set the campaign settings.",
  "```json",
  '{"ui":"campaign_settings","account_id":"act_123","objective":"OUTCOME_LEADS"}',
  "```",
].join("\n");

describe("campaign_settings UI payload", () => {
  it("is extracted from the model reply", () => {
    expect(extractCampaignSettingsPicker(reply)).toEqual({
      account_id: "act_123",
      objective: "OUTCOME_LEADS",
      stated: undefined,
    });
  });

  it("keeps settings the operator already stated", () => {
    const picked = extractCampaignSettingsPicker(
      '```json\n{"ui":"campaign_settings","objective":"OUTCOME_SALES","stated":{"optimization_goal":"VALUE"}}\n```',
    );
    expect(picked?.stated).toEqual({ optimization_goal: "VALUE" });
    expect(picked?.account_id).toBeNull();
  });

  it("ignores payloads for other pickers", () => {
    expect(extractCampaignSettingsPicker('```json\n{"ui":"targeting_picker"}\n```')).toBeNull();
  });

  it("is hidden from the displayed text and surfaced as the picker", () => {
    expect(stripMachineJson(reply)).not.toContain("campaign_settings");
    const humanized = humanizeAgentReply(reply);
    expect(humanized.display).toContain("Next, set the campaign settings.");
    expect(humanized.display).not.toContain("{");
    expect(humanized.campaignSettingsPicker?.objective).toBe("OUTCOME_LEADS");
  });
});

describe("composeCampaignSettingsMessage", () => {
  const message = composeCampaignSettingsMessage(
    {
      budget_level: "campaign",
      conversion_location: "website",
      optimization_goal: "OFFSITE_CONVERSIONS",
      pixel_event_name: "LEAD",
      attribution: "7d_click_1d_view",
      age_min: 25,
      age_max: 54,
      publisher_platforms: ["facebook", "instagram"],
      device_platforms: ["mobile"],
      user_os: ["iOS"],
    },
    {
      budget_level: "Campaign budget",
      optimization_goal: "Maximise number of conversions",
      attribution: "7-day click, 1-day view",
    },
  );

  it("starts with the marker and names the choices", () => {
    expect(message.startsWith("Campaign settings selections:")).toBe(true);
    expect(message).toContain("Campaign budget");
    expect(message).toContain("Maximise number of conversions");
    expect(message).toContain("7-day click, 1-day view");
  });

  it("carries the create args, mapping budget level to campaign_budget_optimization", () => {
    const json = message.match(/```json\n([\s\S]*?)\n```/)?.[1];
    const args = JSON.parse(json!);
    expect(args).toMatchObject({
      campaign_budget_optimization: true,
      conversion_location: "website",
      optimization_goal: "OFFSITE_CONVERSIONS",
      pixel_event_name: "LEAD",
      attribution: "7d_click_1d_view",
      age_min: 25,
      age_max: 54,
      publisher_platforms: ["facebook", "instagram"],
      device_platforms: ["mobile"],
      user_os: ["iOS"],
    });
    expect(args).not.toHaveProperty("budget_level");
  });

  it("maps an ad set budget to campaign_budget_optimization false", () => {
    const m = composeCampaignSettingsMessage({ budget_level: "ad_set" }, {});
    expect(JSON.parse(m.match(/```json\n([\s\S]*?)\n```/)![1])).toEqual({
      campaign_budget_optimization: false,
    });
  });
});

describe("routing of the settings message", () => {
  const settingsMessage = composeCampaignSettingsMessage(
    { budget_level: "campaign", optimization_goal: "OFFSITE_CONVERSIONS" },
    { budget_level: "Campaign budget" },
  );

  it("counts as the campaign-creation flow", () => {
    const messages = [
      { id: "1", role: "user", content: settingsMessage },
    ] as Message[];
    expect(inferConversationFlow(messages)).toBe("create_campaign");
  });

  it("is a campaign step, not a budget or optimize request", () => {
    expect(detectRequestIntent(settingsMessage)).toBe("create_campaign");
    expect(
      detectRequestIntentWithHistory(settingsMessage, [
        { role: "user", content: "Create an image campaign for leads" },
        { role: "assistant", content: "Budget and Approvals are next." },
      ]),
    ).toBe("create_campaign");
  });
});

describe("skipping the settings card", () => {
  it("is a campaign step that keeps today's defaults", async () => {
    const { composeSkipCampaignSettingsMessage } = await import("@/lib/chat/action-messages");
    const text = composeSkipCampaignSettingsMessage();
    expect(text.startsWith("Campaign settings selections:")).toBe(true);
    expect(detectRequestIntent(text)).toBe("create_campaign");
    expect(inferConversationFlow([{ id: "1", role: "user", content: text }] as Message[])).toBe("create_campaign");
  });
});

describe("lead form and pixel in the composed message", () => {
  it("I3: carries lead_form_id and pixel_id to the create tool", () => {
    const message = composeCampaignSettingsMessage(
      { conversion_location: "instant_form", optimization_goal: "LEAD_GENERATION", lead_form_id: "f1" },
      {},
    );
    expect(JSON.parse(message.match(/```json\n([\s\S]*?)\n```/)![1])).toMatchObject({ lead_form_id: "f1" });
    const withPixel = composeCampaignSettingsMessage(
      { conversion_location: "website", optimization_goal: "OFFSITE_CONVERSIONS", pixel_event_name: "LEAD", pixel_id: "p1" },
      {},
    );
    expect(JSON.parse(withPixel.match(/```json\n([\s\S]*?)\n```/)![1])).toMatchObject({ pixel_id: "p1" });
  });
});
