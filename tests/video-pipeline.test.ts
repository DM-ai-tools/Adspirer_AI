import { describe, expect, it } from "vitest";
import { applyPlanDurations, brandBlockers, budgetFor, claimBlockers, continuityFor, nextCorrections, secondsToAdd, spentUsd, windowsInClip, RETRY_BUDGET_FACTOR } from "@/lib/video/pipeline";
import { refineWindows } from "@/lib/video/audio-windows";
import { endCardSecondsFor, speechLinesFor } from "@/lib/video/assemble";
import { buildPlannedClipPrompt } from "@/lib/video/clip-prompt";
import type { BrandManifest, CreativePlan, QaFinding, SceneBrief } from "@/lib/video/pipeline-types";
import type { ClipState } from "@/lib/video/generation-types";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { VideoProject } from "@/lib/video/projects";

const provenance = { source: "operator" as const, detail: "test", confidence: "high" as const };

function manifest(over: Partial<BrandManifest> = {}): BrandManifest {
  return {
    version: 1,
    createdAt: "2026-11-09T00:00:00.000Z",
    clientId: "c1",
    projectId: "vid_1",
    sourceUrl: { value: "https://acme.example", provenance: [provenance] },
    name: { value: "Acme", provenance: [provenance] },
    nameCandidates: [],
    internalLabels: [],
    logo: null,
    logoCandidates: [],
    colors: { value: ["#112233"], provenance: [provenance] },
    offer: { value: "Free audit", provenance: [provenance] },
    cta: { value: { label: "Book a free audit" }, provenance: [provenance] },
    audience: { value: "Shop owners", provenance: [provenance] },
    claims: [{ id: "claim_1", text: "$12M+ in sales generated", kind: "number", figure: "$12M+", evidence: "12 million dollars", provenance }],
    allowTextOnlyBrand: false,
    conflicts: [],
    issues: [],
    ...over,
  };
}

const brief = (number: number, over: Partial<SceneBrief> = {}): SceneBrief => ({
  number,
  purpose: "p",
  informationAdded: "i",
  narration: "n",
  subject: "s",
  setting: "set",
  action: "a",
  framing: "Medium shot",
  camera: "static",
  lighting: "soft",
  style: "doc",
  characterId: null,
  environmentId: "env_a",
  requiredAssets: [],
  overlays: [],
  screenTreatment: "none",
  seconds: 4,
  durationBasis: "speech",
  entry: { mode: "cut", condition: "" },
  exit: { condition: "" },
  transition: { kind: "cut", rationale: "" },
  risks: [],
  acceptance: [],
  ...over,
});

const plan = (scenes: SceneBrief[]): CreativePlan => ({
  version: 1,
  createdAt: "",
  basis: { product: "", audience: "", offer: "", platform: "", objective: "", targetSeconds: 30, assetIds: [] },
  narrative: { approach: "a", whyItFits: "w", arc: [] },
  characters: [{ id: "host", description: "A woman in her 40s with short grey hair", role: "the host" }],
  environments: [
    { id: "env_a", description: "A greenhouse", sceneNumbers: [1, 2] },
    { id: "env_b", description: "A loading dock", sceneNumbers: [3] },
  ],
  scenes,
  validation: { ok: true, issues: [], checkedAt: "" },
});

const scene = (number: number, seconds: number, line: string, speaker: VideoScene["speaker"] = "on_camera"): VideoScene => ({
  number, start: 0, end: 0, seconds, visual: "v", camera: "c", speaker, line, keywords: [], stat: null, assetId: null, sound: "",
});

const script = (scenes: VideoScene[], over: Partial<VideoScript> = {}): VideoScript => ({
  id: "s", title: "t", angle: { key: "k", name: "n", stage: "s", kind: "pain" }, pain: "p", framework: { key: "f", name: "f" }, style: "doc", durationSeconds: 0,
  hookAlternatives: ["a", "b", "c"], character: null, setting: "", scenes, adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Learn More" }, warnings: [], ...over,
});

const clip = (n: number, scenes: number[], over: Partial<ClipState> = {}): ClipState => ({
  number: n, seconds: 8, sceneNumbers: scenes, status: "succeeded", taskId: null, attempts: 1, error: null, videoKey: null, lastFrameUrl: null, sourceVideoUrl: null, finishedAt: null, tokens: null, usd: null, prompt: null, ...over,
});

