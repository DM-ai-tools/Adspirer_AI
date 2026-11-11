import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { BULK_ANGLES } from "@/lib/creatives/bulk/angles";
import { HOOK_BATCH_SIZE, HOOK_ROUNDS } from "@/lib/creatives/bulk/plan";

vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));

/** What each hook call is asked for and what the fake writer decides to return. */
const calls: string[][] = [];
const prompts: string[] = [];
const defaultHeadline = (k: string) => {
  const n = BULK_ANGLES.findIndex((a) => a.key === k);
  return `qa${n}x qa${n}y qa${n}z`;
};
const mode: {
  behave: (asked: string[], callNumber: number) => string[] | Error;
  headline: (key: string, callNumber: number) => string;
} = { behave: (asked) => asked, headline: defaultHeadline };

vi.mock("ai", () => ({
  generateObject: async ({ prompt }: { prompt: string }) => {
    if (prompt.includes("Build the message map")) return { object: { pains: ["p"], desires: ["d"], objections: ["o"], proof: ["x"], mechanism: "m", audience: "a" } };
    if (prompt.includes("Write exactly 4 distinct bodies")) {
      return { object: { bodies: ["A", "B", "C", "D"].map((id) => ({ id, format: "proof", text: `body ${id}` })), ctas: [{ label: "Get a quote", cta: "GET_QUOTE" }] } };
    }
    if (prompt.includes("Write one visual idea")) {
      const ideaKeys = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`key "${k}"`));
      return { object: { ideas: ideaKeys.map((k) => ({ angle_key: k, idea: `idea for ${k}` })) } };
    }
    const asked = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`key "${k}"`));
    calls.push(asked);
    prompts.push(prompt);
    const answer = mode.behave(asked, calls.length);
    if (answer instanceof Error) throw answer;
    return {
      object: {
        hooks: answer.map((k) => ({
          angle_key: k,
          targets: `target ${k}`,
          post_headline: `Headline ${k}`,
          body_id: "A",
          primary_text: `copy ${k}`,
          cta_index: 0,
          on_image_text: { headline: mode.headline(k, calls.length), highlights: [`label ${k}`], cta_label: "Go" },
          style: "s",
          creative_direction: `idea ${k}`,
        })),
      },
    };
  },
}));

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  calls.length = 0;
  prompts.length = 0;
  mode.behave = (asked) => asked;
  mode.headline = defaultHeadline;
});

const brief = { brandName: "Acme", offerName: "Audit", notes: null };

describe("writing the hooks, one call each", () => {
  it("asks for one hook per call, all side by side, and gets all fifteen", async () => {
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    const plan = await writeBulkPlan(brief, 15);
    expect(plan.hooks).toHaveLength(15);
    expect(new Set(plan.hooks.map((h) => h.angle.key)).size).toBe(15);
    expect(calls).toHaveLength(15 / HOOK_BATCH_SIZE);
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(HOOK_BATCH_SIZE);
  });

  it("plans a different visual idea per hook first and hands each hook its own", async () => {
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    await writeBulkPlan(brief, 15);
    for (const [i, asked] of calls.entries()) {
      expect(prompts[i]).toContain(`VISUAL IDEA for this hook`);
      expect(prompts[i]).toContain(`idea for ${asked[0]}`);
    }
  });

  it("asks again for a hook the writer left out", async () => {
    const seen = new Set<string>();
    mode.behave = (asked) => {
      const first = asked.some((k) => !seen.has(k));
      asked.forEach((k) => seen.add(k));
      return first ? [] : asked;
    };
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    const plan = await writeBulkPlan(brief, 15);
    expect(plan.hooks).toHaveLength(15);
    expect(new Set(plan.hooks.map((h) => h.angle.key)).size).toBe(15);
  });

  it("keeps trying a stubborn hook for several rounds, then gives up on that one only", async () => {
    let stubborn: string | null = null;
    mode.behave = (asked) => {
      stubborn ??= asked[0]!;
      return asked.filter((k) => k !== stubborn);
    };
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    const plan = await writeBulkPlan(brief, 15);
    expect(plan.hooks).toHaveLength(14);
    expect(plan.hooks.some((h) => h.angle.key === stubborn)).toBe(false);
    expect(calls.filter((c) => c.includes(stubborn!))).toHaveLength(HOOK_ROUNDS);
  });

  it("survives a failed call and still returns every hook", async () => {
    mode.behave = (asked, n) => (n === 2 ? new Error("429 rate limited") : asked);
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    expect((await writeBulkPlan(brief, 15)).hooks).toHaveLength(15);
  });

  it("fails with the real reason when every call fails", async () => {
    mode.behave = () => new Error("credit balance is too low");
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    await expect(writeBulkPlan(brief, 15)).rejects.toThrow(/no usable hooks.*credit balance is too low/);
  });

  it("rewrites only the hooks whose wording clashes, telling the writer what is taken", async () => {
    // Every first write says the same thing; a rewrite (told what is taken) says something new.
    mode.headline = (key, n) => (prompts[n - 1]!.includes("already used on other images") ? `fresh ${key} wording ${n}` : "Stop wasting money on ads today");
    const { writeBulkPlan } = await import("@/lib/creatives/bulk/plan");
    const plan = await writeBulkPlan(brief, 15);
    expect(plan.hooks).toHaveLength(15);
    const rewriteCalls = prompts.filter((p) => p.includes("already used on other images"));
    // Fourteen hooks repeated the first one's words: those, and only those, were rewritten.
    expect(rewriteCalls.length).toBeGreaterThanOrEqual(14);
    expect(rewriteCalls.length).toBeLessThanOrEqual(14 * 2);
    expect(rewriteCalls[0]).toContain("Stop wasting money on ads today");
  });
});
