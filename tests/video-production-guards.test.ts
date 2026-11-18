import { describe, expect, it } from "vitest";
import { buildPlannedClipPrompt, type PlannedClipPromptInput } from "@/lib/video/clip-prompt";
import { compareSpokenToExpected, spokenTokens } from "@/lib/video/subtitles";
import { liveAction, onlyInShotLine, pointingLine, presentFromFirstFrame, sceneCharacterIds, SAY_ONCE_RULE, showPointedAt } from "@/lib/video/prompt-guards";
import { isStillAction } from "@/lib/video/visual-rules";
import { continuityFor } from "@/lib/video/pipeline";
import type { PlanCharacter, SceneBrief, SpeechLine } from "@/lib/video/pipeline-types";
import type { AsrWord } from "@/lib/video/captions";
import run from "./fixtures/weather-forecast-run.json";

// "The Weather Forecast" (googlescale.trafficradius.com.au), the finished 48s video, checked frame by frame:
//  - clip 1 had a second man standing beside the presenter in every wide shot, although the script brings him in at
//    scene 5: both characters have the role "Presenter", so every scene that says "the presenter" matched both;
//  - clip 2 opened on an empty chart while Dean's voice spoke (no mouth to sync to), with letters drawn on the chart;
//  - "is bleeding spend" was said twice and "Radius" came out as "Radio", and the speech check passed both;
//  - the presenter "taps the map" but the pointer ends beside the target, and "raises and lowers the pointer" at nothing.

const characters = run.characters as PlanCharacter[];
const briefs = run.briefs as unknown as SceneBrief[];
const brief = (n: number) => briefs.find((b) => b.number === n)!;

describe("who is in a scene when two characters share the role 'Presenter'", () => {
  it("scene 1 shows Marcus only, not Dean", () => {
    expect(sceneCharacterIds(characters, brief(1), ["Marcus"])).toEqual(["marcus"]);
  });
  it("every scene of clip 1 shows Marcus only", () => {
    for (const n of [1, 2, 3, 4]) expect(sceneCharacterIds(characters, brief(n), n === 4 ? [] : ["Marcus"])).toEqual(["marcus"]);
  });
  it("scene 5 shows Dean, scene 6 and 7 Marcus", () => {
    expect(sceneCharacterIds(characters, brief(5), ["Dean"])).toEqual(["dean"]);
    expect(sceneCharacterIds(characters, brief(6), ["Marcus"])).toEqual(["marcus"]);
    expect(sceneCharacterIds(characters, brief(7), ["Marcus"])).toEqual(["marcus"]);
  });
  it("still finds a second person who is named in the shot", () => {
    const two = { ...brief(5), action: "Dean rolls the map aside while Marcus watches from the edge of frame." };
    expect(sceneCharacterIds(characters, two, ["Dean"]).sort()).toEqual(["dean", "marcus"]);
  });
  it("still finds a person by a role that only they have", () => {
    const cast: PlanCharacter[] = [
      { id: "a", role: "Business owner", description: "A woman" },
      { id: "b", role: "New arrival", description: "A man" },
    ];
    expect(sceneCharacterIds(cast, { characterId: "a", subject: "the business owner", framing: "Wide", action: "The new arrival walks in", setting: "office" }).sort()).toEqual(["a", "b"]);
  });
});

const speechOf = (n: number): SpeechLine => {
  const s = run.scenes.find((x) => x.number === n)!;
  return { sceneNumber: n, display: s.line, spoken: s.line.replace("$120 million", "one hundred and twenty million dollars").replace(/fifteen hundred/, "fifteen hundred"), segments: [], uncertain: [] };
};
const words = run.clip2Words as AsrWord[];
const windows = [{ number: 5, start: 0, end: 6 }, { number: 6, start: 6, end: 13 }, { number: 7, start: 13, end: 24 }];

describe("which pictures a clip is sent with (the real plan)", () => {
  const plan = { characters, environments: run.environments, scenes: briefs } as never;
  const script = { scenes: run.scenes, voices: run.voices } as never;
  it("clip 1 is sent Marcus only: Dean is not in it", () => {
    expect(continuityFor(plan, script, { sceneNumbers: [1, 2, 3, 4] }, undefined).characterIds).toEqual(["marcus"]);
  });
  it("clip 2 is sent both", () => {
    expect(continuityFor(plan, script, { sceneNumbers: [5, 6, 7] }, { sceneNumbers: [1, 2, 3, 4] }).characterIds.sort()).toEqual(["dean", "marcus"]);
  });
});

