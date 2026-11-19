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

  it("tells the repair that a length limit is always met by shortening, so it is never reported as something it could not follow", async () => {
    const { generate, calls } = fake({ judge: () => ({ results: [] }), repair: () => ({ ads: [{ id: "a", headline: "H", primary_text: "Short.", description: null, could_not: [] }] }) });
    await checkAndRepairCopy({ instructions: "x", ads: [ad("a", { primary_text: long })], facts: "" }, { generate, rules });
    expect(calls.find((c) => c.kind === "repair")!.prompt).toMatch(/length limit[^\n]*shorten[^\n]*never[^\n]*could_not|never report a length limit in could_not/i);
  });

  it("drops a could-not-follow report about a length limit when the code finds the limit now met", async () => {
    const { generate } = fake({
      judge: () => ({ results: [] }),
      repair: () => ({ ads: [{ id: "a", headline: "Fits now", primary_text: "Short.", description: null, could_not: [{ rule: "Primary text under 10 words", reason: "it needs the context" }] }] }),
    });
    const out = await checkAndRepairCopy({ instructions: "x", ads: [ad("a", { primary_text: long })], facts: "" }, { generate, rules });
    expect(out.notes).toEqual({});
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

  it("gives an ad that is still over a length limit one more pass that only shortens it", async () => {
    const wordRule: CopyRules = { primary_text: { unit: "words", max: 10 }, checklist: [] };
    const { generate, calls } = fake({
      repair: (prompt) =>
        prompt.includes("SHORTEN THESE ADS")
          ? { ads: [{ id: "a", headline: "H", primary_text: "Now it fits in ten words.", description: null, could_not: [] }] }
          : { ads: [{ id: "a", headline: "H", primary_text: long, description: null, could_not: [{ rule: "primary text under 10 words", reason: "it loses meaning" }] }] },
    });
    const out = await checkAndRepairCopy({ instructions: "x", ads: [ad("a", { primary_text: long })], facts: "" }, { generate, rules: wordRule });
    expect(calls.map((c) => c.kind)).toEqual(["repair", "repair"]);
    expect(calls[1]!.prompt).toContain("Primary text is 30 words; your limit is 10.");
    expect(out.ads[0]!.primary_text).toBe("Now it fits in ten words.");
    expect(out.notes).toEqual({});
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

  it("drops a 'could not follow' note the repair model made about a rule the copy now meets, after a second check confirms it", async () => {
    let judged = 0;
    const { generate, calls } = fake({
      judge: () => {
        judged += 1;
        return judged === 1 ? { results: [{ id: "a", failed: ["End with a question"] }] } : { results: [{ id: "a", failed: [] }] };
      },
      repair: () => ({ ads: [{ id: "a", headline: "Headline a", primary_text: "Ready for your free audit?", description: null, could_not: [{ rule: "end with a question", reason: "it feels forced" }] }] }),
    });
    const out = await checkAndRepairCopy({ instructions: "x", ads: [ad("a")], facts: "" }, { generate, rules: { checklist: ["End with a question"] } });
    expect(calls.map((c) => c.kind)).toEqual(["judge", "repair", "judge"]);
    expect(out.notes).toEqual({});
    expect(out.ads[0]!.primary_text).toBe("Ready for your free audit?");
  });

  it("keeps the note when the second check agrees the ad still misses the rule, and when that check cannot run", async () => {
    const still = fake({
      judge: () => ({ results: [{ id: "a", failed: ["Include a price"] }] }),
      repair: () => ({ ads: [{ id: "a", headline: "Headline a", primary_text: "Short body that is fine.", description: null, could_not: [{ rule: "include a price", reason: "no price in the facts" }] }] }),
    });
    const a = await checkAndRepairCopy({ instructions: "x", ads: [ad("a")], facts: "" }, { generate: still.generate, rules: { checklist: ["Include a price"] } });
    expect(a.notes.a).toMatch(/Could not follow: include a price/);

    let judged = 0;
    const flaky = fake({
      judge: () => {
        judged += 1;
        return judged === 1 ? { results: [{ id: "a", failed: ["Include a price"] }] } : new Error("rate limited");
      },
      repair: () => ({ ads: [{ id: "a", headline: "Headline a", primary_text: "Short body that is fine.", description: null, could_not: [{ rule: "include a price", reason: "no price in the facts" }] }] }),
    });
    const b = await checkAndRepairCopy({ instructions: "x", ads: [ad("a")], facts: "" }, { generate: flaky.generate, rules: { checklist: ["Include a price"] } });
    expect(b.notes.a).toMatch(/Could not follow: include a price/);
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
