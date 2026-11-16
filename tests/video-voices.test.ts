import { describe, expect, it } from "vitest";
import { clipVoices, voiceAnchors } from "@/lib/video/generation";
import { buildPlannedClipPrompt, type PlannedClipPromptInput } from "@/lib/video/clip-prompt";
import { visionRubric } from "@/lib/video/clip-qa";
import type { ClipState } from "@/lib/video/generation-types";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { SceneBrief } from "@/lib/video/pipeline-types";

const scene = (n: number, lines: VideoScene["lines"]): VideoScene => ({
  number: n,
  start: 0,
  end: 4,
  seconds: 4,
  visual: "v",
  camera: "c",
  speaker: lines!.length ? (lines!.some((l) => l.onCamera) ? "on_camera" : "voiceover") : "none",
  line: lines!.map((l) => l.text).join(" "),
  keywords: [],
  stat: null,
  assetId: null,
  sound: "",
  lines,
});

const voices = [
  { id: "narrator", who: "the narrator", description: "gravelly trailer voice" },
  { id: "maya", who: "Maya", description: "calm Australian woman, 40s" },
];

const twoVoice = (scenes: VideoScene[]) => ({ scenes, voices }) as Pick<VideoScript, "scenes" | "voices">;

const finished = Date.parse("2026-11-16T00:00:00Z");
const clip = (number: number, sceneNumbers: number[], done = true): ClipState =>
  ({
    number,
    seconds: 4,
    sceneNumbers,
    status: done ? "succeeded" : "waiting",
    taskId: null,
    attempts: 1,
    error: null,
    videoKey: done ? `k${number}` : null,
    lastFrameUrl: null,
    sourceVideoUrl: done ? `https://video/${number}.mp4` : null,
    finishedAt: done ? new Date(finished).toISOString() : null,
    tokens: null,
    usd: null,
    prompt: null,
  }) as ClipState;

const now = finished + 60_000;

describe("one voice reference per speaker", () => {
  it("anchors each voice to the first clip where it spoke alone", () => {
    const script = twoVoice([
      scene(1, [{ voiceId: "narrator", text: "Every job needs a plan.", onCamera: false }]),
      scene(2, [{ voiceId: "maya", text: "Not on my roof.", onCamera: true }]),
      scene(3, [
        { voiceId: "maya", text: "Found you.", onCamera: true },
        { voiceId: "narrator", text: "Book online.", onCamera: false },
      ]),
    ]);
    const clips = [clip(1, [1]), clip(2, [2]), clip(3, [3], false)];
    expect([...clipVoices(script, clips[2]!)].sort()).toEqual(["maya", "narrator"]);
    const anchors = voiceAnchors(script, clips, clips[2]!, now);
    expect(anchors.narrator?.number).toBe(1);
    expect(anchors.maya?.number).toBe(2);
  });

  it("never anchors a voice to a clip where another voice also spoke", () => {
    const script = twoVoice([
      scene(1, [
        { voiceId: "maya", text: "Hi.", onCamera: true },
        { voiceId: "narrator", text: "Meet Maya.", onCamera: false },
      ]),
      scene(2, [{ voiceId: "narrator", text: "She finds what hail hides.", onCamera: false }]),
    ]);
    const clips = [clip(1, [1]), clip(2, [2], false)];
    expect(voiceAnchors(script, clips, clips[1]!, now)).toEqual({});
  });

  it("ignores clips that are not finished or whose file can no longer be fetched", () => {
    const script = twoVoice([scene(1, [{ voiceId: "narrator", text: "One.", onCamera: false }]), scene(2, [{ voiceId: "narrator", text: "Two.", onCamera: false }])]);
    const clips = [clip(1, [1]), clip(2, [2], false)];
    expect(voiceAnchors(script, clips, clips[1]!, finished + 3 * 24 * 3600_000)).toEqual({});
  });
});