describe("a phrase said twice is caught", () => {
  const out = compareSpokenToExpected([speechOf(5), speechOf(6), speechOf(7)], words, windows);
  it("finds 'is bleeding spend' said twice in scene 7", () => {
    const f = out.findings.find((x) => x.code === "speech_repeated_words");
    expect(f).toBeTruthy();
    expect(f).toMatchObject({ severity: "major", category: "speech", source: "asr" });
    expect(f!.message).toMatch(/Scene 7/);
    expect(f!.evidence).toMatch(/bleeding spend/i);
    expect(f!.correction).toMatch(/exactly once/i);
  });
  it("fails that scene's check", () => {
    expect(out.checks.find((c) => c.name === "speech_scene_7")!.ok).toBe(false);
  });
  it("does not flag a line that really repeats a phrase", () => {
    const line: SpeechLine = { sceneNumber: 1, display: "No, no, no way.", spoken: "No, no, no way.", segments: [], uncertain: [] };
    const heard = "No no no way".split(" ").map((w, i) => ({ word: w, start: i * 0.4, end: i * 0.4 + 0.35 }));
    expect(compareSpokenToExpected([line], heard, [{ number: 1, start: 0, end: 3 }]).findings.some((f) => f.code === "speech_repeated_words")).toBe(false);
  });
  it("does not flag a clean line", () => {
    const clean = compareSpokenToExpected([speechOf(5)], words.filter((w) => w.start < 6.2), [windows[0]]);
    expect(clean.findings.some((f) => f.code === "speech_repeated_words")).toBe(false);
  });
});

describe("the brand name is said exactly", () => {
  const out = compareSpokenToExpected([speechOf(5), speechOf(6), speechOf(7)], words, windows, "English", ["Traffic Radius"]);
  it("catches 'Radio' for 'Radius' in the call to action", () => {
    const f = out.findings.find((x) => x.code === "speech_brand_misheard");
    expect(f).toBeTruthy();
    expect(f).toMatchObject({ severity: "major", category: "speech" });
    expect(f!.message).toMatch(/Scene 7/);
    expect(f!.message).toMatch(/Radius/);
    expect(f!.evidence).toMatch(/radio/i);
  });
  it("accepts it said right (scene 6)", () => {
    expect(out.findings.filter((x) => x.code === "speech_brand_misheard").every((x) => !/Scene 6/.test(x.message))).toBe(true);
  });
  it("checks nothing when no brand is given", () => {
    const none = compareSpokenToExpected([speechOf(7)], words, windows);
    expect(none.findings.some((x) => x.code === "speech_brand_misheard")).toBe(false);
  });
  it("spokenTokens still reads the line", () => {
    expect(spokenTokens("Traffic Radius")).toEqual(["traffic", "radius"]);
  });
});

describe("pointing lands on something", () => {
  it("a pointer raised and lowered at nothing is dropped from the action", () => {
    const a = liveAction(brief(7).action);
    expect(a).not.toMatch(/raising and lowering the pointer/i);
    expect(a).toMatch(/lowered|rests|at (?:his|their) side/i);
  });
  it("a tap on a named target is kept", () => {
    expect(brief(2).action).toMatch(/gestures towards a tiny green patch/);
    expect(liveAction(brief(1).action)).toMatch(/taps the center of the storm/);
  });
  it("a pointing shot says where the tip must land and that the target is in frame", () => {
    const line = pointingLine(brief(1).action)!;
    expect(line).toMatch(/tip/i);
    expect(line).toMatch(/in frame/i);
    expect(line).toMatch(/look/i);
  });
  it("a shot with no pointing says nothing", () => {
    expect(pointingLine("Marcus nods slowly, maintaining eye contact with the camera for a beat.")).toBeNull();
  });
  it("a close-up cannot show what is pointed at, so it is widened", () => {
    expect(showPointedAt("Medium close-up, eye-level", "Marcus taps the pointer against the green patch")).toMatch(/^Medium shot/);
    expect(showPointedAt("Close-up on Marcus's face", "Marcus points at the chart")).toMatch(/^Medium shot/);
  });
  it("a close-up with no pointing is left alone", () => {
    expect(showPointedAt("Close-up on Marcus's face, eye-level", "Marcus nods slowly")).toBe("Close-up on Marcus's face, eye-level");
  });
});