describe("brand and claim gates", () => {
  it("blocks when the brand was never checked, and says why", () => {
    expect(brandBlockers(null)).toMatch(/not been checked/i);
  });
  it("blocks on a blocking brand issue and names it", () => {
    const m = manifest({ issues: [{ code: "name_internal", severity: "blocking", field: "name", message: "Only an internal title was found for the company name.", resolution: "Type the name." }] });
    expect(brandBlockers(m)).toContain("internal title");
    expect(brandBlockers(manifest())).toBeNull();
  });
  it("warnings alone do not block", () => {
    const m = manifest({ issues: [{ code: "colors_missing", severity: "warning", field: "colors", message: "No colours", resolution: "" }] });
    expect(brandBlockers(m)).toBeNull();
  });
  it("blocks a script that states a figure with no approved claim", () => {
    const ok = script([scene(1, 4, "We generated over 12 million dollars in sales.")]);
    const bad = script([scene(1, 4, "We generated 40 million dollars in sales.")]);
    expect(claimBlockers(ok, manifest())).toBeNull();
    expect(claimBlockers(bad, manifest())).toMatch(/no recorded source/);
  });
});

describe("what a video costs including rejected takes", () => {
  it("counts every attempt in a clip's log, not just the kept one", () => {
    const log = (usd: number) => ({ attempt: 1, taskId: null, prompt: null, corrections: [], report: null, usd, startedAt: "" });
    const clips = [clip(1, [1], { usd: 1.1, attemptLog: [log(0.9), log(1.1)] }), clip(2, [2], { usd: 0.8 })];
    expect(spentUsd(clips)).toBe(2.8);
  });
  it("sets a cap above the estimate so a retry is possible but not unlimited", () => {
    expect(budgetFor(5)).toBeCloseTo(5 * RETRY_BUDGET_FACTOR, 2);
    expect(budgetFor(5)).toBeGreaterThan(5);
  });
});

describe("continuity", () => {
  const p = plan([
    brief(1, { characterId: "host", environmentId: "env_a" }),
    brief(2, { characterId: "host", environmentId: "env_a", entry: { mode: "continue_previous", condition: "same room" } }),
    brief(3, { characterId: null, environmentId: "env_b", entry: { mode: "cut", condition: "new place" } }),
  ]);
  const s = script([scene(1, 4, "Hello there."), scene(2, 4, "More talk."), scene(3, 4, "Over the dock.", "voiceover")]);

  it("uses the previous frame only when the plan says the scene continues", () => {
    expect(continuityFor(p, s, { sceneNumbers: [2] }, { sceneNumbers: [1] }).continues).toBe(true);
    expect(continuityFor(p, s, { sceneNumbers: [3] }, { sceneNumbers: [2] }).continues).toBe(false);
  });
  it("carries the voice from the previous clip only when the same person speaks in both", () => {
    expect(continuityFor(p, s, { sceneNumbers: [2] }, { sceneNumbers: [1] }).sameSpeaker).toBe(true);
    expect(continuityFor(p, s, { sceneNumbers: [3] }, { sceneNumbers: [2] }).sameSpeaker).toBe(false);
  });
  it("asks for the people and places of the scenes in the clip, per scene, not one global setting", () => {
    const c = continuityFor(p, s, { sceneNumbers: [2, 3] }, { sceneNumbers: [1] });
    expect(c.environmentIds).toEqual(["env_a", "env_b"]);
    expect(c.characterIds).toEqual(["host"]);
  });
});

describe("plan durations and timing", () => {
  it("makes each script scene as long as the plan derived and re-lays them end to end", () => {
    const s = script([scene(1, 3, "a"), scene(2, 3, "b")]);
    const out = applyPlanDurations(s, plan([brief(1, { seconds: 5 }), brief(2, { seconds: 7 })]));
    expect(out.scenes.map((x) => [x.seconds, x.start, x.end])).toEqual([[5, 0, 5], [7, 5, 12]]);
    expect(out.durationSeconds).toBe(12);
  });
  it("scales scene windows to the clip's real length", () => {
    const w = windowsInClip([brief(1, { seconds: 4 }), brief(2, { seconds: 4 })], 8, 10);
    expect(w).toEqual([{ number: 1, start: 0, end: 5 }, { number: 2, start: 5, end: 10 }]);
  });
  it("lets the speech set the window of a scene it was located in, without overlap", () => {
    const planned = [{ number: 1, start: 0, end: 4 }, { number: 2, start: 4, end: 8 }];
    const word = (start: number, end: number) => ({ text: "w", start, end, matched: true });
    const out = refineWindows(planned, [{ sceneNumber: 1, words: [word(0.5, 3.5)], fromAudio: true }, { sceneNumber: 2, words: [word(3.4, 7)], fromAudio: true }], 8);
    expect(out[0]!.end).toBeLessThanOrEqual(out[1]!.start + 1e-9);
    expect(out[0]!.start).toBeCloseTo(0.3, 1);
    expect(out[1]!.end).toBeCloseTo(7.35, 1);
  });
  it("keeps the planned window when the speech was not located", () => {
    const planned = [{ number: 1, start: 0, end: 4 }];
    expect(refineWindows(planned, [{ sceneNumber: 1, words: [], fromAudio: false }], 4)).toEqual(planned);
  });
  it("gives the end card time to read, within the 60 second budget", () => {
    expect(endCardSecondsFor(3, 35)).toBeGreaterThanOrEqual(2.5);
    expect(endCardSecondsFor(30, 35)).toBeLessThanOrEqual(4.5);
    expect(endCardSecondsFor(10, 58.5)).toBeGreaterThanOrEqual(2);
  });
});

