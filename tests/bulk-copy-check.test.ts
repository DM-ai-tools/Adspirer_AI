import { beforeEach, describe, expect, it, vi } from "vitest";

let model: object | null = {};
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => model }));

import { checkAndRepairCopy, COPY_PRECEDENCE, type CopyAd } from "@/lib/creatives/bulk/copy/check";
import type { CopyRules } from "@/lib/creatives/bulk/copy/rules";

beforeEach(() => {
  model = {};
});

const ad = (id: string, over: Partial<CopyAd> = {}): CopyAd => ({ id, headline: `Headline ${id}`, primary_text: "Short body that is fine.", description: null, ...over });
const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");

type Call = { kind: "judge" | "repair"; prompt: string };
/** A generator that answers the judge and repair calls from the supplied functions, and records every call. */
function fake(answers: { judge?: (prompt: string) => unknown; repair?: (prompt: string) => unknown }) {
  const calls: Call[] = [];
  const generate = (async ({ prompt }: { prompt: string }) => {
    const kind = prompt.includes("JUDGE THESE ADS") ? "judge" : "repair";
    calls.push({ kind, prompt });
    const out = kind === "judge" ? answers.judge?.(prompt) : answers.repair?.(prompt);
    if (out instanceof Error) throw out;
    return { object: out };
  }) as never;
  return { generate, calls };
}

const wordRules: CopyRules = { primary_text: { unit: "words", max: 10 }, checklist: [] };

