import { describe, expect, it, vi } from "vitest";
import { conceptAngle, conceptScriptPrompt, conceptWrittenSchema, buildConceptScript, normaliseVoices, splitLongScenes, writeScriptForConcept, type ConceptWritten, type WriteContext } from "@/lib/video/script-writer";
import { MAX_SCENE_SECONDS, splitLongLine } from "@/lib/video/timing";
import type { VideoBrief, VideoScript } from "@/lib/video/script";
import type { CreativeBrief, VideoConcept } from "@/lib/video/script-types";

const creative: CreativeBrief = {
  version: 1,
  createdAt: "",
  company: { name: "Kestrel Roofing", source: "brand manifest" },
  offer: { name: "Storm damage roof inspection", description: "A same-week inspection with a written report", factIds: ["f1"] },
  conversion: { action: "Book a roof inspection", target: null, benefit: null, factIds: ["f1"] },
  audience: { primary: "Homeowners after a hailstorm", situation: "after hail", factIds: [], inferred: false },
  mechanism: null,
  facts: [{ id: "f1", text: "Inspections are booked online and happen within the week", category: "conversion", source: { id: "p", kind: "page", label: "Landing page", quote: "Book online. Inspections happen within the week." } }],
  inferences: [],
  rejectedFacts: [],
  voice: { tone: "plain", vocabulary: [], avoid: [] },
  defaults: [],
  gaps: [],
  sourceQuality: "rich",
  limitation: null,
  injectionFlags: [],
};

const brief: VideoBrief = { brandName: "Kestrel Roofing", offerName: "Storm damage roof inspection", stats: [], images: [], targetSeconds: 30, style: "auto", locale: "en-AU" };

const ctx: WriteContext = {
  creative,
  brief,
  targetSeconds: 30,
  wordsPerSecond: 2.5,
  assetIds: [],
  claims: [],
  sourceText: "Book online. Inspections happen within the week.",
  facts: "Business: Kestrel Roofing",
  corpus: "Kestrel Roofing storm damage roof inspection",
};

const concept: VideoConcept = {
  id: "concept_x_1",
  title: "The Hail Heist",
  format: "one-take heist scene",
  logline: "A crew of hailstones plans the perfect roof robbery, until an inspector shows up.",
  hook: "A hailstone in a balaclava taps a map of the suburb.",
  beats: [
    { text: "The hailstones plan the job", seconds: 8 },
    { text: "The storm hits the roof", seconds: 8 },
    { text: "The inspector finds every mark", seconds: 10 },
  ],
  whyItWorks: "A heist movie about weather is absurd enough to share.",
  brandLink: "Inspections happen within the week, so the damage is found.",
  look: "moody heist-film lighting",
  cast: ["the inspector"],
  settings: ["a suburban roof"],
  voices: [
    { id: "narrator", who: "narrator", description: "gravelly trailer voice" },
    { id: "inspector", who: "the inspector", description: "calm Australian woman, 40s" },
  ],
  seconds: 28,
};

const words = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

function raw(over: Partial<ConceptWritten> = {}): ConceptWritten {
  return {
    title: "The Hail Heist",
    hook_candidates: [
      { line: "Every job needs a plan.", why: "heist cliché turned" },
      { line: "They came at night.", why: "tension" },
      { line: "Nobody saw them coming.", why: "mystery" },
      { line: "It was the perfect storm.", why: "pun" },
    ],
    chosen_hook: 0,
    hook_payoff: "The inspector finds what the storm hid",
    style: "Cinematic heist",
    dramatisation: true,
    character: "the inspector, calm woman in her 40s in a hi-vis jacket",
    setting: "a suburban roof at night",
    voices: [
      { id: "narrator", who: "narrator", description: "gravelly trailer voice" },
      { id: "inspector", who: "the inspector", description: "calm Australian woman, 40s" },
    ],
    scenes: [
      { seconds: 4, visual: "Hailstones around a map", camera: "slow push", sound: "tense strings", lines: [{ voice_id: "narrator", text: "Every job needs a plan.", on_camera: false }] },
      { seconds: 4, visual: "Hail hammers a roof", camera: "low angle", sound: "storm", lines: [] },
      {
        seconds: 4,
        visual: "The inspector on the roof with a torch",
        camera: "handheld",
        sound: "rain stops",
        lines: [
          { voice_id: "inspector", text: "Found you.", on_camera: true },
          { voice_id: "narrator", text: "Book the inspection online.", on_camera: false },
        ],
      },
    ],
    visual_direction: "A heist film shot on a roof.",
    on_screen: [],
    cta: { spoken: "Book the inspection online.", label: "Book Now", target: null, benefit: null },
    sources: [{ claim: "Inspections happen within the week", fact_id: "f1" }],
    primary_text: "Hail is a quiet thief. ".repeat(12),
    headline: "Catch the hail heist",
    description: "Book online",
    ...over,
  };
}

describe("a concept as the idea to write", () => {
  it("carries the concept's title, logline and hook into the angle the writer works from", () => {
    const a = conceptAngle(concept);
    expect(a.id).toBe(concept.id);
    expect(a.name).toBe("The Hail Heist");
    expect(a.situation).toContain("hailstones plans the perfect roof robbery");
    expect(a.hookPremise).toBe(concept.hook);
  });

  it("puts the whole concept in the prompt, the 15 second scene cap, and nothing about stats", () => {
    const p = conceptScriptPrompt(ctx, concept);
    expect(p).toContain("The Hail Heist");
    expect(p).toContain("one-take heist scene");
    expect(p).toContain("The inspector finds every mark");
    expect(p).toContain("calm Australian woman, 40s");
    expect(p).toContain(`${MAX_SCENE_SECONDS} seconds`);
    expect(p).not.toMatch(/main stat|MAIN FIGURE|operator stats/i);
  });
});

