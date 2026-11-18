import { describe, expect, it } from "vitest";
import { buildPlannedClipPrompt, type PlannedClipPromptInput } from "@/lib/video/clip-prompt";
import type { PlanCharacter, SceneBrief } from "@/lib/video/pipeline-types";
import run from "./fixtures/weather-forecast-run.json";

// The prompt is written the way BytePlus's own "Dreamina Seedance 2.0 series prompt guide" asks (read 18 Nov 2026):
//  - define each person from their picture ("Define the person in Image 1 as ...") and name them the same way every time;
//  - a storyboard of "Shot N" in the order things happen, each shot's camera first, then who is where and what they do,
//    then sound and speech; no hard time ranges, because the guide says forced timing gives unstable results;
//  - dialogue in { } with who says it, music in ( ), one language;
//  - constraints at the end, including the guide's own fix for duplicated people.

const characters = run.characters as PlanCharacter[];
const briefs = run.briefs as unknown as SceneBrief[];
const brief = (n: number) => briefs.find((b) => b.number === n)!;
const lineOf = (n: number) => run.scenes.find((s) => s.number === n)!.line;

const input = (nums: number[], over: Partial<PlannedClipPromptInput> = {}): PlannedClipPromptInput => ({
  scenes: nums.map(brief),
  spoken: Object.fromEntries(nums.filter((n) => lineOf(n)).map((n) => [n, { text: lineOf(n), speaker: "on_camera" as const, parts: [{ voiceId: n === 5 ? "dean" : "marcus", who: n === 5 ? "Dean" : "Marcus", text: lineOf(n), onCamera: true }] }])),
  characters,
  environments: run.environments as never,
  style: run.style,
  clipNumber: 2,
  clipCount: 2,
  locale: "en-AU",
  refs: { characterIds: ["dean", "marcus"], environmentIds: [], previousFrame: false, previousVideo: false },
  corrections: [],
  nextContinues: false,
  clean: true,
  voices: [
    { id: "marcus", who: "Marcus", description: "Male, mid-40s, deep baritone", videoRef: null },
    { id: "dean", who: "Dean", description: "Male, late 30s, dry and flat", videoRef: null },
  ],
  ...over,
});

const prompt = buildPlannedClipPrompt(input([5, 6, 7]));
const shots = prompt.split("\n").filter((l) => /^Shot \d+ \(/.test(l));

describe("the clip prompt in the Seedance guide's format", () => {
  it("defines each person from their picture, once, by the name used for them everywhere", () => {
    expect(prompt).toMatch(/Define the person in Image 1 as [^:]+: keep this exact person/);
    expect(prompt).toMatch(/Define the person in Image 2 as [^:]+: keep this exact person/);
  });

  it("is a storyboard of numbered shots, with a pace and no hard time range", () => {
    expect(prompt).toContain("Storyboard (shots in the order they happen, each one continuous):");
    expect(shots).toHaveLength(3);
    for (const s of shots) expect(s).toMatch(/^Shot \d+ \(about \d+ seconds\)\./);
    expect(prompt).not.toMatch(/^\d+s-\d+s:/m);
  });

  it("writes each shot in the guide's order: camera, then who and where and what they do, then sound and speech", () => {
    for (const s of shots) {
      const at = (re: RegExp) => s.search(re);
      expect(at(/Camera:/)).toBeGreaterThan(-1);
      expect(at(/Subject and place:/)).toBeGreaterThan(at(/Camera:/));
      expect(at(/Action:/)).toBeGreaterThan(at(/Subject and place:/));
      expect(at(/Light:/)).toBeGreaterThan(at(/Action:/));
    }
    const talking = shots.find((s) => s.includes("Shot 5 ("))!;
    expect(talking.search(/says \{/)).toBeGreaterThan(talking.search(/Light:/));
  });

  it("puts every spoken line in braces, exactly as written, and names who says it", () => {
    for (const n of [5, 6, 7]) {
      if (lineOf(n)) expect(prompt).toContain(`{${lineOf(n).split(/\s+/).join(" ")}}`);
    }
    expect(prompt).toMatch(/Dean[^\n]*, on camera, says \{/);
    // no quoted copy of the words is left to be read as something to display
    expect(prompt).not.toContain(`"${lineOf(5)}"`);
  });

  it("tells the model the lines in braces are the exact words, in one language", () => {
    expect(prompt).toMatch(/The lines in braces \{ \} are the exact words/);
    expect(prompt).toMatch(/word for word as written in the braces/);
  });

  it("ends with constraints, among them no duplicated people and music in brackets", () => {
    const at = prompt.indexOf("Constraints:");
    expect(at).toBeGreaterThan(prompt.indexOf("Storyboard"));
    const tail = prompt.slice(at);
    expect(tail).toMatch(/Audio: \(no background music\)/);
    expect(tail).toMatch(/no duplicate avatars, no twin or repeated copies/i);
    expect(tail).toMatch(/subtitles|captions/i);
  });

  it("a brace inside the words cannot break the dialogue marker", () => {
    const p = buildPlannedClipPrompt(input([5], { spoken: { 5: { text: "Say {this} now.", speaker: "on_camera", parts: [{ voiceId: "dean", who: "Dean", text: "Say {this} now.", onCamera: true }] } } }));
    expect(p).toContain("{Say this now.}");
  });
});

describe("what is asked of the video model, not of a reviewer", () => {
  it("states a shot's checks as what the shot shows, never as an instruction to check or ensure", () => {
    expect(prompt).not.toMatch(/\b(Check that|Ensure|Verify that)\b/);
    expect(prompt).toMatch(/This shot must show: [a-z]/i);
  });
  it("does not end a person's description in two full stops", () => {
    expect(prompt).not.toMatch(/\.\./);
  });
});
