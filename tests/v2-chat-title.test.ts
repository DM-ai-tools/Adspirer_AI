import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_TITLE,
  DEFAULT_V2_CHAT_TITLE,
  displayChatTitle,
  isDefaultConversationTitle,
  isV2ChatTitle,
  withV2ChatTitle,
} from "@/lib/agent/title-format";

describe("v2 chat title formatting", () => {
  it("treats New chat (V2) as a default title so auto-naming still runs", () => {
    expect(isDefaultConversationTitle(DEFAULT_V2_CHAT_TITLE)).toBe(true);
    expect(isDefaultConversationTitle(DEFAULT_CHAT_TITLE)).toBe(true);
    expect(isDefaultConversationTitle("Scale lookalikes")).toBe(false);
  });

  it("marks v2 titles for history identification", () => {
    expect(isV2ChatTitle(DEFAULT_V2_CHAT_TITLE)).toBe(true);
    expect(isV2ChatTitle("V2 · Scale lookalikes")).toBe(true);
    expect(isV2ChatTitle("New chat")).toBe(false);
  });

  it("prefixes generated titles without duplicating the marker", () => {
    expect(withV2ChatTitle("Scale lookalikes")).toBe("V2 · Scale lookalikes");
    expect(withV2ChatTitle("V2 · Scale lookalikes")).toBe("V2 · Scale lookalikes");
    expect(withV2ChatTitle(DEFAULT_CHAT_TITLE)).toBe(DEFAULT_V2_CHAT_TITLE);
  });

  it("strips the v2 marker for badge-adjacent history labels", () => {
    expect(displayChatTitle(DEFAULT_V2_CHAT_TITLE)).toBe("New chat");
    expect(displayChatTitle("V2 · Scale lookalikes")).toBe("Scale lookalikes");
    expect(displayChatTitle("Weekly audit")).toBe("Weekly audit");
  });
});
