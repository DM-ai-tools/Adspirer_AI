import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { probe, runFfmpeg } from "@/lib/video/ffmpeg";
import { sha256 } from "@/lib/video/assets";
import type { AsrWord } from "@/lib/video/captions";
import type { EditPlan } from "@/lib/video/edit-plan";
import type { FinalQaInput } from "@/lib/video/final-qa";
import type { BrandManifest } from "@/lib/video/pipeline-types";
import type { VideoScene, VideoScript } from "@/lib/video/script";

/**
 * The clean export, end to end with real ffmpeg: two clips of one flat colour are joined. Anything
 * this application drew on the picture (a caption, a logo, a stat card, the proof image, an end card)
 * would break that flat colour, so a frame that is still one colour everywhere proves nothing was added.
 */

const stored = new Map<string, Buffer>();
vi.mock("@/lib/storage/r2", () => ({
  getObjectStorage: () => ({
    name: "TestStorage",
    put: async (key: string, data: Buffer | string) => void stored.set(key, Buffer.from(data)),
    get: async (key: string) => stored.get(key) ?? null,
    delete: async (key: string) => void stored.delete(key),
  }),
}));

vi.mock("@/lib/video/face-bands", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/face-bands")>()),
  detectFaceBands: async () => ({ bands: [], samples: [], limitation: null }),
}));

const reviewed: FinalQaInput[] = [];
vi.mock("@/lib/video/final-qa", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/final-qa")>()),
  reviewFinal: async (input: FinalQaInput) => {
    reviewed.push(input);
    return { subject: { kind: "final" as const }, attempt: 1, checkedAt: new Date().toISOString(), verdict: "pass" as const, findings: [], checks: [{ name: "Clean picture: no text, graphics or logos", ok: true, detail: "15 frames" }], framesInspected: 15, limitations: [] };
  },
}));

let asrWords: AsrWord[] | null = null;
vi.mock("@/lib/video/asr", () => ({ transcribeWords: async () => asrWords }));

const COLOUR = { r: 0x33, g: 0x66, b: 0x99 };
const LOGO_KEY = "video/p/brand/logo.png";
const IMAGE_KEY = "video/p/img_1.png";
let logoBytes: Buffer;
let imageBytes: Buffer;
let dir: string;