describe("turning a concept draft into a script", () => {
  it("keeps the voices and who says each line, and the scene's words are the lines in order", () => {
    const s = buildConceptScript(conceptWrittenSchema.parse(raw()), concept, ctx);
    expect(s.voices?.map((v) => v.id)).toEqual(["narrator", "inspector"]);
    expect(s.concept?.id).toBe(concept.id);
    const last = s.scenes[2]!;
    expect(last.lines).toEqual([
      { voiceId: "inspector", text: "Found you.", onCamera: true },
      { voiceId: "narrator", text: "Book the inspection online.", onCamera: false },
    ]);
    expect(last.line).toBe("Found you. Book the inspection online.");
    expect(last.speaker).toBe("on_camera");
    expect(s.scenes[1]!.speaker).toBe("none");
    expect(s.scenes.every((x) => x.stat === null && x.assetId === null)).toBe(true);
    expect(s.imageStats).toBeUndefined();
  });

  it("ignores a line given to a voice the script does not have, by giving it to the first voice", () => {
    const r = raw();
    r.scenes[0]!.lines = [{ voice_id: "ghost", text: "Every job needs a plan.", on_camera: false }];
    const s = buildConceptScript(conceptWrittenSchema.parse(r), concept, ctx);
    expect(s.scenes[0]!.lines![0]!.voiceId).toBe("narrator");
  });
});

describe("no scene longer than one clip", () => {
  it("splits a long line into parts that each fit, keeping every word in order", () => {
    const text = `${words(20, "a")}. ${words(25, "b")}. ${words(15, "c")}.`;
    const parts = splitLongLine(text);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    for (const p of parts) expect(Math.ceil(p.split(/\s+/).length / 2.7 + 0.3)).toBeLessThanOrEqual(MAX_SCENE_SECONDS);
  });

  it("splits a single sentence with no full stops at commas, then by words", () => {
    const text = words(80);
    const parts = splitLongLine(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join(" ")).toBe(text);
  });

  it("splits a long scene into several scenes of at most 15 seconds, same picture, every word kept", () => {
    const s = buildConceptScript(conceptWrittenSchema.parse(raw()), concept, ctx);
    const long = { ...s, scenes: s.scenes.map((x, i) => (i === 0 ? { ...x, line: words(70), lines: [{ voiceId: "narrator", text: words(70), onCamera: false }] } : x)) } as VideoScript;
    const out = splitLongScenes(long);
    expect(out.scenes.every((x) => x.seconds <= MAX_SCENE_SECONDS)).toBe(true);
    expect(out.scenes.length).toBeGreaterThan(s.scenes.length);
    expect(out.scenes.slice(0, out.scenes.length - 2).map((x) => x.line).join(" ")).toBe(words(70));
    expect(out.scenes[1]!.visual).toBe(out.scenes[0]!.visual);
    expect(out.scenes.map((x) => x.number)).toEqual(out.scenes.map((_, i) => i + 1));
  });

  it("splits a two-voice scene between its speakers before splitting words", () => {
    const s = buildConceptScript(conceptWrittenSchema.parse(raw()), concept, ctx);
    const long = {
      ...s,
      scenes: [
        { ...s.scenes[2]!, lines: [{ voiceId: "inspector", text: words(25, "i"), onCamera: true }, { voiceId: "narrator", text: words(25, "n"), onCamera: false }], line: `${words(25, "i")} ${words(25, "n")}` },
      ],
    } as VideoScript;
    const out = splitLongScenes(long);
    expect(out.scenes.map((x) => x.lines?.map((l) => l.voiceId))).toEqual([["inspector"], ["narrator"]]);
  });
});

describe("older scripts", () => {
  it("get one narrator voice and lines made from their single line", () => {
    const old = { scenes: [{ number: 1, line: "Hello there.", speaker: "on_camera" }, { number: 2, line: "", speaker: "none" }], character: "a presenter" } as unknown as VideoScript;
    const n = normaliseVoices(old);
    expect(n.voices).toEqual([{ id: "narrator", who: "the presenter", description: "" }]);
    expect(n.scenes[0]!.lines).toEqual([{ voiceId: "narrator", text: "Hello there.", onCamera: true }]);
    expect(n.scenes[1]!.lines).toEqual([]);
  });
});

describe("writing from a concept", () => {
  it("asks the model again when a scene is too long, then splits what is still too long", async () => {
    const long = raw();
    long.scenes[0]!.lines = [{ voice_id: "narrator", text: words(60), on_camera: false }];
    const generate = vi.fn(async (prompt: string) => (prompt ? long : long));
    const s = await writeScriptForConcept(ctx, concept, { generate });
    expect(generate.mock.calls.length).toBeGreaterThan(1);
    expect(String(generate.mock.calls[1]![0])).toMatch(/longer than 15 seconds/);
    expect(s.scenes.every((x) => x.seconds <= MAX_SCENE_SECONDS)).toBe(true);
    expect(s.id).toBe(`script_${concept.id}`);
  });
});
