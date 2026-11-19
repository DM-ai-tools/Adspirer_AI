import { describe, expect, it } from "vitest";
import { copyHeaderLine, counterState } from "@/lib/creatives/bulk/copy/limits-ui";

describe("the character counter in the ad copy editor", () => {
  it("shows the count against the limit and is not over at exactly the limit", () => {
    expect(counterState("hello", 255)).toEqual({ count: 5, over: false, label: "5 / 255" });
    expect(counterState("x".repeat(255), 255)).toMatchObject({ over: false, label: "255 / 255" });
  });
  it("is over once the text passes the limit, and counts an empty field as zero", () => {
    expect(counterState("x".repeat(256), 255)).toMatchObject({ over: true, label: "256 / 255" });
    expect(counterState("", 255)).toEqual({ count: 0, over: false, label: "0 / 255" });
  });
});

describe("the ad copy line in the run header", () => {
  it("says nothing when no ad copy instructions were given", () => {
    expect(copyHeaderLine(null)).toBeNull();
  });
  it("says the copy is being written", () => {
    expect(copyHeaderLine({ status: "writing", message: null, repaired: 0, flagged: 0 })).toBe("Writing the ad copy to your instructions…");
  });
  it("says when it was written to the instructions, with how many ads needed a rewrite and how many carry a note", () => {
    expect(copyHeaderLine({ status: "ready", message: null, repaired: 0, flagged: 0 })).toBe("Ad copy written to your instructions.");
    expect(copyHeaderLine({ status: "ready", message: null, repaired: 3, flagged: 0 })).toBe("Ad copy written to your instructions; 3 ads needed a rewrite to follow them.");
    expect(copyHeaderLine({ status: "ready", message: null, repaired: 1, flagged: 2 })).toBe("Ad copy written to your instructions; 1 ad needed a rewrite to follow them; 2 still have a note.");
    expect(copyHeaderLine({ status: "ready", message: null, repaired: 0, flagged: 1 })).toBe("Ad copy written to your instructions; 1 still has a note.");
  });
  it("gives the reason when the copy could not be written", () => {
    expect(copyHeaderLine({ status: "failed", message: "The ad copy could not be written (model overloaded), so each ad keeps the words printed on its image.", repaired: 0, flagged: 0 })).toBe("The ad copy could not be written (model overloaded), so each ad keeps the words printed on its image.");
    expect(copyHeaderLine({ status: "failed", message: null, repaired: 0, flagged: 0 })).toMatch(/could not be written/i);
  });
});
