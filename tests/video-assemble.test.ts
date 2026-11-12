import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { runFfmpeg, probe, parseMediaInfo } from "@/lib/video/ffmpeg";
import { alignWords, fillGaps, matchedShare, phraseMarkup, sceneWindows, splitStat, splitWords, statWindow, toPhrases, type AsrWord } from "@/lib/video/captions";
import { accentColour, finalSize, insideSafeZone, layoutFor } from "@/lib/video/layout";
import { buildOverlayFilter, timeScene } from "@/lib/video/assemble";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { BrandManifest } from "@/lib/video/pipeline-types";

const stored = new Map<string, Buffer>();
vi.mock("@/lib/storage/r2", () => ({
  getObjectStorage: () => ({
    put: async (key: string, data: Buffer) => void stored.set(key, Buffer.from(data)),
    get: async (key: string) => stored.get(key) ?? null,
    delete: async (key: string) => void stored.delete(key),
  }),
}));

vi.mock("@/lib/video/face-bands", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/face-bands")>()),
  // The face finder calls a vision model; its own tests inject a detector.
  detectFaceBands: async () => ({ bands: [], samples: [], limitation: null }),
}));

let finalVerdict: "pass" | "critical" = "pass";
vi.mock("@/lib/video/final-qa", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/final-qa")>()),
  // The vision review is exercised in its own tests; here the assembly is shown to act on its verdict.
  reviewFinal: async () => ({
    subject: { kind: "final" as const },
    attempt: 1,
    checkedAt: new Date().toISOString(),
    verdict: finalVerdict === "pass" ? ("pass" as const) : ("unresolved" as const),
    findings: finalVerdict === "pass" ? [] : [{ code: "brand_name_wrong", severity: "critical" as const, category: "branding" as const, message: "The end card does not show the verified company name.", evidence: "read 'Whlubler'", correction: "", source: "vision" as const }],
    checks: [{ name: "Frames read for text", ok: finalVerdict === "pass", detail: "8 frames" }],
    framesInspected: 8,
    limitations: [],
  }),
}));

let asrWords: AsrWord[] | null = null;
vi.mock("@/lib/video/asr", () => ({ transcribeWords: async () => asrWords }));

describe("timing words to the voice", () => {
  const window = { start: 0, end: 6 };
  const asr: AsrWord[] = [
    { word: "I", start: 0.3, end: 0.4 },
    { word: "thought", start: 0.45, end: 0.8 },
    { word: "my", start: 0.85, end: 0.95 },
    { word: "ads", start: 1.0, end: 1.3 },
    { word: "were", start: 1.35, end: 1.5 },
    { word: "fine", start: 1.55, end: 1.9 },
  ];
  it("gives each script word the time it was said, keeping the script's own spelling", () => {
    const out = alignWords(splitWords("I thought my ads were fine."), asr, window);
    expect(out.map((w) => w.text)).toEqual(["I", "thought", "my", "ads", "were", "fine."]);
    expect(out[3]!.start).toBeCloseTo(1.0, 1);
    expect(matchedShare(out)).toBe(1);
  });
  it("copes with a word the transcript heard differently, spreading it between its neighbours", () => {
    const heard = asr.map((w) => (w.word === "ads" ? { ...w, word: "adds-up" } : w));
    const out = alignWords(splitWords("I thought my ads were fine."), heard, window);
    expect(out[3]!.matched).toBe(false);
    expect(out[3]!.start).toBeGreaterThanOrEqual(out[2]!.end - 0.05);
    expect(out[3]!.start).toBeLessThanOrEqual(out[4]!.start);
  });
  it("falls back to even spacing inside the scene when there is no usable transcript", () => {
    const { words, fromTranscript } = timeScene("one two three four five six", null, { start: 10, end: 16 });
    expect(fromTranscript).toBe(false);
    expect(words[0]!.start).toBeGreaterThanOrEqual(10.1);
    expect(words[5]!.end).toBeLessThanOrEqual(16.4);
    expect(words.map((w) => w.start)).toEqual([...words.map((w) => w.start)].sort((a, b) => a - b));
    // a transcript of something else entirely is not trusted either
    expect(timeScene("one two three four", [{ word: "banana", start: 11, end: 12 }], { start: 10, end: 16 }).fromTranscript).toBe(false);
  });
  it("breaks a line into short phrases that each stay up until the next", () => {
    const words = fillGaps(splitWords("Honestly, I had no idea where half my budget was going.").map((text) => ({ text, start: NaN, end: NaN, matched: false })), { start: 0, end: 6 });
    const phrases = toPhrases(words);
    expect(phrases.every((p) => p.words.length <= 4)).toBe(true);
    expect(phrases[0]!.words.map((w) => w.text)).toEqual(["Honestly,"]);
    for (let i = 0; i < phrases.length - 1; i += 1) expect(phrases[i]!.end).toBeLessThanOrEqual(phrases[i + 1]!.start + 0.001);
  });
  it("colours the highlighted words and escapes everything else", () => {
    const [p] = toPhrases(fillGaps(splitWords("Free audit & <more>").map((text) => ({ text, start: NaN, end: NaN, matched: false })), { start: 0, end: 3 }), 6);
    const markup = phraseMarkup(p!, ["free audit"], "#37CA37");
    expect(markup).toContain('foreground="#37CA37">Free');
    expect(markup).toContain('foreground="#37CA37">audit');
    expect(markup).toContain("&amp;");
    expect(markup).toContain("&lt;more&gt;");
  });
});

