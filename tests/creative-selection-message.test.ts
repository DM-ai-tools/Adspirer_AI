import { describe, expect, it } from "vitest";
import { selectionFollowUpMessage } from "@/lib/workflow/selection-message";

const draft = {
  headline: "Google Premier Partner Audit",
  primary_text: "TrafficRadius is a Google Premier Partner.\n\nFind your wasted spend.",
};

describe("selectionFollowUpMessage", () => {
  it("asks about the ad copy before anything is queued, showing the draft's copy", () => {
    const text = selectionFollowUpMessage(draft, 0);
    expect(text).toContain("Google Premier Partner Audit");
    expect(text).toContain("Find your wasted spend.");
    expect(text).toMatch(/ad copy/i);
    expect(text).toMatch(/use (this|it) (copy )?as is|as is/i);
    expect(text).toMatch(/budget/i);
    expect(text).toContain("Nothing is queued yet");
    expect(text).not.toMatch(/queued \*\*|and queued/i);
  });

  it("keeps the existing wording when the image was attached to pending approvals", () => {
    const text = selectionFollowUpMessage(draft, 2);
    expect(text).toContain("2 pending ad approvals");
    expect(text).toMatch(/nothing goes live/i);
  });

  it("handles a draft with no primary text", () => {
    expect(selectionFollowUpMessage({ headline: "H", primary_text: "" }, 0)).toContain("H");
  });
});
