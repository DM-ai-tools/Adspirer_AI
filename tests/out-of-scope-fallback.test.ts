import { describe, expect, it } from "vitest";
import { detectRequestIntent } from "@/lib/agent/task-plan";

describe("keyword fallback out_of_scope", () => {
  it.each([
    "which products are low on stock",
    "is the discount code working",
    "did the pixel code fire yesterday",
  ])("keeps %s in scope", (request) => {
    expect(detectRequestIntent(request)).not.toBe("out_of_scope");
  });

  it.each([
    "what's the weather in london",
    "write some python code to sort a list",
    "any stock market tips",
  ])("routes %s out of scope", (request) => {
    expect(detectRequestIntent(request)).toBe("out_of_scope");
  });
});
