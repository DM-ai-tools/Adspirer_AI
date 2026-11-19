import { beforeEach, describe, expect, it, vi } from "vitest";

let model: object | null = {};
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => model }));

import { detectDirection, DETECT_SYSTEM_PROMPT, MAX_CHAT_DIRECTIONS, normaliseDetection } from "@/lib/creatives/directed/detect";

beforeEach(() => {
  model = {};
});

const raw = (over: Record<string, unknown> = {}) => ({
  mode: "directed",
  directions: [{ picture: "A red door", print: [{ role: "headline", text: "Open it" }], no_logo: false }],
  format: null,
  edit_instruction: null,
  question: null,
  ...over,
});

describe("normalising what the model returned", () => {
  it("keeps a directed request with its picture and printed lines", () => {
    const d = normaliseDetection(raw(), false);
    expect(d.mode).toBe("directed");
    expect(d.directions).toEqual([{ picture: "A red door", print: [{ role: "headline", text: "Open it" }] }]);
    expect(d.overflow).toBe(false);
  });

  it("carries no_logo and a stated format", () => {
    const d = normaliseDetection(raw({ directions: [{ picture: "A", print: [], no_logo: true }], format: "9:16" }), false);
    expect(d.directions[0]).toEqual({ picture: "A", print: [], noLogo: true });
    expect(d.format).toBe("9:16");
  });

  it("drops directions with a blank picture, and a directed request left with none is unsure", () => {
    const d = normaliseDetection(raw({ directions: [{ picture: "  ", print: [{ role: null, text: "x" }], no_logo: false }], question: "What should the picture show?" }), false);
    expect(d.mode).toBe("unsure");
    expect(d.directions).toEqual([]);
    expect(d.question).toBe("What should the picture show?");
  });

  it("drops blank printed lines but never changes the words", () => {
    const d = normaliseDetection(raw({ directions: [{ picture: "A", print: [{ role: null, text: "  " }, { role: null, text: "Keep   THIS, exactly!" }], no_logo: false }] }), false);
    expect(d.directions[0]!.print).toEqual([{ role: null, text: "Keep   THIS, exactly!" }]);
  });

  it(`flags more than ${MAX_CHAT_DIRECTIONS} directions as overflow and keeps none`, () => {
    const many = Array.from({ length: MAX_CHAT_DIRECTIONS + 1 }, (_, i) => ({ picture: `P${i}`, print: [], no_logo: false }));
    const d = normaliseDetection(raw({ directions: many }), false);
    expect(d.overflow).toBe(true);
    expect(d.directions).toEqual([]);
    expect(normaliseDetection(raw({ directions: many.slice(0, MAX_CHAT_DIRECTIONS) }), false).directions).toHaveLength(MAX_CHAT_DIRECTIONS);
  });

  it("treats variations and edit as open when the chat has no directed image", () => {
    expect(normaliseDetection(raw({ mode: "variations", directions: [] }), false).mode).toBe("open");
    expect(normaliseDetection(raw({ mode: "edit", directions: [], edit_instruction: "darker" }), false).mode).toBe("open");
    expect(normaliseDetection(raw({ mode: "variations", directions: [] }), true).mode).toBe("variations");
  });

  it("makes an edit without an instruction unsure", () => {
    expect(normaliseDetection(raw({ mode: "edit", directions: [], edit_instruction: "  " }), true).mode).toBe("unsure");
    const ok = normaliseDetection(raw({ mode: "edit", directions: [], edit_instruction: "make the background darker" }), true);
    expect(ok).toMatchObject({ mode: "edit", editInstruction: "make the background darker" });
  });

  it("falls back to open for anything unreadable", () => {
    expect(normaliseDetection(null, true).mode).toBe("open");
    expect(normaliseDetection({ mode: "banana" }, true).mode).toBe("open");
  });
});

describe("detecting a direction", () => {
  const input = { message: "Make an image: a red door. Headline: Open it", recent: [], hasDirectedImage: false };

  it("asks the model and returns its reading", async () => {
    const generate = vi.fn(async () => ({ object: raw() })) as never;
    const d = await detectDirection(input, { generate });
    expect(d.mode).toBe("directed");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("returns open when the model errors, so the existing flow runs", async () => {
    const generate = (async () => {
      throw new Error("rate limited");
    }) as never;
    expect((await detectDirection(input, { generate })).mode).toBe("open");
  });

  it("returns open without calling anything when no model is configured", async () => {
    model = null;
    const generate = vi.fn() as never;
    expect((await detectDirection(input, { generate })).mode).toBe("open");
    expect(generate).not.toHaveBeenCalled();
  });

  it("states the decided rules to the model", () => {
    expect(DETECT_SYSTEM_PROMPT).toMatch(/headline.*alone.*open/is);
    expect(DETECT_SYSTEM_PROMPT).toMatch(/verbatim/i);
    expect(DETECT_SYSTEM_PROMPT).toContain(String(MAX_CHAT_DIRECTIONS));
  });
});
