import { describe, expect, it } from "vitest";
import {
  composeCopyApprovedMessage,
  composeTargetingMessage,
  mergeComposerDraft,
  stripComposerMarkers,
} from "@/lib/chat/action-messages";
import { inferConversationFlow } from "@/lib/chat/infer-flow";

describe("action-messages", () => {
  it("composeCopyApprovedMessage stays user-facing and copy-only", () => {
    const msg = composeCopyApprovedMessage({
      id: "A",
      angle: "benefit",
      headline: "H",
      primary_text: "P",
    });
    expect(msg).toContain("Approved ad copy variant A");
    expect(msg).toMatch(/copy only/i);
    expect(msg).not.toMatch(/targeting_picker|create_meta_/i);
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

  it("keeps copy-only after approval when the ask was only for copies", () => {
    const flow = inferConversationFlow([
      {
        id: "1",
        role: "user",
        content:
          "Create ad copies based on the uploaded competitors ad copy",
        created_at: new Date().toISOString(),
        conversation_id: "c1",
        tool_call_id: null,
        metadata: null,
      },
      {
        id: "2",
        role: "assistant",
        content: "Here are variants",
        created_at: new Date().toISOString(),
        conversation_id: "c1",
        tool_call_id: null,
        metadata: null,
      },
      {
        id: "3",
        role: "user",
        content:
          "Approved ad copy variant copy_1 (benefit):\n- Headline: H\n\nI'm approving this copy only for now — not creating a campaign yet.",
        created_at: new Date().toISOString(),
        conversation_id: "c1",
        tool_call_id: null,
        metadata: null,
      },
    ]);
    expect(flow).toBe("ad_copy");
  });

  it("keeps campaign flow after copy approval when create campaign was asked", () => {
    const flow = inferConversationFlow([
      {
        id: "1",
        role: "user",
        content: "Create a Meta campaign for this account",
        created_at: new Date().toISOString(),
        conversation_id: "c1",
        tool_call_id: null,
        metadata: null,
      },
      {
        id: "2",
        role: "user",
        content: "Approved ad copy variant A (benefit):\n- Headline: H",
        created_at: new Date().toISOString(),
        conversation_id: "c1",
        tool_call_id: null,
        metadata: null,
      },
    ]);
    expect(flow).toBe("create_campaign");
  });

  it("detects standalone image generation without campaign create", () => {
    const flow = inferConversationFlow([
      {
        id: "1",
        role: "user",
        content:
          "Create an image based on this reference using https://example.com brand colours",
        created_at: new Date().toISOString(),
        conversation_id: "c1",
        tool_call_id: null,
        metadata: null,
      },
    ]);
    expect(flow).toBe("creative_images");
  });

  it("detects explicit campaign format choice", () => {
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
