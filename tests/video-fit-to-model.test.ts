import { describe, expect, it, vi } from "vitest";
import { fitToModel, unrenderable } from "@/lib/video/fit-to-model";
import { retime } from "@/lib/video/timing";
import type { VideoScene, VideoScript } from "@/lib/video/script";

const words = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

const scene = (n: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({
  number: n,
  start: 0,
  end: 0,
  seconds: 0,
  visual: `A cyclist rides through the park ${n}`,
  camera: "tracking",
  speaker: line ? "voiceover" : "none",
  line,
  keywords: [],
  stat: null,
  assetId: null,
  sound: "",
  ...extra,
});

const scriptOf = (scenes: VideoScene[]): VideoScript => {
  const timed = retime(scenes);
  return {
    id: "script_uploaded",
    title: "Mine",
    angle: { key: "uploaded", name: "", stage: "", kind: "custom" },
    pain: "",
    framework: { key: "custom", name: "" },
    style: "documentary",
    durationSeconds: timed.at(-1)!.end,
    hookAlternatives: [],
    character: null,
    setting: "a park",
    scenes: timed,
    adCopy: { primaryText: "", headline: "", description: "", cta: "Learn More" },
    warnings: [],
    source: "uploaded",
  };
};

describe("what the video model cannot draw", () => {
  it("names text, screens, logos and famous people", () => {
    expect(unrenderable("A billboard that reads SALE")).not.toEqual([]);
    expect(unrenderable("Close-up of the dashboard on a laptop screen")).not.toEqual([]);
    expect(unrenderable("A celebrity lookalike of a famous footballer waves")).toContain("a real or famous person");
    expect(unrenderable("A cyclist rides through the park at dawn")).toEqual([]);
  });
});

describe("fitting a script to the model", () => {
  it("leaves a script that already fits exactly as it is, with nothing to report", async () => {
    const s = scriptOf([scene(1, "Ride further."), scene(2, "Book a tune-up.")]);
    const out = await fitToModel(s, { maxSeconds: 60, repicture: async () => ({}) });
    expect(out.adaptations).toEqual([]);
    expect(out.script.scenes.map((x) => x.line)).toEqual(s.scenes.map((x) => x.line));
  });

  it("splits a scene longer than one clip, keeping every word exactly, and says so", async () => {
    const long = `${words(30, "a")}. ${words(30, "b")}.`;
    const s = scriptOf([scene(1, "Ride further."), scene(2, ""), scene(3, long), scene(4, "Book a tune-up.")]);
    const out = await fitToModel(s, { maxSeconds: 60, repicture: async () => ({}) });
    expect(out.script.scenes.every((x) => x.seconds <= 15)).toBe(true);
    expect(out.script.scenes.map((x) => x.line).join(" ").replace(/\s+/g, " ")).toBe(["Ride further.", long, "Book a tune-up."].join(" ").replace(/\s+/g, " "));
    expect(out.adaptations.join(" ")).toMatch(/Scene 3 split in 2/);
  });

  it("re-pictures a visual the model cannot draw and reports why", async () => {
    const s = scriptOf([scene(1, "Ride further.", { visual: "A billboard that says RIDE FURTHER" }), scene(2, "Book a tune-up.")]);
    const repicture = vi.fn(async (scenes: Array<{ number: number; visual: string; reasons: string[] }>) => {
      expect(scenes.map((x) => x.number)).toEqual([1]);
      return { 1: "A cyclist crests a hill at sunrise" };
    });
    const out = await fitToModel(s, { maxSeconds: 60, repicture });
    expect(out.script.scenes[0]!.visual).toBe("A cyclist crests a hill at sunrise");
    expect(out.script.scenes[0]!.line).toBe("Ride further.");
    expect(out.adaptations.join(" ")).toMatch(/Scene 1/);
  });

  it("keeps the visual when re-picturing fails, and says it may not render well", async () => {
    const s = scriptOf([scene(1, "Ride further.", { visual: "A billboard that says RIDE FURTHER" }), scene(2, "Book a tune-up.")]);
    const out = await fitToModel(s, {
      maxSeconds: 60,
      repicture: async () => {
        throw new Error("down");
      },
    });
    expect(out.script.scenes[0]!.visual).toBe("A billboard that says RIDE FURTHER");
    expect(out.adaptations.join(" ")).toMatch(/may not come out/);
  });

  it("drops middle scenes from a script over the length limit, never the first or last, and says which", async () => {
    const s = scriptOf(Array.from({ length: 8 }, (_, i) => scene(i + 1, words(30, `s${i}`))));
    expect(s.durationSeconds).toBeGreaterThan(60);
    const out = await fitToModel(s, { maxSeconds: 60, repicture: async () => ({}) });
    expect(out.script.durationSeconds).toBeLessThanOrEqual(60);
    expect(out.script.scenes[0]!.line).toBe(words(30, "s0"));
    expect(out.script.scenes.at(-1)!.line).toBe(words(30, "s7"));
    expect(out.adaptations.join(" ")).toMatch(/longer than 60 seconds/);
  });
});

describe("reading the operator's own concept", () => {
  it("keeps their idea and splits a beat longer than one scene", async () => {
    const { conceptFromText } = await import("@/lib/video/fit-to-model");
    const generate = vi.fn(async (prompt: string) => ({
      title: "Goldfish Doc",
      format: "nature documentary",
      logline: prompt.includes("goldfish") ? "A goldfish narrates a shop owner's day." : "wrong",
      hook: "A goldfish stares into the lens.",
      beats: [{ text: "The day begins", seconds: 25 }, { text: "The close", seconds: 5 }],
      whyItWorks: "absurd",
      brandLink: "ads for shops",
      look: "soft",
      cast: ["the shop owner"],
      settings: ["a shop"],
      voices: [{ id: "narrator", who: "the goldfish", description: "hushed British" }],
      seconds: 30,
    }));
    const c = await conceptFromText("A goldfish narrates a shop owner's day as a nature documentary.", { targetSeconds: 30, deps: { generate } });
    expect(c.logline).toBe("A goldfish narrates a shop owner's day.");
    expect(c.beats.every((b) => b.seconds <= 15)).toBe(true);
    expect(c.beats.length).toBe(3);
    expect(c.id).toMatch(/^concept_own_/);
  });
});

describe("reading any text as the operator's concept", () => {
  const LONG = Array.from({ length: 11 }, (_, i) => `Scene ${i + 1}: Beat number ${i + 1} of the story happens here, with its own action and its own line.`).join("\n\n");

  it("accepts a concept with more beats, people and places than the old limits and keeps it to what the system can hold", async () => {
    const { conceptFromText } = await import("@/lib/video/fit-to-model");
    const generate = async () => ({
      title: "Long", format: "mini film", logline: "A long story.", hook: "Opening", whyItWorks: "w", brandLink: "b", look: "l", seconds: 60,
      beats: Array.from({ length: 11 }, (_, i) => ({ text: `Beat ${i + 1}`, seconds: 5 })),
      cast: ["a", "b", "c", "d", "e", "f", "g", "h"], settings: ["1", "2", "3", "4", "5", "6", "7"],
      voices: [{ id: "a", who: "a", description: "d" }, { id: "b", who: "b", description: "d" }, { id: "c", who: "c", description: "d" }, { id: "d", who: "d", description: "d" }, { id: "e", who: "e", description: "d" }],
    });
    const c = await conceptFromText(LONG, { targetSeconds: 60, deps: { generate } });
    expect(c.beats.length).toBeLessThanOrEqual(8);
    // merging beats keeps the story and its total length
    expect(c.beats.reduce((t, b) => t + b.seconds, 0)).toBeGreaterThanOrEqual(55);
    expect(c.beats.map((b) => b.text).join(" ")).toContain("Beat 11");
    expect(c.cast.length).toBeLessThanOrEqual(6);
    expect(c.voices.length).toBeLessThanOrEqual(4);
  });

  it("still reads the text when the model cannot", async () => {
    const { conceptFromText } = await import("@/lib/video/fit-to-model");
    const generate = async () => {
      throw new Error("No object generated: response did not match schema.");
    };
    const c = await conceptFromText(LONG, { targetSeconds: 40, deps: { generate } });
    expect(c.beats.length).toBeGreaterThanOrEqual(2);
    expect(c.beats.length).toBeLessThanOrEqual(8);
    expect(c.beats.map((b) => b.text).join(" ")).toContain("Beat number 11");
    expect(c.voices.length).toBeGreaterThanOrEqual(1);
    expect(c.id).toMatch(/^concept_own_/);
  });

  it("reads a single sentence as a concept", async () => {
    const { conceptFromText } = await import("@/lib/video/fit-to-model");
    const c = await conceptFromText("A goldfish runs a shop.", { targetSeconds: 20, deps: { generate: async () => { throw new Error("down"); } } });
    expect(c.beats.length).toBeGreaterThanOrEqual(2);
    expect(c.logline).toMatch(/goldfish/);
  });
});
