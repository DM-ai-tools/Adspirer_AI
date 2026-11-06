import { describe, expect, it } from "vitest";
import {
  buildTaskBody,
  chooseSeedanceModel,
  estimateClipUsd,
  frameSize,
  mapTask,
  splitIntoClips,
  SEEDANCE_SPECS,
} from "@/lib/video/seedance";

const scenes = (secs: number[], speech = false) => secs.map((seconds, i) => ({ number: i + 1, seconds, onCameraSpeech: speech }));

describe("frameSize and cost", () => {
  it("gives the standard 720p vertical size", () => {
    expect(frameSize("720p", "9:16")).toEqual({ width: 720, height: 1280 });
    expect(frameSize("1080p", "9:16")).toEqual({ width: 1080, height: 1920 });
  });
  it("estimates a 35s 720p vertical ad on 2.5 from the documented formula (about $8)", () => {
    expect(estimateClipUsd("seedance-2-5", "720p", "9:16", 35)).toBeCloseTo(8.09, 1);
  });
  it("is cheaper on 2.0 than 2.5 for the same clip", () => {
    expect(estimateClipUsd("seedance-2-0", "720p", "9:16", 15)).toBeLessThan(estimateClipUsd("seedance-2-5", "720p", "9:16", 15));
  });
  it("refuses a resolution a model does not offer", () => {
    expect(() => estimateClipUsd("seedance-2-0-fast", "1080p", "9:16", 10)).toThrow();
  });
});

