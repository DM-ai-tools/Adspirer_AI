import { describe, expect, it } from "vitest";
import { buildClipPrompt, buildPlannedClipPrompt, type PlannedClipPromptInput } from "@/lib/video/clip-prompt";
import { isStillAction, liveCamera, MOTION_RULE, STATIC_CAMERA } from "@/lib/video/visual-rules";
import type { SceneBrief } from "@/lib/video/pipeline-types";
import type { VideoScene } from "@/lib/video/script";

// The finished clips looked like slides: the plan wrote "Static with a barely perceptible push" and "Standing
// still", and every rule the video model was given asked for calm, steady and still. Nothing asked for motion.

const MOVES = /\b(push|pull|drift|pan|tilt|track|dolly|orbit|arc|handheld|sway|crane|follow|glide|sweep)\w*/i;

describe("a camera that is written as static", () => {
  it.each([
    "Static with a barely perceptible slow push toward the key",
    "Locked-off tripod shot",
    "Static camera, no movement",
    "Handheld, static, slow drift left",
    "Fixed frame",
    "Stationary",
  ])("is made to move: %s", (camera) => {
    const out = liveCamera(camera);
    expect(out).not.toMatch(STATIC_CAMERA);
    expect(out).toMatch(MOVES);
  });

  it("leaves a camera that already moves exactly as written", () => {
    expect(liveCamera("Handheld with long-lens compression, slow push in toward his back")).toBe("Handheld with long-lens compression, slow push in toward his back");
    expect(liveCamera("Slow orbit around the product")).toBe("Slow orbit around the product");
  });

  it("gives an empty camera a move too", () => {
    expect(liveCamera("   ")).toMatch(MOVES);
  });
});

describe("an action that is written as standing still", () => {
  it.each(["Standing still, looking out of the window", "Hovering finger above the enter key", "Holds a natural, relaxed posture", "Stares at the screen", "Waits by the door"])("is recognised: %s", (action) => {
    expect(isStillAction(action)).toBe(true);
  });
  it.each(["Walks along the corridor, phone to his ear", "Lifts the mug and turns toward the window", "Opens the laptop and leans in"])("is not flagged when it moves: %s", (action) => {
    expect(isStillAction(action)).toBe(false);
  });
});

const brief = (over: Partial<SceneBrief> = {}): SceneBrief => ({
  number: 1, purpose: "p", informationAdded: "i", narration: "", subject: "the operator", setting: "an open-plan office", action: "Standing still, looking out of the window", framing: "Medium wide, slightly low angle",
  camera: "Static with a barely perceptible slow push", lighting: "Golden hour", style: "doc", characterId: "op", environmentId: "e", requiredAssets: [], overlays: [], screenTreatment: "none", seconds: 6,
  durationBasis: "", entry: { mode: "cut", condition: "" }, exit: { condition: "" }, transition: { kind: "cut", rationale: "" }, risks: [], acceptance: [], ...over,
});

const input = (scenes: SceneBrief[], over: Partial<PlannedClipPromptInput> = {}): PlannedClipPromptInput => ({
  scenes,
  spoken: { 1: { text: "Spend up three times this quarter.", speaker: "voiceover" } },
  characters: [{ id: "op", description: "A man in his 40s, dark shirt", role: "the operator" }],
  environments: [{ id: "e", description: "An open-plan office", sceneNumbers: [1] }],
  style: "Documentary",
  clipNumber: 1,
  clipCount: 1,
  locale: "en-AU",
  refs: { characterIds: ["op"], environmentIds: ["e"], previousFrame: false, previousVideo: false },
  corrections: [],
  nextContinues: false,
  clean: true,
  ...over,
});

describe("the prompt sent to the video model", () => {
  const prompt = buildPlannedClipPrompt(input([brief()]));
  const shotLine = prompt.split("\n").find((l) => l.includes("Shot 1 ("))!;

  it("never tells the model the camera is static", () => {
    expect(shotLine).not.toMatch(STATIC_CAMERA);
    expect(shotLine).toMatch(/Camera: [^.]*(push|drift|handheld)/i);
  });

  it("asks for movement in every shot, and for a camera that is never locked off", () => {
    expect(shotLine).toMatch(/Movement:/);
    expect(prompt).toContain(MOTION_RULE);
    expect(MOTION_RULE).toMatch(/never locked off/i);
  });

  it("no longer asks a person who is not speaking to hold perfectly still", () => {
    expect(prompt).not.toMatch(/closed and still/i);
    expect(shotLine).toMatch(/mouth stays closed and relaxed/i);
  });

  it("does not ask a person to 'hold a relaxed posture' when the plan gave no action", () => {
    const p = buildPlannedClipPrompt(input([brief({ action: "" })]));
    expect(p).not.toMatch(/holds a natural, relaxed posture/i);
  });

  it("describes movement of the scene when nobody is in the shot", () => {
    const p = buildPlannedClipPrompt(input([brief({ characterId: null, action: "Steam rises from a mug" })], { refs: { characterIds: [], environmentIds: ["e"], previousFrame: false, previousVideo: false } }));
    const line = p.split("\n").find((l) => l.includes("Shot 1 ("))!;
    expect(line).toMatch(/Movement: something in the frame/i);
  });

  it("is also true of a project made before creative plans existed", () => {
    const scene: VideoScene = { number: 1, start: 0, end: 6, seconds: 6, visual: "A presenter at a desk", camera: "Static", speaker: "on_camera", line: "Hello there.", keywords: [], stat: null, assetId: null, sound: "" };
    const p = buildClipPrompt({
      script: { style: "UGC", character: "A man", setting: "A desk", scenes: [scene] },
      sceneNumbers: [1], clipNumber: 1, clipCount: 1, locale: "en-AU",
      refs: { presenter: false, location: false, previousFrame: false, previousVideo: false }, graphicSceneNumbers: [],
    });
    const line = p.split("\n").find((l) => l.includes("Shot 1."))!;
    expect(line).not.toMatch(STATIC_CAMERA);
    expect(p).toContain(MOTION_RULE);
  });
});
