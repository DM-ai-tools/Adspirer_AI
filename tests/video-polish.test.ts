import { describe, expect, it, vi } from "vitest";
import { planConcepts } from "@/lib/video/concepts";
import { applyChange } from "@/lib/video/change-request";
import { buildConceptScript, conceptWrittenSchema, type ConceptWritten, type WriteContext } from "@/lib/video/script-writer";
import { retime } from "@/lib/video/timing";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { CreativeBrief, VideoConcept } from "@/lib/video/script-types";

vi.mock("@/lib/video/creative-brief", async (orig) => ({ ...(await orig<typeof import("@/lib/video/creative-brief")>()), briefForPrompt: () => "BRIEF" }));

const brief = {
  version: 1,
  createdAt: "",
  company: { name: "Acme", source: "m" },
  offer: { name: "Ads", description: "", factIds: [] },
  conversion: null,
  audience: { primary: "shops", situation: "", factIds: [], inferred: true },
  mechanism: null,
  facts: [],
  inferences: [],
  rejectedFacts: [],
  voice: { tone: "plain", vocabulary: [], avoid: [] },
  defaults: [],
  gaps: [],
  sourceQuality: "rich",
  limitation: null,
  injectionFlags: [],
} as CreativeBrief;

const candidate = (n: number) => ({
  title: `Concept ${n}`,
  format: "f",
  logline: `Logline ${n}`,
  hook: "h",
  beats: [{ text: "b", seconds: 5 }, { text: "c", seconds: 5 }],
  whyItWorks: "w",
  brandLink: "l",
  look: "l",
  cast: [],
  settings: [],
  voices: [{ id: "narrator", who: "narrator", description: "d" }],
  seconds: 20,
});
const score = (index: number, total: number, over: Record<string, unknown> = {}) => ({ index, originality: total, hook: total, emotion: total, brand_link: total, renderable: 9, truth: 9, duplicate_of: null, note: "", ...over });

describe("concepts the judge did not score", () => {
  it("come after every scored concept, in their own order", async () => {
    const invent = vi.fn(async () => ({ concepts: [candidate(1), candidate(2), candidate(3), candidate(4)] }));
    const judge = vi.fn(async () => ({ scores: [score(0, 7), score(2, 9)] }));
    const out = await planConcepts(brief, { targetSeconds: 30, direction: null, avoid: [], deps: { invent, judge } });
    expect(out.concepts.map((c) => c.title)).toEqual(["Concept 3", "Concept 1", "Concept 2"]);
  });
});

describe("when the second round of concepts fails", () => {
  it("reports the real reason, not a generic one", async () => {
    let call = 0;
    const invent = vi.fn(async () => {
      call += 1;
      if (call === 2) throw new Error("Rate limit reached for this model");
      return { concepts: [candidate(1)] };
    });
    const judge = vi.fn(async () => ({ scores: [score(0, 8, { truth: 2 })] }));
    await expect(planConcepts(brief, { targetSeconds: 30, direction: null, avoid: [], deps: { invent, judge } })).rejects.toThrow(/Rate limit/);
  });
});

const scene = (n: number, text: string, voiceId = "narrator"): VideoScene => ({
  number: n,
  start: 0,
  end: 0,
  seconds: 0,
  visual: "v",
  camera: "c",
  speaker: "voiceover",
  line: text,
  keywords: [],
  stat: null,
  assetId: null,
  sound: "",
  lines: [{ voiceId, text, onCamera: false }],
});

const scriptOf = (scenes: VideoScene[], over: Partial<VideoScript> = {}): VideoScript => {
  const timed = retime(scenes);
  return {
    id: "s",
    title: "t",
    angle: { key: "a", name: "a", stage: "", kind: "custom" },
    pain: "",
    framework: { key: "custom", name: "" },
    style: "s",
    durationSeconds: timed.at(-1)!.end,
    hookAlternatives: [],
    character: null,
    setting: "s",
    scenes: timed,
    adCopy: { primaryText: "p", headline: "h", description: "d", cta: "Book Now" },
    warnings: [],
    voices: [{ id: "narrator", who: "narrator", description: "" }],
    cta: { spoken: "Book now.", label: "Book Now", target: null, benefit: null },
    ...over,
  };
};

describe("changing the last line", () => {
  it("keeps the recorded closing line the same as what is said last", () => {
    const s = scriptOf([scene(1, "Hello there."), scene(2, "Book now.")]);
    const out = applyChange(s, { scope: "scenes", scenes: [2], summary: "New ending", edits: [{ scene: 2, lines: [{ voiceId: "narrator", text: "Book your audit today.", onCamera: false }] }], adCopy: null, problem: null });
    expect(out.cta?.spoken).toBe("Book your audit today.");
  });
});

describe("a scene the operator edited, in a rewrite with fewer voices", () => {
  it("keeps the voice that speaks in it", () => {
    const concept = { id: "c1", title: "T", format: "f", logline: "l", hook: "h", beats: [{ text: "b", seconds: 4 }], whyItWorks: "w", brandLink: "b", look: "l", cast: [], settings: [], voices: [{ id: "narrator", who: "narrator", description: "" }], seconds: 12 } as VideoConcept;
    const previous = {
      ...scriptOf([scene(1, "Every job needs a plan."), { ...scene(2, "Found you.", "maya"), edited: true }, scene(3, "Book now.")]),
      voices: [
        { id: "narrator", who: "narrator", description: "gravelly" },
        { id: "maya", who: "Maya", description: "calm" },
      ],
    };
    const raw: ConceptWritten = {
      title: "T",
      hook_candidates: [{ line: "Every job needs a plan.", why: "w" }, { line: "b", why: "w" }, { line: "c", why: "w" }, { line: "d", why: "w" }],
      chosen_hook: 0,
      hook_payoff: "p",
      style: "s",
      dramatisation: true,
      character: null,
      setting: "s",
      voices: [{ id: "narrator", who: "narrator", description: "gravelly" }],
      scenes: [0, 1, 2].map((i) => ({ seconds: 4, visual: "v", camera: "c", sound: "", lines: [{ voice_id: "narrator", text: ["Every job needs a plan.", "Something else.", "Book now."][i]!, on_camera: false }] })),
      visual_direction: "v",
      on_screen: [],
      cta: { spoken: "Book now.", label: "Book Now", target: null, benefit: null },
      sources: [],
      primary_text: "p ".repeat(40),
      headline: "h",
      description: "d",
    };
    const ctx = { creative: brief, brief: { brandName: "Acme", offerName: "Ads", stats: [], images: [], targetSeconds: 12, style: "auto", locale: "en-AU" }, targetSeconds: 12, wordsPerSecond: 2.5, assetIds: [], claims: [], sourceText: "", facts: "", corpus: "" } as WriteContext;
    const out = buildConceptScript(conceptWrittenSchema.parse(raw), concept, ctx, previous);
    expect(out.scenes[1]!.lines![0]!.voiceId).toBe("maya");
    expect(out.voices?.map((v) => v.id)).toContain("maya");
    expect(out.voices?.find((v) => v.id === "maya")?.description).toBe("calm");
  });
});