describe("splitIntoClips", () => {
  const s = scenes([3, 5, 6, 5, 6, 4, 6]).map(({ number, seconds }) => ({ number, seconds }));
  it("uses two clips on 2.5 and three on 2.0 for a 35s ad, cutting only between scenes", () => {
    const a = splitIntoClips(s, 30);
    const b = splitIntoClips(s, 15);
    expect(a).toHaveLength(2);
    expect(b).toHaveLength(3);
    for (const clips of [a, b]) {
      expect(clips.flatMap((c) => c.sceneNumbers)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(clips.reduce((t, c) => t + c.seconds, 0)).toBe(35);
    }
    expect(b.every((c) => c.seconds <= 15 && c.seconds >= 4)).toBe(true);
  });
  it("spreads the length evenly instead of leaving a stub", () => {
    const clips = splitIntoClips(s, 15);
    expect(Math.max(...clips.map((c) => c.seconds)) - Math.min(...clips.map((c) => c.seconds))).toBeLessThanOrEqual(4);
  });
  it("keeps a short ad in one clip", () => {
    expect(splitIntoClips([{ number: 1, seconds: 6 }, { number: 2, seconds: 6 }], 15)).toHaveLength(1);
  });
  it("says so when one scene is too long for the model", () => {
    expect(() => splitIntoClips([{ number: 1, seconds: 20 }], 15)).toThrow(/longer than 15s/);
  });
});

describe("chooseSeedanceModel", () => {
  it("picks 2.5 when a person speaks to camera for much of the ad", () => {
    const c = chooseSeedanceModel({ scenes: scenes([5, 7, 8, 8, 7], true), imageRefs: 2 });
    expect(c.model).toBe("seedance-2-5");
    expect(c.reasons.join(" ")).toMatch(/speaks on camera/);
    expect(c.clips).toHaveLength(2);
  });
  it("picks the cheaper 2.0 for voiceover over varied shots", () => {
    const c = chooseSeedanceModel({ scenes: scenes([4, 5, 6, 5, 5, 5, 5]), imageRefs: 2 });
    expect(c.model).toBe("seedance-2-0");
    expect(c.clips).toHaveLength(3);
  });
  it("picks 2.5 for a scene past 15s or many references", () => {
    expect(chooseSeedanceModel({ scenes: scenes([18, 8, 8]), imageRefs: 1 }).model).toBe("seedance-2-5");
    expect(chooseSeedanceModel({ scenes: scenes([5, 5, 5, 5, 5, 5]), imageRefs: 12 }).model).toBe("seedance-2-5");
  });
  it("honours a quality preference and falls back to a resolution the model offers", () => {
    const c = chooseSeedanceModel({ scenes: scenes([5, 5, 5, 5, 5, 5]), imageRefs: 1, priority: "quality" });
    expect(c.model).toBe("seedance-2-5");
    const cheap = chooseSeedanceModel({ scenes: scenes([5, 5, 5, 5, 5]), imageRefs: 1, priority: "cost", resolution: "1080p" });
    expect(SEEDANCE_SPECS[cheap.model].resolutions).toContain(cheap.resolution);
  });
});

describe("request body", () => {
  const text = { type: "text" as const, text: "hi" };
  it("carries the documented fields, asks for the last frame and no watermark", () => {
    const body = buildTaskBody({ model: "seedance-2-5", content: [text], seconds: 18, ratio: "9:16", resolution: "720p" });
    expect(body).toMatchObject({ model: "dreamina-seedance-2-5-260628", duration: 18, ratio: "9:16", resolution: "720p", generate_audio: true, return_last_frame: true, watermark: false });
  });
  it("uses adaptive ratio when a first frame is given, as the docs require", () => {
    const body = buildTaskBody({
      model: "seedance-2-0",
      content: [text, { type: "image_url", image_url: { url: "https://x/y.png" }, role: "first_frame" }],
      seconds: 10,
      ratio: "9:16",
      resolution: "720p",
    });
    expect(body.ratio).toBe("adaptive");
  });
  it("rejects a clip length or reference count the model cannot do", () => {
    expect(() => buildTaskBody({ model: "seedance-2-0", content: [text], seconds: 20, ratio: "9:16", resolution: "720p" })).toThrow(/4-15s/);
    const refs = Array.from({ length: 10 }, () => ({ type: "image_url" as const, image_url: { url: "https://x" }, role: "reference_image" as const }));
    expect(() => buildTaskBody({ model: "seedance-2-0", content: [text, ...refs], seconds: 10, ratio: "9:16", resolution: "720p" })).toThrow(/at most 9/);
  });
});

describe("mapTask", () => {
  it("reads a finished task's video, last frame and usage", () => {
    const r = mapTask({ id: "cgt-1", status: "succeeded", content: { video_url: "https://v", last_frame_url: "https://f" }, usage: { completion_tokens: 246840 } });
    expect(r).toMatchObject({ status: "succeeded", videoUrl: "https://v", lastFrameUrl: "https://f", completionTokens: 246840, error: null });
  });
  it("treats an unknown status as still running and surfaces failures", () => {
    expect(mapTask({ id: "a", status: "weird" }).status).toBe("running");
    expect(mapTask({ id: "a", status: "failed", error: { code: "X", message: "blocked" } }).error).toEqual({ code: "X", message: "blocked" });
  });
});

import { afterEach } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { arkCredentials, availableSeedanceModels } from "@/lib/video/seedance";

describe("keys and model ids per family", () => {
  const keys = ["ARK_API_KEY", "ARK_SEEDANCE_API_KEY", "ARK_SEEDANCE_25_API_KEY", "ARK_SEEDANCE_MODEL", "ARK_SEEDANCE_25_MODEL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigCache();
  });
  const set = (env: Record<string, string>) => {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    resetConfigCache();
  };

  it("uses each family's own key and the built-in verified model ids", () => {
    set({ ARK_SEEDANCE_API_KEY: "k20", ARK_SEEDANCE_25_API_KEY: "k25" });
    expect(arkCredentials("seedance-2-0")).toEqual({ apiKey: "k20", modelId: "dreamina-seedance-2-0-260128" });
    expect(arkCredentials("seedance-2-0-fast").apiKey).toBe("k20");
    expect(arkCredentials("seedance-2-5")).toEqual({ apiKey: "k25", modelId: "dreamina-seedance-2-5-260628" });
  });
  it("falls back to ARK_API_KEY, and lets the model id be overridden", () => {
    set({ ARK_API_KEY: "shared", ARK_SEEDANCE_25_MODEL: "dreamina-seedance-2-5-999999" });
    expect(arkCredentials("seedance-2-0").apiKey).toBe("shared");
    expect(arkCredentials("seedance-2-5")).toEqual({ apiKey: "shared", modelId: "dreamina-seedance-2-5-999999" });
  });
  it("only offers models that have a key", () => {
    set({ ARK_SEEDANCE_API_KEY: "k20" });
    expect(availableSeedanceModels()).not.toContain("seedance-2-5");
    expect(availableSeedanceModels()).toContain("seedance-2-0");
    expect(() => arkCredentials("seedance-2-5")).toThrow(/ARK_SEEDANCE_25_API_KEY/);
  });
});