describe("where scenes fall in the finished video", () => {
  it("stretches a scene to the clip it is in when the clip came back a little longer or shorter", () => {
    const scenes = [
      { number: 1, start: 0, end: 4 },
      { number: 2, start: 4, end: 10 },
      { number: 3, start: 10, end: 20 },
    ];
    const w = sceneWindows(scenes, [
      { sceneNumbers: [1, 2], plannedSeconds: 10, actualSeconds: 11 },
      { sceneNumbers: [3], plannedSeconds: 10, actualSeconds: 9 },
    ]);
    expect(w[0]).toEqual({ number: 1, start: 0, end: 4.4 });
    expect(w[1]!.end).toBeCloseTo(11, 5);
    expect(w[2]).toEqual({ number: 3, start: 11, end: 20 });
  });
  it("splits a stat into a big value and a small label, and times it to when it is said", () => {
    expect(splitStat("255% avg client ROI")).toEqual({ value: "255%", label: "avg client ROI" });
    expect(splitStat("$120M+ revenue tracked")).toEqual({ value: "$120M+", label: "revenue tracked" });
    expect(splitStat("Google Premier Partner")).toEqual({ value: "Google Premier Partner", label: "" });
    const words = fillGaps(splitWords("clients see 255% average ROI").map((text) => ({ text, start: NaN, end: NaN, matched: false })), { start: 10, end: 16 });
    const w = statWindow({ number: 3, start: 10, end: 16 }, words, "255%");
    expect(w.start).toBeGreaterThanOrEqual(10.1);
    expect(w.end).toBeLessThanOrEqual(16);
    expect(w.end - w.start).toBeGreaterThanOrEqual(2.4);
  });
});

