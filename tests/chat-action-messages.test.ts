import { describe, expect, it } from "vitest";
import {
  composeCopyApprovedMessage,
  composeTargetingMessage,
  mergeComposerDraft,
  stripComposerMarkers,
} from "@/lib/chat/action-messages";
import { inferConversationFlow } from "@/lib/chat/infer-flow";

describe("action-messages", () => {
  it("composeCopyApprovedMessage stays user-facing", () => {
    const msg = composeCopyApprovedMessage({
      id: "A",
      angle: "benefit",
      headline: "H",
      primary_text: "P",
    });
    expect(msg).toContain("Approved ad copy variant A");
    expect(msg).not.toMatch(/do not|targeting_picker/i);
  });

  it("composeTargetingMessage has no creative next-step", () => {
    const msg = composeTargetingMessage({
      custom_audiences: [],
      excluded_custom_audiences: [],
      interests: [{ id: "1", name: "Marketing" }],
      behaviors: [],
      locations: [{ id: "AU", name: "Australia", key: "AU" }],
      publisher_platforms: [],
    });
    expect(msg).toContain("Advanced targeting selections");
    expect(msg).toContain("Interests: Marketing");
    expect(msg).not.toMatch(/creative|image url/i);
  });

  it("mergeComposerDraft replaces prior block", () => {
    const first = mergeComposerDraft("", "line one", "targeting");
    const second = mergeComposerDraft(first, "line two", "targeting");
    expect(second).toContain("line two");
    expect(second).not.toContain("line one");
  });

  it("stripComposerMarkers removes markers before send", () => {
    const draft = mergeComposerDraft("", "hello", "copy");
    expect(stripComposerMarkers(draft)).toBe("hello");
  });
});

describe("inferConversationFlow", () => {
  it("detects ad copy flow after variant approval", () => {
    const flow = inferConversationFlow([
      {
        id: "1",
        role: "user",
        content: "Approved ad copy variant A (benefit):\n- Headline: H",
        created_at: new Date().toISOString(),
        conversation_id: "c1",
        tool_call_id: null,
        metadata: null,
      },
    ]);
    expect(flow).toBe("ad_copy");
  });

  it("hides creative UI path unless create campaign", () => {
    const flow = inferConversationFlow([
      {
        id: "1",
        role: "user",
        content: "I want an image ad/campaign.",
        created_at: new Date().toISOString(),
        conversation_id: "c1",
        tool_call_id: null,
        metadata: null,
      },
    ]);
    expect(flow).toBe("create_campaign");
  });
});
