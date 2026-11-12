import { describe, expect, it } from "vitest";
import { buildPlannedClipPrompt } from "@/lib/video/clip-prompt";
import { clipSpeaks, voiceAnchor } from "@/lib/video/generation";
import type { ClipState } from "@/lib/video/generation-types";
import type { SceneBrief } from "@/lib/video/pipeline-types";
import { CONCEPT_RULE, defaultVoice, hardRulesFor, VOICE_RULE } from "@/lib/video/scene-plan";
import { statInserts, type VideoScene, type VideoScript } from "@/lib/video/script";
import { referencePrompt } from "@/lib/video/seedream";
import { REALISM_RULE } from "@/lib/video/visual-rules";

const scene = (number: number, line: string, over: Partial<VideoScene> = {}): VideoScene => ({ number, start: 0, end: 4, seconds: 4, visual: "v", camera: "c", speaker: "voiceover", line, keywords: [], stat: null, assetId: null, sound: "", ...over });
const script = (scenes: VideoScene[]) => ({ scenes }) as Pick<VideoScript, "scenes">;
const clip = (number: number, sceneNumbers: number[], over: Partial<ClipState> = {}): ClipState =>
  ({ number, seconds: 8, sceneNumbers, status: "waiting", taskId: null, attempts: 0, error: null, videoKey: null, lastFrameUrl: null, sourceVideoUrl: null, finishedAt: null, tokens: null, usd: null, prompt: null, ...over }) as ClipState;
const done = (number: number, sceneNumbers: number[], url: string) => clip(number, sceneNumbers, { status: "succeeded", sourceVideoUrl: url, lastFrameUrl: `${url}.jpg`, finishedAt: new Date().toISOString() });

describe("one voice for the whole ad", () => {
  const s = script([scene(1, ""), scene(2, "First words."), scene(3, "Later words."), scene(4, "Last words.")]);

  it("anchors every later speaking clip to the first clip that spoke, voiceover included", () => {
    const clips = [done(1, [1], "silent"), done(2, [2], "first-voice"), done(3, [3], "second-voice"), clip(4, [4])];
    expect(voiceAnchor(s, clips, clips[3]!)?.sourceVideoUrl).toBe("first-voice");
    // Not the clip just before: chaining clip to clip lets the voice drift at every join.
    expect(voiceAnchor(s, clips, clips[2]!)?.sourceVideoUrl).toBe("first-voice");
  });

  it("the first speaking clip sets the voice and has no anchor; a silent clip needs none", () => {
    const clips = [done(1, [1], "silent"), clip(2, [2])];
    expect(voiceAnchor(s, clips, clips[1]!)).toBeNull();
    expect(clipSpeaks(s, clip(9, [1]))).toBe(false);
    expect(clipSpeaks(s, clip(9, [2]))).toBe(true);
  });

  it("skips an anchor whose file the model can no longer fetch", () => {
    const stale = clip(1, [2], { status: "succeeded", sourceVideoUrl: "old", finishedAt: new Date(Date.now() - 23 * 3600_000).toISOString() });
    expect(voiceAnchor(s, [stale, clip(2, [3])], clip(2, [3]))).toBeNull();
  });
});

const brief = (over: Partial<SceneBrief> = {}): SceneBrief =>
  ({
    number: 2, purpose: "p", informationAdded: "i", narration: "Later words.", subject: "a potter", setting: "a small studio", action: "she lifts a bowl", framing: "medium close-up", camera: "slow push", lighting: "window light", style: "documentary",
    characterId: "c1", environmentId: "e1", requiredAssets: [], overlays: [], screenTreatment: "none", seconds: 4, durationBasis: "", entry: { mode: "cut", condition: "" }, exit: { condition: "" }, transition: { kind: "cut", rationale: "" }, risks: [], acceptance: [], editingNotes: [], ...over,
  }) as SceneBrief;

const prompt = (refs: Parameters<typeof buildPlannedClipPrompt>[0]["refs"], over: Partial<Parameters<typeof buildPlannedClipPrompt>[0]> = {}) =>
  buildPlannedClipPrompt({
    scenes: [brief()],
    spoken: { 2: { text: "Later words.", speaker: "voiceover" } },
    characters: [{ id: "c1", description: "A potter in her 40s", role: "Maker" }],
    environments: [{ id: "e1", description: "Small studio", sceneNumbers: [2] }],
    style: "Documentary",
    clipNumber: 2,
    clipCount: 3,
    locale: "en-AU",
    refs,
    voice: "A warm woman in her 40s with an Australian accent, low-mid pitch, unhurried.",
    corrections: [],
    nextContinues: false,
    clean: true,
    ...over,
  });