describe("when every ad already follows the instructions", () => {
  it("makes no repair call and changes nothing", async () => {
    const { generate, calls } = fake({});
    const ads = [ad("a"), ad("b")];
    const out = await checkAndRepairCopy({ instructions: "primary text under 10 words", ads, facts: "" }, { generate, rules: wordRules });
    expect(calls).toEqual([]);
    expect(out.ads).toEqual(ads);
    expect(out.notes).toEqual({});
    expect(out.repaired).toEqual([]);
  });

  it("does nothing at all for empty instructions or no ads", async () => {
    const { generate, calls } = fake({});
    expect((await checkAndRepairCopy({ instructions: "  ", ads: [ad("a")], facts: "" }, { generate, rules: wordRules })).ads).toHaveLength(1);
    expect((await checkAndRepairCopy({ instructions: "x", ads: [], facts: "" }, { generate, rules: wordRules })).ads).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("repairing the ads that miss", () => {
  const rules: CopyRules = { primary_text: { unit: "words", max: 10 }, checklist: ["Mention the free audit"] };

  it("rewrites only the failing ads, in one call, and leaves the passing ones untouched", async () => {
    const { generate, calls } = fake({
      judge: () => ({ results: [{ id: "b", failed: ["Mention the free audit"] }] }),
      repair: () => ({
        ads: [
          { id: "a", headline: "Fixed A", primary_text: "Ten words or fewer, with the free audit.", description: null, could_not: [] },
          { id: "b", headline: "Fixed B", primary_text: "Get your free audit today.", description: null, could_not: [] },
        ],
      }),
    });
    const ads = [ad("a", { primary_text: long }), ad("b"), ad("c")];
    const out = await checkAndRepairCopy({ instructions: "x", ads, facts: "facts" }, { generate, rules });
    expect(calls.map((c) => c.kind)).toEqual(["judge", "repair"]);
    expect(out.ads[0]).toMatchObject({ id: "a", headline: "Fixed A", primary_text: "Ten words or fewer, with the free audit." });
    expect(out.ads[1]).toMatchObject({ id: "b", headline: "Fixed B" });
    expect(out.ads[2]).toEqual(ads[2]);
    expect(out.repaired.sort()).toEqual(["a", "b"]);
    expect(out.notes).toEqual({});
    // only the two failing ads are sent to be repaired
    expect(calls[1]!.prompt).toContain("Headline b");
    expect(calls[1]!.prompt).not.toContain("Headline c");
  });

  it("tells the repair what each ad failed, the facts, and the precedence order", async () => {
    const { generate, calls } = fake({ judge: () => ({ results: [] }), repair: () => ({ ads: [{ id: "a", headline: "H", primary_text: "Short.", description: null, could_not: [] }] }) });
    await checkAndRepairCopy({ instructions: "primary text under 10 words", ads: [ad("a", { primary_text: long })], facts: "The audit is free for 30 minutes." }, { generate, rules });
    const prompt = calls.find((c) => c.kind === "repair")!.prompt;
    expect(prompt).toContain("Primary text is 30 words; your limit is 10.");
    expect(prompt).toContain("The audit is free for 30 minutes.");
    expect(prompt).toContain(COPY_PRECEDENCE);
  });

  it("flags an ad that still breaks a length limit after the repair", async () => {
    const { generate } = fake({ judge: () => ({ results: [] }), repair: () => ({ ads: [{ id: "a", headline: "H", primary_text: long, description: null, could_not: [] }] }) });
    const out = await checkAndRepairCopy({ instructions: "x", ads: [ad("a", { primary_text: long })], facts: "" }, { generate, rules });
    expect(out.notes.a).toBe("Did not fully follow your instructions: Primary text is 30 words; your limit is 10.");
  });

  it("never invents a fact to satisfy a rule: the ad keeps its copy and says it could not follow", async () => {
    const { generate } = fake({
      judge: () => ({ results: [{ id: "a", failed: ["Include a price"] }] }),
      repair: () => ({ ads: [{ id: "a", headline: "Headline a", primary_text: "Short body that is fine.", description: null, could_not: [{ rule: "include a price", reason: "no price appears in the facts" }] }] }),
    });
    const out = await checkAndRepairCopy({ instructions: "include a price", ads: [ad("a")], facts: "No prices." }, { generate, rules: { checklist: ["Include a price"] } });
    expect(out.ads[0]).toMatchObject({ headline: "Headline a", primary_text: "Short body that is fine." });
    expect(out.notes.a).toBe("Could not follow: include a price, because no price appears in the facts.");
  });

  it("keeps the printed words of a directions image in front of the repair, as words that must not change", async () => {
    const { generate, calls } = fake({ judge: () => ({ results: [] }), repair: () => ({ ads: [{ id: "a", headline: "H", primary_text: "Short.", description: null, could_not: [] }] }) });
    await checkAndRepairCopy({ instructions: "x", ads: [ad("a", { primary_text: long, fixedWords: ["Open the right door", "Book now"] })], facts: "" }, { generate, rules });
    const prompt = calls.find((c) => c.kind === "repair")!.prompt;
    expect(prompt).toContain('"Open the right door"');
    expect(prompt).toContain('"Book now"');
    expect(prompt).toMatch(/never change[^\n]*printed/i);
  });

  it("keeps an ad's description null when it has none, whatever the repair returns", async () => {
    const { generate } = fake({ judge: () => ({ results: [] }), repair: () => ({ ads: [{ id: "a", headline: "H", primary_text: "Short.", description: "Made up", could_not: [] }] }) });
    const out = await checkAndRepairCopy({ instructions: "x", ads: [ad("a", { primary_text: long })], facts: "" }, { generate, rules });
    expect(out.ads[0]!.description).toBeNull();
  });
});

describe("when a model call fails", () => {
  const rules: CopyRules = { primary_text: { unit: "words", max: 10 }, checklist: ["Mention the free audit"] };

  it("never throws: a failed judge is skipped, so only the length limits are enforced", async () => {
    const { generate, calls } = fake({ judge: () => new Error("rate limited"), repair: () => ({ ads: [{ id: "a", headline: "H", primary_text: "Short.", description: null, could_not: [] }] }) });
    const out = await checkAndRepairCopy({ instructions: "x", ads: [ad("a", { primary_text: long }), ad("b")], facts: "" }, { generate, rules });
    expect(calls.map((c) => c.kind)).toEqual(["judge", "repair"]);
    expect(out.ads[0]!.primary_text).toBe("Short.");
    expect(out.ads[1]).toEqual(ad("b"));
  });

  it("keeps the copy unchanged when the repair fails, and still says which length limits it breaks", async () => {
    const { generate } = fake({ judge: () => ({ results: [] }), repair: () => new Error("overloaded") });
    const ads = [ad("a", { primary_text: long }), ad("b")];
    const out = await checkAndRepairCopy({ instructions: "x", ads, facts: "" }, { generate, rules });
    expect(out.ads).toEqual(ads);
    expect(out.repaired).toEqual([]);
    expect(out.notes).toEqual({ a: "Did not fully follow your instructions: Primary text is 30 words; your limit is 10." });
  });
});