const brief = (n: number): SceneBrief =>
  ({
    number: n,
    purpose: "p",
    informationAdded: "i",
    narration: "",
    subject: "the inspector",
    setting: "a roof",
    action: "shines a torch",
    framing: "medium",
    camera: "handheld",
    lighting: "night",
    style: "heist",
    characterId: "maya",
    environmentId: "roof",
    requiredAssets: [],
    overlays: [],
    screenTreatment: "none",
    seconds: 4,
    durationBasis: "",
    entry: { mode: "cut", condition: "" },
    exit: { condition: "" },
    transition: { kind: "cut", rationale: "" },
    risks: [],
    acceptance: [],
    editingNotes: [],
  }) as unknown as SceneBrief;

const promptInput = (over: Partial<PlannedClipPromptInput> = {}): PlannedClipPromptInput => ({
  scenes: [brief(3)],
  spoken: {
    3: {
      text: "Found you. Book online.",
      speaker: "on_camera",
      parts: [
        { voiceId: "maya", who: "Maya", text: "Found you.", onCamera: true },
        { voiceId: "narrator", who: "the narrator", text: "Book online.", onCamera: false },
      ],
    },
  },
  characters: [{ id: "maya", role: "the inspector", description: "a woman in her 40s in a hi-vis jacket" } as never],
  environments: [],
  style: "Cinematic heist",
  clipNumber: 3,
  clipCount: 3,
  locale: "en-AU",
  refs: { characterIds: [], environmentIds: [], previousFrame: false, previousVideo: false },
  voices: [
    { id: "narrator", who: "the narrator", description: "gravelly trailer voice", videoRef: 1 },
    { id: "maya", who: "Maya", description: "calm Australian woman, 40s", videoRef: 2 },
  ],
  corrections: [],
  nextContinues: false,
  clean: true,
  ...over,
});

describe("the clip prompt with several voices", () => {
  it("names whose voice each reference video is, and who says each line", () => {
    const p = buildPlannedClipPrompt(promptInput());
    expect(p).toContain("Video 1 is the VOICE REFERENCE for the narrator");
    expect(p).toContain("Video 2 is the VOICE REFERENCE for Maya");
    expect(p).toMatch(/Maya, on camera, says: "Found you\."/);
    expect(p).toMatch(/the narrator, off camera, says: "Book online\."/);
    expect(p).toContain("gravelly trailer voice");
    expect(p).not.toContain("The same single voice speaks every line");
  });

  it("describes a voice in words only when it has no reference yet", () => {
    const p = buildPlannedClipPrompt(
      promptInput({
        voices: [
          { id: "narrator", who: "the narrator", description: "gravelly trailer voice", videoRef: 1 },
          { id: "maya", who: "Maya", description: "calm Australian woman, 40s", videoRef: null },
        ],
      }),
    );
    expect(p).toContain("Video 1 is the VOICE REFERENCE for the narrator");
    expect(p).not.toContain("Video 2");
    expect(p).toContain("calm Australian woman, 40s");
  });
});

describe("the clip check with several voices", () => {
  it("tells the inspector who should be seen speaking", () => {
    const r = visionRubric({ scenes: [brief(3)], characterDescription: null, expectsSpeech: true, allowedText: [], speakers: ["Scene 3: Maya, on camera, says \"Found you.\"", "Scene 3: the narrator, off camera, says \"Book online.\""] });
    expect(r).toContain("Maya, on camera");
    expect(r).toMatch(/off camera/);
    expect(r).toMatch(/mouth/);
  });
});

describe("the plan with several voices", () => {
  it("asks for one fixed voice per speaker instead of one voice for the whole ad", async () => {
    const { hardRulesFor, VOICE_RULE } = await import("@/lib/video/scene-plan");
    const several = hardRulesFor({ mode: "clean", script: { style: "Cinematic heist", voices } });
    expect(several.join(" ")).toMatch(/several speaking voices/);
    expect(several).not.toContain(VOICE_RULE);
    expect(hardRulesFor({ mode: "clean", script: { style: "Cinematic heist" } })).toContain(VOICE_RULE);
  });
});
