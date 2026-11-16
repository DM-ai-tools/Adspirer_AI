import { describe, expect, it, vi } from "vitest";
import { planConcepts, renderProblems } from "@/lib/video/concepts";
import type { CreativeBrief, VideoConcept } from "@/lib/video/script-types";

vi.mock("@/lib/video/creative-brief", () => ({
  briefForPrompt: (brief: CreativeBrief) => `BRIEF offer=${brief.offer.name}`,
}));

const BRIEF: CreativeBrief = {
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  company: { name: "Bluebird Bikes", source: "manifest" },
  offer: { name: "Monthly bike tune-up plan", description: "A mechanic services your bike every month", factIds: ["f1"] },
  conversion: { action: "Book the first tune-up", target: null, benefit: null, factIds: ["f1"] },
  audience: { primary: "city commuters", situation: "riding every day", factIds: [], inferred: true },
  mechanism: null,
  facts: [{ id: "f1", text: "A mechanic services your bike every month", category: "offer", source: { id: "s1", kind: "page", label: "Landing page", quote: "A mechanic services your bike every month" } }],
  inferences: [],
  rejectedFacts: [],
  voice: { tone: "friendly", vocabulary: [], avoid: [] },
  defaults: [],
  gaps: [],
  sourceQuality: "rich",
  limitation: null,
  injectionFlags: [],
};

type Raw = Omit<VideoConcept, "id" | "scores">;

const candidate = (n: number, over: Partial<Raw> = {}): Raw => ({
  title: `Concept ${n}`,
  format: `format ${n}`,
  logline: `Logline number ${n}`,
  hook: `Hook ${n}`,
  beats: [
    { text: "Opening", seconds: 5 },
    { text: "Middle", seconds: 10 },
    { text: "End", seconds: 8 },
  ],
  whyItWorks: "because",
  brandLink: "the monthly tune-up",
  look: "warm, handheld",
  cast: ["a commuter"],
  settings: ["a city street"],
  voices: [{ id: "narrator", who: "narrator", description: "dry, warm male voice" }],
  seconds: 23,
  ...over,
});

const score = (index: number, total: number, over: Record<string, unknown> = {}) => ({
  index,
  originality: total,
  hook: total,
  emotion: total,
  brand_link: total,
  renderable: 9,
  truth: 9,
  duplicate_of: null,
  note: "",
  ...over,
});

describe("renderProblems", () => {
  it("flags a beat longer than one scene and too many voices", () => {
    const problems = renderProblems({
      ...candidate(1, {
        beats: [{ text: "a long take", seconds: 20 }],
        voices: [1, 2, 3, 4].map((i) => ({ id: `v${i}`, who: `person ${i}`, description: "x" })),
      }),
      id: "c1",
    });
    expect(problems.join(" ")).toMatch(/15 seconds/);
    expect(problems.join(" ")).toMatch(/voices/);
  });

  it("finds nothing wrong with a concept the model can make", () => {
    expect(renderProblems({ ...candidate(1), id: "c1" })).toEqual([]);
  });
});

describe("planConcepts", () => {
  it("keeps the three strongest, dropping untrue, unrenderable and duplicate ones", async () => {
    const candidates = Array.from({ length: 8 }, (_, i) => candidate(i + 1));
    const judge = vi.fn(async () => ({
      scores: [
        score(0, 9, { truth: 3 }), // the best, but it claims what the brief does not say
        score(1, 8),
        score(2, 8, { duplicate_of: 1 }), // the same idea as candidate 1
        score(3, 7),
        score(4, 7, { renderable: 4 }),
        score(5, 6),
        score(6, 2),
        score(7, 1),
      ],
    }));
    const invent = vi.fn(async () => ({ concepts: candidates }));
    const out = await planConcepts(BRIEF, { targetSeconds: 30, direction: null, avoid: [], deps: { invent, judge } });
    expect(out.concepts.map((c) => c.title)).toEqual(["Concept 2", "Concept 4", "Concept 6"]);
    expect(out.limitation).toBeNull();
    expect(new Set(out.concepts.map((c) => c.id)).size).toBe(3);
    expect(out.concepts[0]!.scores?.truth).toBe(9);
  });

  it("tells the model which ideas were already made for this client", async () => {
    const invent = vi.fn(async (_prompt: string) => ({ concepts: Array.from({ length: 3 }, (_, i) => candidate(i + 1)) }));
    const judge = vi.fn(async () => ({ scores: [score(0, 8), score(1, 7), score(2, 6)] }));
    await planConcepts(BRIEF, { targetSeconds: 30, direction: "a movie trailer", avoid: ["A heist to steal a flat tyre"], deps: { invent, judge } });
    const prompt = invent.mock.calls[0]![0];
    expect(prompt).toContain("A heist to steal a flat tyre");
    expect(prompt).toContain("a movie trailer");
    expect(prompt).toContain("BRIEF offer=Monthly bike tune-up plan");
  });

  it("drops a concept whose beat is too long for one clip even if the judge liked it", async () => {
    const invent = vi.fn(async () => ({ concepts: [candidate(1, { beats: [{ text: "one long take", seconds: 25 }] }), candidate(2), candidate(3), candidate(4)] }));
    const judge = vi.fn(async () => ({ scores: [score(0, 10), score(1, 8), score(2, 7), score(3, 6)] }));
    const out = await planConcepts(BRIEF, { targetSeconds: 30, direction: null, avoid: [], deps: { invent, judge } });
    expect(out.concepts.map((c) => c.title)).toEqual(["Concept 2", "Concept 3", "Concept 4"]);
  });

  it("asks once more with the reasons, then shows what survived with a plain note", async () => {
    const invent = vi.fn(async () => ({ concepts: [candidate(1), candidate(2)] }));
    const judge = vi.fn(async () => ({ scores: [score(0, 8), score(1, 7, { truth: 2, note: "invents a guarantee" })] }));
    const out = await planConcepts(BRIEF, { targetSeconds: 30, direction: null, avoid: [], deps: { invent, judge } });
    expect(invent).toHaveBeenCalledTimes(2);
    expect(String(invent.mock.calls[1]![0])).toContain("invents a guarantee");
    expect(out.concepts.length).toBeGreaterThanOrEqual(1);
    expect(out.concepts.length).toBeLessThan(3);
    expect(out.limitation).toMatch(/concept/i);
  });

  it("does not show the same idea twice when the second round repeats the first", async () => {
    const invent = vi.fn(async () => ({ concepts: [candidate(1), candidate(2)] }));
    const judge = vi.fn(async () => ({ scores: [score(0, 8), score(1, 7)] }));
    const out = await planConcepts(BRIEF, { targetSeconds: 30, direction: null, avoid: [], deps: { invent, judge } });
    expect(out.concepts.map((c) => c.logline)).toEqual(["Logline number 1", "Logline number 2"]);
  });

  it("keeps working when the judge cannot be reached, ranking by order", async () => {
    const invent = vi.fn(async () => ({ concepts: Array.from({ length: 4 }, (_, i) => candidate(i + 1)) }));
    const judge = vi.fn(async () => {
      throw new Error("judge down");
    });
    const out = await planConcepts(BRIEF, { targetSeconds: 30, direction: null, avoid: [], deps: { invent, judge } });
    expect(out.concepts.map((c) => c.title)).toEqual(["Concept 1", "Concept 2", "Concept 3"]);
  });
});
