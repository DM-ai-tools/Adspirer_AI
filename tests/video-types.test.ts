import { describe, expect, it } from "vitest";
import { buildPlannedClipPrompt } from "@/lib/video/clip-prompt";
import { planPrompt, type PlanInput } from "@/lib/video/scene-plan";
import { classifyStyle, DYNAMIC_ACTION_RULE, SIMPLE_ACTION_RULE, wantsRealism } from "@/lib/video/visual-rules";
import { styleForType, VIDEO_TYPES, videoDirection, videoTypeOf } from "@/lib/video/video-types";

describe("the video types the operator can choose", () => {
  it("covers the formats asked for: UGC, cinematic with a presenter, pure cinematic, action trailer, storytelling and animation", () => {
    const ids = VIDEO_TYPES.map((t) => t.id);
    for (const id of ["auto", "ugc_creator", "avatar_cinematic", "cinematic_film", "action_trailer", "storytelling", "animation_3d"]) expect(ids).toContain(id);
  });

  it("each type's style leads to the right footage look", () => {
    expect(classifyStyle(styleForType("ugc_creator")!)).toBe("ugc");
    expect(classifyStyle(styleForType("action_trailer")!)).toBe("action");
    expect(classifyStyle(styleForType("animation_3d")!)).toBe("animated");
    expect(wantsRealism(styleForType("animation_3d")!)).toBe(false);
    expect(wantsRealism(styleForType("cinematic_film")!)).toBe(true);
    expect(styleForType("auto")).toBeNull();
    expect(videoTypeOf("nonsense").id).toBe("auto");
  });

  it("turns the choice and the operator's idea into one direction, and nothing when both are left empty", () => {
    expect(videoDirection({ videoType: "auto", videoIdea: "" })).toBeNull();
    const d = videoDirection({ videoType: "cinematic_film", videoIdea: "Open on a tradie stuck in traffic." })!;
    expect(d).toMatch(/Video type chosen by the operator: Cinematic brand film/);
    expect(d).toMatch(/nobody talks to camera/);
    expect(d).toMatch(/The operator's own idea for the video .*tradie stuck in traffic/);
    expect(videoDirection({ videoType: "auto", videoIdea: "Make it feel like a heist film." })).toMatch(/heist film/);
  });
});

describe("the choice reaches the planner and the video model", () => {
  const input = (direction: string | null): PlanInput =>
    ({
      brandName: "Acme", product: "p", audience: "a", offer: "o", platform: "Reels", objective: "x", targetSeconds: 30, locale: "en-AU", maxSeconds: 60, mode: "clean", direction,
      script: { style: "Cinematic", character: null, setting: "s", scenes: [{ number: 1, line: "Hi.", seconds: 3, speaker: "voiceover", keywords: [], stat: null, assetId: null, visual: "v", camera: "c", sound: "" }] },
      assets: [], claims: [], capabilities: { referenceImages: true, firstLastFrame: true, nativeAudio: true, lipSync: "model", perspectiveScreenTracking: false, gaps: [] },
    }) as unknown as PlanInput;

  it("the planner is told the kind of video asked for", () => {
    expect(planPrompt(input(videoDirection({ videoType: "action_trailer" })))).toMatch(/THE KIND OF VIDEO THE OPERATOR ASKED FOR[\s\S]*Action \/ trailer sequence/);
    expect(planPrompt(input(null))).not.toMatch(/THE KIND OF VIDEO THE OPERATOR ASKED FOR/);
  });

  it("an action trailer gets energetic camera rules; everything else stays calm", () => {
    const base = {
      scenes: [{ number: 1, purpose: "", informationAdded: "", narration: "", subject: "a runner", setting: "a street", action: "sprints", framing: "low angle", camera: "tracking", lighting: "low sun", style: "", characterId: null, environmentId: "e", requiredAssets: [], overlays: [], screenTreatment: "none", seconds: 4, durationBasis: "", entry: { mode: "cut", condition: "" }, exit: { condition: "" }, transition: { kind: "cut", rationale: "" }, risks: [], acceptance: [], editingNotes: [] }],
      spoken: {}, characters: [], environments: [], clipNumber: 1, clipCount: 1, locale: "en-AU", refs: { characterIds: [], environmentIds: [], previousFrame: false, previousVideo: false }, corrections: [], nextContinues: false, clean: true,
    } as unknown as Parameters<typeof buildPlannedClipPrompt>[0];
    expect(buildPlannedClipPrompt({ ...base, style: styleForType("action_trailer")! })).toContain(DYNAMIC_ACTION_RULE);
    expect(buildPlannedClipPrompt({ ...base, style: styleForType("ugc_creator")! })).toContain(SIMPLE_ACTION_RULE);
  });
});