const w = (word: string, start: number, end: number): AsrWord => ({ word, start, end });
const SPEECH: AsrWord[] = [
  w("I", 0.2, 0.3), w("thought", 0.35, 0.7), w("my", 0.75, 0.85), w("ads", 0.9, 1.2), w("were", 1.25, 1.4), w("fine", 1.45, 1.8),
  w("Then", 3.2, 3.4), w("the", 3.4, 3.5), w("audit", 3.5, 3.9), w("found", 3.9, 4.2), w("255%", 4.3, 5.1), w("more", 5.1, 5.4),
  w("It", 6.2, 6.3), w("showed", 6.3, 6.7), w("every", 6.7, 7.0), w("single", 7.0, 7.4), w("leak", 7.4, 7.8),
  w("So", 9.2, 9.4), w("give", 9.4, 9.6), w("it", 9.6, 9.7), w("a", 9.7, 9.8), w("go", 9.8, 10.2),
];

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "clean-export-"));
  for (const n of [1, 2]) {
    const f = path.join(dir, `c${n}.mp4`);
    await runFfmpeg(["-f", "lavfi", "-i", "color=c=0x336699:size=720x1280:rate=24", "-f", "lavfi", "-i", `sine=frequency=${n === 1 ? 300 : 500}:sample_rate=44100`, "-t", "6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", f]);
    stored.set(`video/p/clip-${n}.mp4`, await readFile(f));
  }
  logoBytes = await sharp({ create: { width: 400, height: 120, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  imageBytes = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#f59e0b" } }).png().toBuffer();
}, 60_000);

beforeEach(() => {
  stored.set(LOGO_KEY, logoBytes);
  stored.set(IMAGE_KEY, imageBytes);
  reviewed.length = 0;
  asrWords = SPEECH;
});

const scene = (number: number, start: number, seconds: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({ number, start, end: start + seconds, seconds, visual: "v", camera: "c", speaker: "on_camera", line, keywords: [], stat: null, assetId: null, sound: "s", ...extra });
const prov = { source: "operator" as const, detail: "test", confidence: "high" as const };

const manifest = (): BrandManifest => ({
  version: 1,
  createdAt: new Date().toISOString(),
  clientId: "c1",
  projectId: "p",
  sourceUrl: { value: "https://acme.example", provenance: [prov] },
  name: { value: "Acme", provenance: [prov] },
  nameCandidates: [],
  internalLabels: [],
  logo: { storageKey: LOGO_KEY, mime: "image/png", sourceUrl: "https://acme.example/logo.png", origin: "page", verification: { ok: true, format: "png", width: 400, height: 120, hasAlpha: true, transparentShare: 0, luminance: 255, legibleOnLight: false, legibleOnDark: true, problems: [] }, provenance: [prov] },
  logoCandidates: [],
  colors: { value: ["#101820", "#37ca37"], provenance: [prov] },
  offer: { value: "Free ad audit", provenance: [prov] },
  cta: { value: { label: "Book a free audit", url: "https://acme.example/audit" }, provenance: [prov] },
  audience: { value: null, provenance: [] },
  claims: [{ id: "claim_1", text: "255% avg client ROI", kind: "number", figure: "255%", evidence: "255% avg client ROI", provenance: prov, assetId: "img_1" }],
  allowTextOnlyBrand: false,
  conflicts: [],
  issues: [],
});

/** A finished set of clips whose stored settings are those of an OLDER video: captions, logo and end card all on, and no mode. */
async function project(finishing: Record<string, unknown> = { captions: true, logo: true, endCard: true }) {
  const { createProject, updateProject } = await import("@/lib/video/projects");
  const p = await createProject({ clientId: "c1", inputs: { landingPageUrl: "https://a.test", stats: [], targetSeconds: 12, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" } });
  const script: VideoScript = {
    id: "s", title: "t", angle: { key: "k", name: "A", stage: "S", kind: "pain" }, pain: "p", framework: { key: "f", name: "F" }, style: "UGC", durationSeconds: 12, hookAlternatives: ["a", "b", "c"], character: null, setting: "s",
    scenes: [
      scene(1, 0, 3, "I thought my ads were fine.", { keywords: ["ads"] }),
      scene(2, 3, 3, "Then the audit found 255% more.", { stat: "255% avg client ROI", assetId: "img_1" }),
      scene(3, 6, 3, "It showed every single leak."),
      scene(4, 9, 3, "So give it a go."),
    ],
    adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Learn More" }, warnings: [],
  };
  const asset = { id: "img_1", name: "E-commerce Industries - 5.33M 7.png", purpose: "approved_proof_screenshot" as const, key: IMAGE_KEY, mime: "image/png", version: 1, sha256: sha256(imageBytes), bytes: imageBytes.length };
  await updateProject(p.id, {
    chosen_script: script,
    status: "clips_ready",
    assets: [{ ...asset, caption: "", role: "highlight", analysis: { kind: "stats_screenshot", summary: "A dashboard", hasFace: false, stats: [{ value: "255%", label: "avg client ROI" }], mainStat: { value: "255%", label: "avg client ROI" } } }],
    brand: { name: "Acme", colors: ["#101820", "#37ca37"], logoUrl: null, summary: null, manifest: manifest() },
    plan: { model: "seedance-2-0", modelLabel: "x", resolution: "720p", ratio: "9:16", format: "9:16", reasons: [], estimatedUsd: 1, character: null, setting: null, chainVideo: false, finishing: finishing as never, checkpoint: "none" as const, assets: [asset], createdAt: new Date().toISOString() },
    clips: [1, 2].map((n) => ({ number: n, seconds: 6, sceneNumbers: n === 1 ? [1, 2] : [3, 4], status: "succeeded" as const, taskId: null, attempts: 1, error: null, videoKey: `video/p/clip-${n}.mp4`, lastFrameUrl: null, sourceVideoUrl: null, finishedAt: new Date().toISOString(), tokens: 1, usd: 1, prompt: null })),
  });
  return p.id;
}

/** The colour of a frame, and how much it varies across the whole picture. */
async function frameStats(file: string, at: number) {
  const png = path.join(dir, `frame-${Math.round(at * 100)}-${Math.random().toString(36).slice(2, 7)}.png`);
  await runFfmpeg(["-ss", String(at), "-i", file, "-frames:v", "1", png]);
  const stats = await sharp(png).stats();
  return { mean: stats.channels.slice(0, 3).map((c) => c.mean), spread: Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev)) };
}

const startOfFirstCue = (srt: string) => {
  const m = /(\d\d):(\d\d):(\d\d),(\d{3}) --> (\d\d):(\d\d):(\d\d),(\d{3})/.exec(srt)!;
  return { start: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000, end: Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000 };
};

describe("the clean export (real ffmpeg)", () => {
  it("adds nothing to the picture, even when an older video's settings say captions, logo and end card", async () => {
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const { viewGeneration } = await import("@/lib/video/generation");
    const id = await project();
    await assembleVideo(id);
    const p = (await getProject(id))!;
    expect(p.final?.error).toBeNull();
    expect(p.final).toMatchObject({ state: "done", mode: "clean", width: 1080, height: 1920 });
    // What is in the file: none of the graphics, although the logo, the stat and the image were all available.
    expect(p.final!.includes).toMatchObject({ captions: false, logo: false, endCard: false, stats: 0, images: 0, captionTiming: "transcript" });
    expect(p.final!.brand).toEqual({ name: "Acme", logo: false, textOnly: false });

    const file = path.join(dir, "clean.mp4");
    await writeFile(file, stored.get(p.final!.key!)!);
    const info = await probe(file);
    // The two 6-second clips and nothing after them: no end card was appended.
    expect(info.seconds).toBeGreaterThan(11.7);
    expect(info.seconds).toBeLessThan(12.3);
    expect(info.hasAudio).toBe(true);
    // Every frame is still the one flat colour of the footage: at the opening (logo), while the stat and image would show, during speech (captions) and at the very end (end card).
    for (const at of [0.5, 1, 4.6, 7, 11.6]) {
      const f = await frameStats(file, at);
      expect(f.spread, `frame at ${at}s is not one flat colour`).toBeLessThan(3);
      expect(Math.abs(f.mean[0]! - COLOUR.r)).toBeLessThan(14);
      expect(Math.abs(f.mean[1]! - COLOUR.g)).toBeLessThan(14);
      expect(Math.abs(f.mean[2]! - COLOUR.b)).toBeLessThan(14);
    }

    // The inspection is told it is a clean video, so it does not look for a logo, a brand name or an end card.
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatchObject({ clean: true, expectsLogo: false, endCardSeconds: 0, logoReference: null });
    expect(reviewed[0]!.expected).toMatchObject({ brandName: null, ctaLabel: null, captionTexts: [], allowedOverlayText: [] });
    expect(viewGeneration(p).final).toMatchObject({ checkStatus: "passed", mode: "clean" });
  }, 180_000);

  it("supplies the subtitles, the transcript and the placement plan separately, timed to this export's audio", async () => {
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const { viewGeneration } = await import("@/lib/video/generation");
    const id = await project();
    await assembleVideo(id);
    const p = (await getProject(id))!;
    const seconds = p.final!.seconds!;

    const srt = stored.get(p.final!.subtitles!.srtKey)!.toString("utf8");
    const vtt = stored.get(p.final!.subtitles!.vttKey)!.toString("utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(srt).toContain("255%"); // the written form, not "two hundred and fifty five percent"
    const first = startOfFirstCue(srt);
    expect(Math.abs(first.start - 0.2)).toBeLessThan(0.15); // "I" is said at 0.2s
    // No cue runs past the end of the video.
    for (const m of srt.matchAll(/--> (\d\d):(\d\d):(\d\d),(\d{3})/g)) expect(Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000).toBeLessThanOrEqual(seconds + 0.05);

    const d = p.final!.deliverables!;
    const transcript = stored.get(d.transcriptKey)!.toString("utf8");
    expect(transcript).toMatch(/\[00:00\.2 - 00:01\.8\] I thought my ads were fine\./);
    expect(transcript).toMatch(/Then the audit found 255% more\./);
    expect(transcript).toMatch(/Times are measured from the final audio/);

    const plan = JSON.parse(stored.get(d.planJsonKey)!.toString("utf8")) as EditPlan;
    expect(plan.videoSeconds).toBeCloseTo(seconds, 0);
    const stat = plan.textOverlays.find((o) => o.kind === "stat")!;
    expect(stat).toMatchObject({ text: "255% avg client ROI", scene: 2, alignment: "centre" });
    expect(Math.abs(stat.start - 4.2)).toBeLessThan(0.2); // just before "255%" is said at 4.3s
    for (const o of plan.textOverlays) {
      expect(o.start).toBeGreaterThanOrEqual(0);
      expect(o.end).toBeLessThanOrEqual(seconds + 0.01);
    }
    // The exact uploaded original, by name and checksum, offered separately and never drawn in.
    expect(plan.proofImages).toEqual([expect.objectContaining({ fileName: "E-commerce Industries - 5.33M 7.png", sha256: sha256(imageBytes), available: true, scenes: [2] })]);
    expect(plan.logo).toMatchObject({ available: true, sha256: sha256(logoBytes) });
    expect(plan.endCard!.lines).toEqual(["Acme", "Book a free audit", "acme.example/audit"]);
    expect(stored.get(d.planTextKey)!.toString("utf8")).toMatch(/The MP4 is clean: it contains none of what is listed here/);

    const view = viewGeneration(p);
    expect(view.final).toMatchObject({ suggestedOverlays: plan.textOverlays.length });
    for (const url of [view.final!.videoUrl, view.final!.srtUrl, view.final!.vttUrl, view.final!.transcriptUrl, view.final!.planUrl, view.final!.planJsonUrl]) expect(url).toMatch(new RegExp(`^/api/creatives/video/${id}/final`));
    expect(view.assets[0]).toMatchObject({ name: "E-commerce Industries - 5.33M 7.png", sha256: sha256(imageBytes) });
    // The file behind that download is byte for byte the upload.
    expect(stored.get(IMAGE_KEY)).toEqual(imageBytes);
  }, 180_000);

  it("is retimed when the edit changes: the same speech later in the video gives later times", async () => {
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const id = await project();
    await assembleVideo(id);
    const before = JSON.parse(stored.get((await getProject(id))!.final!.deliverables!.planJsonKey)!.toString("utf8")) as EditPlan;
    asrWords = SPEECH.map((x) => (x.start >= 3 && x.start < 6 ? { ...x, start: x.start + 0.6, end: x.end + 0.6 } : x));
    await assembleVideo(id);
    const after = JSON.parse(stored.get((await getProject(id))!.final!.deliverables!.planJsonKey)!.toString("utf8")) as EditPlan;
    const at = (plan: EditPlan) => plan.textOverlays.find((o) => o.kind === "stat")!.start;
    // The figure is now said 0.6s later, so the suggestion moves later with it (the words are located in the audio again, not copied over).
    expect(at(after) - at(before)).toBeGreaterThan(0.3);
    expect(at(after) - at(before)).toBeLessThan(0.75);
  }, 240_000);

  it("still finishes when the logo and the proof image are gone, and says they are missing instead of using anything else", async () => {
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const id = await project();
    stored.delete(LOGO_KEY);
    stored.delete(IMAGE_KEY);
    await assembleVideo(id);
    const p = (await getProject(id))!;
    expect(p.final).toMatchObject({ state: "done", mode: "clean" });
    const plan = JSON.parse(stored.get(p.final!.deliverables!.planJsonKey)!.toString("utf8")) as EditPlan;
    expect(plan.proofImages[0]).toMatchObject({ available: false, sha256: sha256(imageBytes) });
    expect(plan.logo).toMatchObject({ available: false });
    expect(plan.logo!.note).toMatch(/could not be read from storage/);
  }, 180_000);

  it("when graphics are asked for by name, a lost proof image or logo stops the export: it is never skipped or replaced", async () => {
    const { assembleVideo } = await import("@/lib/video/assemble");
    const { getProject } = await import("@/lib/video/projects");
    const branded = { mode: "branded", captions: true, logo: true, endCard: true };

    const noImage = await project(branded);
    stored.delete(IMAGE_KEY);
    await assembleVideo(noImage);
    expect((await getProject(noImage))!.final).toMatchObject({ state: "failed", key: null });
    expect((await getProject(noImage))!.final!.error).toMatch(/"E-commerce Industries - 5\.33M 7\.png" is no longer in storage.*nothing else is used in its place/i);

    stored.set(IMAGE_KEY, await sharp({ create: { width: 800, height: 500, channels: 3, background: "#dc2626" } }).png().toBuffer());
    const otherImage = await project(branded);
    await assembleVideo(otherImage);
    expect((await getProject(otherImage))!.final!.error).toMatch(/is not the file that was selected for this video/);

    stored.set(IMAGE_KEY, imageBytes);
    const noLogo = await project(branded);
    stored.delete(LOGO_KEY);
    await assembleVideo(noLogo);
    expect((await getProject(noLogo))!.final!.error).toMatch(/verified logo file is no longer in storage/);
  }, 240_000);
});