describe("a speaker is in frame from the first frame", () => {
  it("an entrance is taken out of the action and the camera line", () => {
    expect(presentFromFirstFrame(brief(5).camera)).not.toMatch(/\benters\b/i);
    expect(presentFromFirstFrame("Dean walks in calmly from the right edge of frame, rolls the storm map aside")).toMatch(/^Dean stands in frame, rolls/);
  });
  it("leaves other text alone", () => {
    expect(presentFromFirstFrame("Slow push-in as Marcus gestures")).toBe("Slow push-in as Marcus gestures");
  });
});

describe("the clip prompt", () => {
  const scriptScene = (n: number) => run.scenes.find((s) => s.number === n)!;
  const input = (nums: number[], over: Partial<PlannedClipPromptInput> = {}): PlannedClipPromptInput => {
    const spoken: PlannedClipPromptInput["spoken"] = {};
    for (const n of nums) {
      const s = scriptScene(n);
      if (s.line) spoken[n] = { text: s.line, speaker: "on_camera", parts: [{ voiceId: n === 5 ? "dean" : "marcus", who: n === 5 ? "Dean" : "Marcus", text: s.line, onCamera: true }] };
    }
    return {
      scenes: nums.map((n) => brief(n)),
      spoken,
      characters,
      environments: run.environments as never,
      style: run.style,
      clipNumber: 1,
      clipCount: 2,
      locale: "en-AU",
      refs: { characterIds: ["marcus"], environmentIds: [], previousFrame: false, previousVideo: false },
      corrections: [],
      nextContinues: false,
      clean: true,
      voices: [{ id: "marcus", who: "Marcus", description: "Male, mid-40s, deep baritone", videoRef: null }],
      ...over,
    };
  };
  const clip1 = buildPlannedClipPrompt(input([1, 2, 3, 4]));
  const clip2 = buildPlannedClipPrompt(input([5, 6, 7], { clipNumber: 2, refs: { characterIds: ["dean", "marcus"], environmentIds: [], previousFrame: false, previousVideo: false }, voices: [{ id: "marcus", who: "Marcus", description: "Male baritone", videoRef: null }, { id: "dean", who: "Dean", description: "Male, calm", videoRef: null }] }));

  it("clip 1 does not describe Dean, who is not in it", () => {
    expect(clip1).not.toMatch(/Person \(dean\)/);
  });
  it("a clip with two people says who is in each shot", () => {
    expect(clip2).toMatch(/Only Dean is in frame in this shot/);
    expect(clip2).toMatch(/Only Marcus is in frame in this shot/);
  });
  it("a speaking shot names the speaker as visible from its first frame", () => {
    expect(clip2).toMatch(/Dean is in frame[^.]*from the very first frame/);
  });
  it("the first shot of clip 2 no longer has Dean entering", () => {
    const shot5 = clip2.split("\n").find((l) => l.includes("Shot 5 ("))!;
    expect(shot5).not.toMatch(/\benters\b/i);
  });
  it("every line is said exactly once", () => {
    expect(clip1).toContain(SAY_ONCE_RULE);
    expect(clip2).toContain(SAY_ONCE_RULE);
  });
  it("a shot that taps the map says where the tip lands", () => {
    const shot1 = clip1.split("\n").find((l) => l.includes("Shot 1 ("))!;
    expect(shot1).toMatch(/Pointing:/);
  });
  it("shot 7 no longer raises a pointer at nothing", () => {
    const shot7 = clip2.split("\n").find((l) => l.includes("Shot 7 ("))!;
    expect(shot7).not.toMatch(/raising and lowering the pointer/i);
  });
  it("a board or chart in the shot has no markings", () => {
    expect(clip2).toMatch(/chart, map, board[^.]*no (?:lines|markings)/i);
  });
  it("is not a still action once rewritten", () => {
    expect(isStillAction(liveAction(brief(3).action))).toBe(false);
  });
  it("shot 3 is not told to stand without moving", () => {
    const shot3 = clip1.split("\n").find((l) => l.includes("Shot 3 ("))!;
    expect(shot3).not.toMatch(/without blinking or moving/i);
  });
  it("one-sided helper: nothing to say when the clip has one person", () => {
    expect(onlyInShotLine([characters[0]], [characters[0]])).toBeNull();
  });
});