describe("layout", () => {
  it("keeps captions, stats and images out of the bands Reels and Stories cover", () => {
    const l = layoutFor("9:16");
    expect(insideSafeZone(l, l.captionY, 0.08)).toBe(true);
    expect(insideSafeZone(l, l.statY, 0.1)).toBe(true);
    expect(insideSafeZone(l, l.imageY, l.imageMaxH)).toBe(true);
    expect(l.logo.y).toBeGreaterThanOrEqual(l.safe.top);
  });
  it("sizes each format and picks a readable accent", () => {
    expect(finalSize("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(finalSize("4:5")).toEqual({ width: 1080, height: 1350 });
    expect(accentColour(["#101010", "#37ca37"])).toBe("#37CA37");
    expect(accentColour(["#fafafa"])).toBe("#FFD84D");
  });
  it("builds one overlay per graphic, each shown only in its own time window, and levels the sound", () => {
    const f = buildOverlayFilter([
      { x: 10, y: 20, start: 0, end: 5 },
      { x: 30, y: 40, start: 1.5, end: 3 },
    ]);
    expect(f).toContain("[0:v][1:v]overlay=x=10:y=20:format=auto:enable='between(t,0.00,5.00)'[v1]");
    expect(f).toContain("[v1][2:v]overlay=x=30:y=40:format=auto:enable='between(t,1.50,3.00)'[vout]");
    expect(f).toContain("loudnorm");
  });
});

describe("reading ffmpeg's report", () => {
  it("gets length, size and whether there is sound", () => {
    const report = "  Duration: 00:00:36.50, start: 0.000000, bitrate: 5000 kb/s\n  Stream #0:0: Video: h264 (High), yuv420p, 1080x1920, 5000 kb/s, 30 fps, 30 tbr\n  Stream #0:1: Audio: aac, 48000 Hz, stereo";
    expect(parseMediaInfo(report)).toEqual({ seconds: 36.5, width: 1080, height: 1920, fps: 30, hasAudio: true });
  });
});

// Real ffmpeg, real sharp: two small test clips are joined and finished.
describe("assembling a video (real ffmpeg)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "video-test-"));
    for (const n of [1, 2]) {
      const f = path.join(dir, `c${n}.mp4`);
      await runFfmpeg(["-f", "lavfi", "-i", "testsrc2=size=720x1280:rate=24", "-f", "lavfi", "-i", `sine=frequency=${n === 1 ? 300 : 500}:sample_rate=44100`, "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", f]);
      stored.set(`video/p/clip-${n}.mp4`, await readFile(f));
    }
    stored.set("video/p/brand/logo.png", await sharp({ create: { width: 400, height: 120, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer());
    stored.set("video/p/img_1.png", await sharp({ create: { width: 800, height: 500, channels: 3, background: "#1d4ed8" } }).png().toBuffer());
  }, 60_000);

  const scene = (number: number, start: number, seconds: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({
    number, start, end: start + seconds, seconds, visual: "v", camera: "c", speaker: "on_camera", line, keywords: [], stat: null, assetId: null, sound: "s", ...extra,
  });

  const prov = { source: "operator" as const, detail: "test", confidence: "high" as const };
  const manifestFor = (over: { logo?: boolean; issues?: BrandManifest["issues"]; claims?: BrandManifest["claims"] } = {}): BrandManifest => ({
    version: 1,
    createdAt: new Date().toISOString(),
    clientId: "c1",
    projectId: "p",
    sourceUrl: { value: "https://acme.example", provenance: [prov] },
    name: { value: "Acme", provenance: [prov] },
    nameCandidates: [],
    internalLabels: [{ value: "TR Internal Marketing Version 1", provenance: { ...prov, source: "internal" as const } }],
    logo: over.logo === false ? null : { storageKey: "video/p/brand/logo.png", mime: "image/png", sourceUrl: "https://acme.example/logo.png", origin: "page", verification: { ok: true, format: "png", width: 400, height: 120, hasAlpha: true, transparentShare: 0.5, luminance: 20, legibleOnLight: true, legibleOnDark: false, problems: [] }, provenance: [prov] },
    logoCandidates: [],
    colors: { value: ["#101820", "#37ca37"], provenance: [prov] },
    offer: { value: "Free ad audit", provenance: [prov] },
    cta: { value: { label: "Book a free audit", url: "https://acme.example/audit" }, provenance: [prov] },
    audience: { value: null, provenance: [] },
    claims: over.claims ?? [{ id: "claim_1", text: "255% avg client ROI", kind: "number", figure: "255%", evidence: "255% avg client ROI", provenance: prov }],
    allowTextOnlyBrand: false,
    conflicts: [],
    issues: over.issues ?? [],
  });

  async function project(overrides: { logo?: boolean; issues?: BrandManifest["issues"]; claims?: BrandManifest["claims"] } = {}) {
    const { createProject, updateProject } = await import("@/lib/video/projects");
    const p = await createProject({ clientId: "c1", inputs: { landingPageUrl: "https://a.test", stats: [], targetSeconds: 12, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" } });
    const script: VideoScript = {
      id: "s", title: "t", angle: { key: "k", name: "A", stage: "S", kind: "pain" }, pain: "p", framework: { key: "f", name: "F" }, style: "UGC", durationSeconds: 12, hookAlternatives: ["a", "b", "c"], character: null, setting: "s",
      scenes: [
        scene(1, 0, 3, "I thought my ads were fine.", { keywords: ["ads"] }),
        scene(2, 3, 3, "Then we ran a free audit.", { stat: "255% avg client ROI", assetId: "img_1" }),
        scene(3, 6, 3, "It showed every single leak."),
        scene(4, 9, 3, "So give it a go."),
      ],
      adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Learn More" }, warnings: [],
    };
    await updateProject(p.id, {
      chosen_script: script,
      status: "clips_ready",
      assets: [{ id: "img_1", name: "results.png", caption: "", role: "highlight", key: "video/p/img_1.png", mime: "image/png" }],
      brand: { name: "Acme", colors: ["#101820", "#37ca37"], logoUrl: null, summary: null, manifest: manifestFor(overrides) },
      plan: { model: "seedance-2-0", modelLabel: "x", resolution: "720p", ratio: "9:16", format: "9:16", reasons: [], estimatedUsd: 1, character: null, setting: null, chainVideo: false, finishing: { mode: "branded" as const, captions: true, logo: true, endCard: true }, checkpoint: "none" as const, createdAt: new Date().toISOString() },
      clips: [1, 2].map((n) => ({ number: n, seconds: 6, sceneNumbers: n === 1 ? [1, 2] : [3, 4], status: "succeeded" as const, taskId: null, attempts: 1, error: null, videoKey: `video/p/clip-${n}.mp4`, lastFrameUrl: null, sourceVideoUrl: null, finishedAt: new Date().toISOString(), tokens: 1, usd: 1, prompt: null })),
    });
    return p.id;
  }

  it("joins the clips into one 1080x1920 video with captions, a stat, the image, the logo and an end card, and passes its own checks", async () => {
    asrWords = [
      { word: "I", start: 0.2, end: 0.3 }, { word: "thought", start: 0.35, end: 0.7 }, { word: "my", start: 0.75, end: 0.85 }, { word: "ads", start: 0.9, end: 1.2 }, { word: "were", start: 1.25, end: 1.4 }, { word: "fine", start: 1.45, end: 1.8 },
    ];
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const id = await project();
    await assembleVideo(id);
    const p = (await getProject(id))!;
    expect(p.final?.error).toBeNull();
    expect(p.status).toBe("done");
    expect(p.final!.state).toBe("done");
    expect([p.final!.width, p.final!.height]).toEqual([1080, 1920]);
    // two 6s clips plus an end card long enough to read
    expect(p.final!.seconds).toBeGreaterThan(14.4);
    expect(p.final!.seconds).toBeLessThan(17);
    expect(p.final!.brand).toEqual({ name: "Acme", logo: true, textOnly: false });
    expect(p.final!.qa.filter((c) => !c.ok)).toEqual([]);
    expect(p.final!.includes).toMatchObject({ captions: true, logo: true, endCard: true, stats: 1, images: 1 });

    const file = path.join(dir, "final.mp4");
    await writeFile(file, stored.get(p.final!.key!)!);
    expect((await probe(file)).hasAudio).toBe(true);
    // A frame while the stat, image, logo and a caption are on screen, for a look.
    if (process.env.VIDEO_DEBUG_DIR) {
      await runFfmpeg(["-ss", "4", "-i", file, "-frames:v", "1", path.join(process.env.VIDEO_DEBUG_DIR, "frame-stat.png")]);
      await runFfmpeg(["-ss", "1", "-i", file, "-frames:v", "1", path.join(process.env.VIDEO_DEBUG_DIR, "frame-caption.png")]);
      await runFfmpeg(["-ss", "13.2", "-i", file, "-frames:v", "1", path.join(process.env.VIDEO_DEBUG_DIR, "frame-end.png")]);
    }
  }, 120_000);

  it("makes subtitle files from the same cues as the burned-in captions, with the display text intact", async () => {
    asrWords = null;
    finalVerdict = "pass";
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const id = await project();
    await assembleVideo(id);
    const p = (await getProject(id))!;
    expect(p.final!.subtitles?.cues).toBeGreaterThan(0);
    const srt = stored.get(p.final!.subtitles!.srtKey)!.toString("utf8");
    const vtt = stored.get(p.final!.subtitles!.vttKey)!.toString("utf8");
    expect(srt).toMatch(/^1\r?\n\d\d:\d\d:\d\d,\d{3} --> /);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(srt).toContain("ads");
  }, 120_000);

  it("blocks delivery when the inspection finds a critical problem, keeping the file only for review", async () => {
    asrWords = null;
    finalVerdict = "critical";
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const id = await project();
    await assembleVideo(id);
    finalVerdict = "pass";
    const p = (await getProject(id))!;
    expect(p.final!.state).toBe("blocked");
    expect(p.final!.key).toBeNull();
    expect(p.final!.reviewKey).toBeTruthy();
    expect(p.final!.error).toMatch(/Not approved for delivery.*verified company name/);
    expect(p.status).toBe("clips_ready");
    const { viewGeneration } = await import("@/lib/video/generation");
    const view = viewGeneration(p);
    expect(view.final!.videoUrl).toBeNull();
    expect(view.final!.reviewUrl).toContain("review=1");
  }, 120_000);

  it("refuses to render anything when the brand is not verified", async () => {
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const id = await project({ issues: [{ code: "name_internal", severity: "blocking", field: "name", message: "Only an internal title was found for the company name.", resolution: "Type the name." }] });
    await assembleVideo(id);
    const p = (await getProject(id))!;
    expect(p.final!.state).toBe("failed");
    expect(p.final!.error).toMatch(/internal title/);
    expect(p.final!.key).toBeNull();
  }, 60_000);

  it("does not draw a figure on screen that has no recorded source, and still makes the video", async () => {
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const id = await project({ claims: [] });
    await assembleVideo(id);
    const p = (await getProject(id))!;
    expect(p.final!.error ?? "").not.toMatch(/no recorded source/);
    expect(p.final!.state).toBe("done");
  }, 60_000);

  it("without captions or an end card it is just the joined clips with the logo", async () => {
    asrWords = null;
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const id = await project();
    await assembleVideo(id, { captions: false, endCard: false });
    const p = (await getProject(id))!;
    expect(p.final!.state).toBe("done");
    expect(p.final!.seconds).toBeGreaterThan(11.5);
    expect(p.final!.seconds).toBeLessThan(12.6);
    expect(p.final!.includes).toMatchObject({ captions: false, endCard: false, captionTiming: "none" });
  }, 120_000);

  it("says so and goes back to clips ready when a clip is missing", async () => {
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject, updateProject } = await import("@/lib/video/projects");
    const id = await project();
    const p = (await getProject(id))!;
    p.clips![1]!.videoKey = "video/p/gone.mp4";
    await updateProject(id, { clips: p.clips });
    await assembleVideo(id);
    const after = (await getProject(id))!;
    expect(after.status).toBe("clips_ready");
    expect(after.final!.state).toBe("failed");
    expect(after.final!.error).toMatch(/missing from storage/);
  }, 60_000);
});
