import { describe, expect, it } from "vitest";
import { confirmPatch, freshScriptsPatch, generationFiles, staleGenerationPatch } from "@/lib/video/script-actions";
import type { ClipState } from "@/lib/video/generation-types";
import type { VideoProject } from "@/lib/video/projects";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import { retime } from "@/lib/video/timing";

// "The Translator" was made (clip 1 done, clip 2 failed). The operator rewrote the scripts, picked "The Weather
// Forecast" and confirmed it. The project then held the new script with the OLD plan (6 Translator scenes) and the
// OLD clips, so the page kept showing "Making the video: 1 of 2 clips done" for a script that had not been made.

const scene = (n: number, line: string): VideoScene => ({ number: n, start: 0, end: 0, seconds: 0, visual: `visual ${n}`, camera: "c", speaker: line ? "voiceover" : "none", line, keywords: [], stat: null, assetId: null, sound: "" });
const scriptOf = (id: string, title: string): VideoScript => {
  const timed = retime([scene(1, "Your Google ad account is generating a significant weather event."), scene(2, "Book a free strategy call today.")]);
  return { id, title, angle: { key: "a", name: "a", stage: "", kind: "custom" }, pain: "", framework: { key: "custom", name: "" }, style: "s", durationSeconds: timed.at(-1)!.end, hookAlternatives: [], character: null, setting: "s", scenes: timed, adCopy: { primaryText: "p", headline: "h", description: "d", cta: "Learn More" }, warnings: [] } as VideoScript;
};
const clip = (over: Partial<ClipState> = {}): ClipState => ({ number: 1, seconds: 17, sceneNumbers: [1, 2, 3], status: "succeeded", taskId: "t", attempts: 1, error: null, videoKey: "video/p/clip-1.mp4", lastFrameUrl: "u", sourceVideoUrl: "v", finishedAt: "x", tokens: 1, usd: 9.69, prompt: "old prompt", ...over });

const oldVideo = {
  plan: { model: "seedance-2-5", creative: { scenes: [{ number: 1 }] } } as never,
  clips: [clip(), clip({ number: 2, status: "failed", videoKey: "video/p/clip-2.mp4" })],
  final: null,
};
const project = (over: Partial<VideoProject> = {}): VideoProject =>
  ({ id: "p", client_id: "c", status: "scripts_ready", inputs: { stats: [], targetSeconds: 30, locale: "en-AU" }, assets: [], brand: null, scripts: [scriptOf("weather", "The Weather Forecast")], chosen_script: null, ...oldVideo, error: null, ...over }) as unknown as VideoProject;

describe("confirming a new script", () => {
  it("drops the plan, clips and finished video that were made for the old script", () => {
    const s = scriptOf("weather", "The Weather Forecast");
    const patch = confirmPatch(project(), { scriptId: "weather", edits: { title: s.title, scenes: s.scenes, adCopy: s.adCopy } });
    expect(patch.status).toBe("confirmed");
    expect(patch.chosen_script?.title).toBe("The Weather Forecast");
    expect(patch).toMatchObject({ plan: null, clips: null, final: null });
  });

  it("adds nothing when there was no video before", () => {
    const s = scriptOf("weather", "The Weather Forecast");
    const patch = confirmPatch(project({ plan: null, clips: null, final: null }), { scriptId: "weather", edits: { title: s.title, scenes: s.scenes, adCopy: s.adCopy } });
    expect("plan" in patch || "clips" in patch || "final" in patch).toBe(false);
  });
});

describe("writing new scripts for a video that was already made", () => {
  it("clears the old plan, clips and finished video along with the old script", () => {
    expect(freshScriptsPatch(project())).toMatchObject({ status: "writing", error: null, scripts: null, chosen_script: null, plan: null, clips: null, final: null });
  });
  it("leaves a project with no video alone", () => {
    const patch = freshScriptsPatch(project({ plan: null, clips: null, final: null }));
    expect(patch).toMatchObject({ status: "writing", scripts: null, chosen_script: null });
    expect("plan" in patch).toBe(false);
  });
});

describe("what is left in storage", () => {
  it("lists every saved clip and finished file so they can be removed with the old video", () => {
    const keys = generationFiles(project({ final: { state: "done", key: "video/p/final.mp4", reviewKey: "video/p/review.mp4", subtitles: { srtKey: "video/p/a.srt", vttKey: "video/p/a.vtt", cues: 3 } } as never }));
    expect(keys.sort()).toEqual(["video/p/a.srt", "video/p/a.vtt", "video/p/clip-1.mp4", "video/p/clip-2.mp4", "video/p/final.mp4", "video/p/review.mp4"]);
  });
  it("is empty when nothing was made", () => {
    expect(generationFiles(project({ plan: null, clips: null, final: null }))).toEqual([]);
  });
  it("staleGenerationPatch says nothing for an empty project", () => {
    expect(staleGenerationPatch(project({ plan: null, clips: null, final: null }))).toEqual({});
  });
});