describe("retrying a rejected clip", () => {
  const finding = (over: Partial<QaFinding>): QaFinding => ({ code: "x", severity: "major", category: "face", message: "m", evidence: "e", correction: "Keep the face steady and unmarked.", source: "vision", ...over });
  it("adds seconds only when speech was cut off, and never past the model's limit", () => {
    const cut = [finding({ category: "speech", message: "The last words are cut off at the end of the clip." })];
    expect(secondsToAdd(cut, { seconds: 8 }, "seedance-2-0")).toBeGreaterThan(0);
    expect(secondsToAdd(cut, { seconds: 15 }, "seedance-2-0")).toBe(0);
    expect(secondsToAdd([finding({})], { seconds: 8 }, "seedance-2-0")).toBe(0);
  });
  it("corrects only real problems, not minor notes", () => {
    const out = nextCorrections([finding({}), finding({ severity: "minor", code: "n", correction: "Tiny note" })]);
    expect(out.join(" ")).not.toContain("Tiny note");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("the planned clip prompt", () => {
  const p = plan([
    brief(1, { characterId: "host", environmentId: "env_a", framing: "Close-up", subject: "the host", setting: "a greenhouse", action: "waters a seedling", camera: "slow push-in", lighting: "morning haze", acceptance: ["her face stays steady"] }),
    brief(2, { characterId: null, environmentId: "env_b", framing: "Wide shot", subject: "pallets", setting: "a loading dock", action: "a forklift lifts a pallet", camera: "static", lighting: "overcast", screenTreatment: "composite_verified_asset", overlays: [{ kind: "stat", text: "$12M+" }] }),
  ]);
  const base = {
    scenes: p.scenes,
    spoken: { 1: { text: "Over twelve million dollars.", speaker: "on_camera" as const } },
    characters: p.characters,
    environments: p.environments,
    style: "Documentary",
    clipNumber: 1,
    clipCount: 1,
    locale: "en-AU",
    refs: { characterIds: ["host"], environmentIds: ["env_a", "env_b"], previousFrame: false, previousVideo: false },
    corrections: [] as string[],
    nextContinues: false,
  };
  it("uses each scene's own place and action, and the speech text instead of the display text", () => {
    const text = buildPlannedClipPrompt(base);
    expect(text).toContain("a greenhouse");
    expect(text).toContain("a loading dock");
    expect(text).toContain("Over twelve million dollars.");
    expect(text).not.toContain("$12M+");
    expect(text).toContain("Image 1 is the host");
    expect(text).toContain("her face stays steady");
  });
  it("keeps a silent scene's mouth closed and leaves room for a composited graphic", () => {
    const text = buildPlannedClipPrompt(base);
    expect(text).toMatch(/No one speaks/);
    expect(text).toMatch(/graphic is added over this shot afterwards/);
  });
  it("lists the corrections for a retry", () => {
    expect(buildPlannedClipPrompt({ ...base, corrections: ["Keep the cheek clear of any marks."] })).toContain("Keep the cheek clear of any marks.");
  });
  it("never asks the model for text, logos or buttons", () => {
    expect(buildPlannedClipPrompt(base)).toMatch(/Do not draw any subtitles, captions, on-screen text/);
  });
});

describe("speech lines for captions", () => {
  it("falls back to the script's own words when no lexicon was made", () => {
    const project = { chosen_script: script([scene(1, 4, "Hello $12M+ world")]), plan: null } as unknown as VideoProject;
    const [line] = speechLinesFor(project);
    expect(line!.display).toBe("Hello $12M+ world");
    expect(line!.spoken).toBe("Hello $12M+ world");
  });
  it("uses the planned lexicon line when it still matches the script", () => {
    const planned = { sceneNumber: 1, display: "Hello $12M+ world", spoken: "Hello over twelve million dollars world", segments: [], uncertain: [] };
    const project = { chosen_script: script([scene(1, 4, "Hello $12M+ world")]), plan: { speech: { lines: [planned], lexicon: {} } } } as unknown as VideoProject;
    expect(speechLinesFor(project)[0]!.spoken).toContain("twelve million");
  });
  it("ignores a stale planned line when the script text was edited afterwards", () => {
    const planned = { sceneNumbers: 1, sceneNumber: 1, display: "Old words", spoken: "Old words", segments: [], uncertain: [] };
    const project = { chosen_script: script([scene(1, 4, "New words")]), plan: { speech: { lines: [planned], lexicon: {} } } } as unknown as VideoProject;
    expect(speechLinesFor(project)[0]!.display).toBe("New words");
  });
});