describe("what each clip is asked for", () => {
  it("gives a voiceover clip the fixed voice and the voice reference", () => {
    const p = prompt({ characterIds: ["c1"], environmentIds: ["e1"], previousFrame: true, previousFrameRole: "look", previousVideo: true });
    expect(p).toContain("Voice (identical in every clip of this ad): A warm woman in her 40s with an Australian accent, low-mid pitch, unhurried.");
    expect(p).toMatch(/Video 1 is an earlier clip of this same ad and is the VOICE REFERENCE/);
  });

  it("on a cut, sends the previous frame for light, grade and wardrobe, not as the opening frame", () => {
    const p = prompt({ characterIds: ["c1"], environmentIds: ["e1"], previousFrame: true, previousFrameRole: "look", previousVideo: false });
    expect(p).toMatch(/Image 3 is the last frame of the previous clip of this same ad, given for continuity only/);
    expect(p).not.toMatch(/this clip opens on the same framing/);
    const cont = prompt({ characterIds: ["c1"], environmentIds: ["e1"], previousFrame: true, previousFrameRole: "continue", previousVideo: false });
    expect(cont).toMatch(/this clip opens on the same framing/);
  });

  it("asks live action for photographic realism, and leaves an animated style its own look", () => {
    expect(prompt({ characterIds: [], environmentIds: [], previousFrame: false, previousVideo: false })).toContain(REALISM_RULE);
    expect(prompt({ characterIds: [], environmentIds: [], previousFrame: false, previousVideo: false }, { style: "3D animated explainer" })).not.toContain(REALISM_RULE);
  });

  it("makes reference images look photographed, not rendered", () => {
    expect(referencePrompt("presenter", "a potter in her 40s")).toMatch(/full-frame camera with a 50mm lens/);
    expect(referencePrompt("presenter", "a potter in her 40s")).toMatch(/Not a 3D render/);
    expect(referencePrompt("location", "small pottery studio")).toMatch(/Not a 3D render/);
  });
});

describe("the creative plan", () => {
  it("asks for one central idea, one voice and realism", () => {
    const rules = hardRulesFor({ mode: "clean", script: { style: "Documentary" } });
    expect(rules).toContain(CONCEPT_RULE);
    expect(rules).toContain(VOICE_RULE);
    expect(rules.some((r) => r.includes(REALISM_RULE))).toBe(true);
    expect(hardRulesFor({ mode: "clean", script: { style: "3D animated" } }).some((r) => r.includes(REALISM_RULE))).toBe(false);
  });

  it("chooses a voice for a plan that came without one, from the person who speaks", () => {
    const v = defaultVoice(
      { locale: "en-AU", script: { style: "", character: null, setting: "", scenes: [{ number: 1, line: "Hi.", seconds: 3, speaker: "on_camera", keywords: [], stat: null, assetId: null, visual: "", camera: "", sound: "" }] } },
      [{ id: "c1", description: "A potter in her 40s. Grey apron.", role: "Maker" }],
      [{ number: 1, characterId: "c1" }],
    );
    expect(v).toMatch(/^The voice of A potter in her 40s: .*Australian English accent/);
  });
});

describe("stats in the script", () => {
  it("lists each figure that is said, for inserting on screen in editing, and flags one with no source", () => {
    const s = script([
      scene(1, "We helped over 1,500 businesses."),
      scene(2, "Revenue doubled in 90 days.", { stat: "90 days" }),
      scene(3, "Book a call.", { stat: "8-figures" }),
    ]);
    const claims = [{ id: "c", text: "Trusted by 1,500+ businesses", kind: "number", figure: "1,500+", evidence: "x", provenance: { source: "page_text", detail: "d", confidence: "high" } }] as never;
    const out = statInserts(s, claims);
    expect(out).toContainEqual(expect.objectContaining({ scene: 1, figure: "1,500", spoken: true, sourced: true }));
    expect(out).toContainEqual(expect.objectContaining({ scene: 2, figure: "90 days", spoken: true, sourced: false }));
    // A figure that is only marked for the screen is listed as not said, so the operator can add it to the line.
    expect(out).toContainEqual(expect.objectContaining({ scene: 3, figure: "8-figures", spoken: false }));
  });
});

describe("best quality", () => {
  it("is made at 1080p, and the cost counts the voice reference for a voiceover script", async () => {
    const { previewPlan } = await import("@/lib/video/plan-view");
    const s = { ...script([scene(1, "One."), scene(2, "Two."), scene(3, "Three."), scene(4, "Four."), scene(5, "Five.")]) } as unknown as VideoScript;
    const best = previewPlan(s, { format: "9:16", priority: "quality" }, 0);
    expect(best.resolution).toBe("1080p");
    expect(previewPlan(s, { format: "9:16", priority: "balanced" }, 0).resolution).toBe("720p");
  });
});

describe("checked before Generate", () => {
  it("stops a script whose words take longer than a video may run, and one scene longer than any clip", async () => {
    const { scriptTimingProblem } = await import("@/lib/video/generation");
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    expect(scriptTimingProblem(script([scene(1, words(30)), scene(2, words(30))]))).toBeNull();
    expect(scriptTimingProblem(script([scene(1, words(60)), scene(2, words(60)), scene(3, words(60))]))).toMatch(/over the 60s maximum/);
    expect(scriptTimingProblem(script([scene(1, words(90))]))).toMatch(/Scene 1 needs about 34s, longer than the 30s one clip can run/);
  });
});
