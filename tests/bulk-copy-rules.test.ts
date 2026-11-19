import { beforeEach, describe, expect, it, vi } from "vitest";

let model: object | null = {};
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => model }));

import { COPY_FIELD_LIMITS, extractCopyRules, limitProblems, wordCount, type CopyRules } from "@/lib/creatives/bulk/copy/rules";

beforeEach(() => {
  model = {};
});

describe("counting words", () => {
  it("counts words split by any whitespace", () => {
    expect(wordCount("a b  c\n d")).toBe(4);
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
  });
});

describe("the editor limits", () => {
  it("match what Meta publishing allows", () => {
    expect(COPY_FIELD_LIMITS).toEqual({ headline: 255, primary_text: 2200, description: 255 });
  });
});

describe("numeric limits on an ad's copy", () => {
  const ad = (over: Partial<{ headline: string; primary_text: string; description: string | null }> = {}) => ({ headline: "Free audit today", primary_text: "one two three four five", description: null as string | null, ...over });

  it("reports a primary text over a word limit, with the count and the limit", () => {
    const rules: CopyRules = { primary_text: { unit: "words", max: 4 }, checklist: [] };
    expect(limitProblems(ad(), rules)).toEqual(["Primary text is 5 words; your limit is 4."]);
  });

  it("checks characters for the headline and passes a headline exactly at the limit", () => {
    const rules: CopyRules = { headline: { unit: "characters", max: 16 }, checklist: [] };
    expect(limitProblems(ad({ headline: "Free audit today" }), rules)).toEqual([]);
    expect(limitProblems(ad({ headline: "Free audit today!" }), rules)).toEqual(["Headline is 17 characters; your limit is 16."]);
  });

  it("checks the description only when the ad has one", () => {
    const rules: CopyRules = { description: { unit: "words", max: 2 }, checklist: [] };
    expect(limitProblems(ad({ description: null }), rules)).toEqual([]);
    expect(limitProblems(ad({ description: "a b c" }), rules)).toEqual(["Description is 3 words; your limit is 2."]);
  });

  it("reports every field that is over, and nothing when no limits were given", () => {
    const rules: CopyRules = { headline: { unit: "words", max: 1 }, primary_text: { unit: "words", max: 1 }, checklist: [] };
    expect(limitProblems(ad(), rules)).toHaveLength(2);
    expect(limitProblems(ad(), { checklist: ["mention a free audit"] })).toEqual([]);
  });
});

describe("reading the operator's instructions into rules", () => {
  const raw = { headline: { unit: "characters", max: 40 }, primary_text: { unit: "words", max: 30 }, description: null, checklist: ["Mention the free audit", "End with a question"] };

  it("returns the limits and checklist the model found", async () => {
    const rules = await extractCopyRules("Headline under 40 characters, primary text under 30 words, mention the free audit, end with a question", { generate: (async () => ({ object: raw })) as never });
    expect(rules).toEqual({ headline: { unit: "characters", max: 40 }, primary_text: { unit: "words", max: 30 }, checklist: ["Mention the free audit", "End with a question"] });
  });

  it("returns no rules when the model errors or none is configured, and never throws", async () => {
    expect(await extractCopyRules("anything", { generate: (async () => { throw new Error("rate limited"); }) as never })).toEqual({ checklist: [] });
    model = null;
    const generate = vi.fn();
    expect(await extractCopyRules("anything", { generate: generate as never })).toEqual({ checklist: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("ignores nonsense limits (zero, negative)", async () => {
    const rules = await extractCopyRules("x", { generate: (async () => ({ object: { headline: { unit: "words", max: 0 }, primary_text: { unit: "words", max: -3 }, description: null, checklist: [] } })) as never });
    expect(rules).toEqual({ checklist: [] });
  });
});
