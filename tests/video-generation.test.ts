import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { buildClipPrompt } from "@/lib/video/clip-prompt";
import type { VideoScript, VideoScene } from "@/lib/video/script";

const created: Array<{ model: string; content: Array<Record<string, unknown>>; seconds: number; ratio: string; resolution: string; seed?: number }> = [];
const tasks = new Map<string, { polls: number; outcome: "succeed" | "fail" }>();
let nextOutcome: Array<"succeed" | "fail"> = [];
const stored = new Map<string, Buffer>();

vi.mock("@/lib/video/seedance", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/seedance")>()),
  createVideoTask: async (input: (typeof created)[number]) => {
    created.push(input);
    const id = `cgt-${created.length}`;
    tasks.set(id, { polls: 0, outcome: nextOutcome.shift() ?? "succeed" });
    return { id };
  },
  getVideoTask: async (_model: string, id: string) => {
    const t = tasks.get(id)!;
    t.polls += 1;
    if (t.polls < 2) return { id, status: "running", videoUrl: null, lastFrameUrl: null, completionTokens: null, error: null };
    if (t.outcome === "fail") return { id, status: "failed", videoUrl: null, lastFrameUrl: null, completionTokens: null, error: { code: "InputImageSensitiveContentDetected", message: "blocked" } };
    return { id, status: "succeeded", videoUrl: `https://ark.example/${id}.mp4`, lastFrameUrl: `https://ark.example/${id}-last.png`, completionTokens: 500_000, error: null };
  },
}));
let referenceCalls: string[] = [];
vi.mock("@/lib/video/seedream", () => ({
  createReferenceImage: async (_m: string, kind: string) => {
    referenceCalls.push(kind);
    return { url: `https://ark.example/${kind}.png` };
  },
}));
vi.mock("@/lib/storage/r2", () => ({
  getObjectStorage: () => ({
    put: async (key: string, data: Buffer) => void stored.set(key, Buffer.from(data)),
    get: async (key: string) => stored.get(key) ?? null,
    delete: async (key: string) => void stored.delete(key),
  }),
}));

const noSleep = async () => undefined;

const scene = (number: number, seconds: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({
  number,
  start: 0,
  end: 0,
  seconds,
  visual: "A presenter at a desk",
  camera: "Medium close-up",
  speaker: "on_camera",
  line,
  keywords: [],
  stat: null,
  assetId: null,
  sound: "room tone",
  ...extra,
});

function script(): VideoScript {
  const scenes = [
    scene(1, 3, "I thought my ads were fine."),
    scene(2, 6, "Turns out I'd no idea where the money went."),
    scene(3, 8, "Then we ran a free audit.", { stat: "255%", assetId: "img_1" }),
    scene(4, 9, "It showed us every leak, honestly."),
    scene(5, 9, "So I'd say give it a go."),
  ];
  let t = 0;
  for (const s of scenes) {
    s.start = t;
    t += s.seconds;
    s.end = t;
  }
  return {
    id: "s1",
    title: "t",
    angle: { key: "pain", name: "Pain", stage: "Problem aware", kind: "pain" },
    pain: "p",
    framework: { key: "pas", name: "PAS" },
    style: "UGC creator walkthrough",
    durationSeconds: t,
    hookAlternatives: ["a", "b", "c"],
    character: "A man in his 30s, short dark hair, grey t-shirt",
    setting: "A bright home office with a window on the left",
    scenes,
    adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Learn More" },
    warnings: [],
  };
}

beforeEach(() => {
  process.env.ARK_API_KEY = "test-key";
  resetConfigCache();
  created.length = 0;
  tasks.clear();
  nextOutcome = [];
  stored.clear();
  referenceCalls = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ARK_API_KEY;
  resetConfigCache();
});

describe("the prompt for a clip", () => {
  const refs = { presenter: true, location: true, previousFrame: false, previousVideo: false };
  const base = { script: script(), clipNumber: 1, clipCount: 2, locale: "en-AU", refs, graphicSceneNumbers: [3] };

  it("names its assets by type and number, and says the same person and room must stay", () => {
    const p = buildClipPrompt({ ...base, sceneNumbers: [1, 2] });
    expect(p).toContain("Image 1 is the presenter");
    expect(p).toContain("Image 2 is the location");
    expect(p).toContain("Australian English accent");
    expect(p).toContain("grey t-shirt");
  });
  it("gives a timed shot list from the start of the clip with the exact words in quotes", () => {
    const p = buildClipPrompt({ ...base, sceneNumbers: [1, 2, 3] });
    expect(p).toContain('0s-3s: Shot 1.');
    expect(p).toContain('3s-9s: Shot 2.');
    expect(p).toContain('9s-17s: Shot 3.');
    expect(p).toContain('"Turns out I\'d no idea where the money went."');
  });
  it("asks for no text, captions, logos, numbers or music, because those are added afterwards", () => {
    const p = buildClipPrompt({ ...base, sceneNumbers: [1] });
    expect(p).toMatch(/Do not draw any subtitles, captions, on-screen text, numbers, charts, logos/);
    expect(p).toMatch(/No background music/);
  });
  it("keeps the frame clear where a graphic is added later, and only there", () => {
    const p = buildClipPrompt({ ...base, sceneNumbers: [2, 3] });
    const shot3 = p.split("\n").find((l) => l.includes("Shot 3."))!;
    const shot2 = p.split("\n").find((l) => l.includes("Shot 2."))!;
    expect(shot3).toContain("A graphic is added over this shot afterwards");
    expect(shot2).not.toContain("A graphic is added");
  });
  it("opens a later clip from the previous one's last frame, without words that read as an edit or an extension", () => {
    const p = buildClipPrompt({ ...base, clipNumber: 2, sceneNumbers: [4, 5], refs: { presenter: true, location: true, previousFrame: true, previousVideo: true } });
    expect(p).toContain("Image 3 is where the previous shot ended");
    expect(p).toContain("Video 1 is the previous shot");
    expect(p).not.toMatch(/\b(extend|continue|continuation|edit|replace)\b/i);
  });
  it("ends mid-action on every clip but the last", () => {
    expect(buildClipPrompt({ ...base, sceneNumbers: [1] })).toContain("mid-action");
    expect(buildClipPrompt({ ...base, clipNumber: 2, sceneNumbers: [4] })).toContain("settled final moment");
  });
});

async function confirmedProject(withScript: VideoScript = script()) {
  const { createProject, updateProject } = await import("@/lib/video/projects");
  const project = await createProject({
    clientId: "c1",
    inputs: { landingPageUrl: "https://a.test", stats: [], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" },
  });
  await updateProject(project.id, { chosen_script: withScript, status: "confirmed" });
  return project.id;
}

describe("making the clips", () => {
  it("makes the presenter and location once, then each clip in order, each opening from the one before", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmedProject();
    const started = await startGeneration(id);
    expect(started.status).toBe("generating");
    expect(started.clips!.length).toBeGreaterThanOrEqual(2);

    expect(await runGeneration(id, 60_000, noSleep)).toBe("done");

    expect(referenceCalls).toEqual(["presenter", "location"]);
    const project = (await getProject(id))!;
    expect(project.status).toBe("clips_ready");
    expect(project.clips!.every((c) => c.status === "succeeded" && c.videoKey && stored.has(c.videoKey))).toBe(true);

    // Clip 1: the two references, no video. Clip 2: the same two plus clip 1's last frame and clip 1 itself.
    const roles = (i: number) => created[i]!.content.filter((c) => c.type !== "text").map((c) => c.role);
    expect(roles(0)).toEqual(["reference_image", "reference_image"]);
    expect(roles(1)).toEqual(["reference_image", "reference_image", "reference_image", "reference_video"]);
    const urls = created[1]!.content.filter((c) => c.type === "image_url").map((c) => (c.image_url as { url: string }).url);
    expect(urls).toEqual(["https://ark.example/presenter.png", "https://ark.example/location.png", "https://ark.example/cgt-1-last.png"]);
    // Clip 2 was only asked for after clip 1 finished.
    expect(created[1]!.seconds + created[0]!.seconds).toBe(script().durationSeconds);
    expect(created[0]!.ratio).toBe("9:16");
  });

  it("adds up what the clips actually cost from their reported tokens", async () => {
    const { startGeneration, runGeneration, viewGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmedProject();
    await startGeneration(id);
    await runGeneration(id, 60_000, noSleep);
    const view = viewGeneration((await getProject(id))!);
    expect(view.spentUsd).toBeGreaterThan(0);
    expect(view.clips.every((c) => c.hasVideo && c.videoUrl?.includes(`/clips/${c.number}`))).toBe(true);
    // internal addresses are never sent to the screen
    expect(JSON.stringify(view)).not.toContain("ark.example");
  });

  it("tries a failed clip once more with a new seed, then stops and says why", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmedProject();
    await startGeneration(id);
    nextOutcome = ["fail", "fail"];
    expect(await runGeneration(id, 60_000, noSleep)).toBe("failed");
    expect(created).toHaveLength(2);
    expect(created[0]!.seed).toBeUndefined();
    expect(typeof created[1]!.seed).toBe("number");
    const project = (await getProject(id))!;
    expect(project.status).toBe("failed");
    expect(project.error).toMatch(/Clip 1 failed: InputImageSensitiveContentDetected/);
    // clip 2 was never asked for
    expect(project.clips![1]!.status).toBe("waiting");
  });

  it("recovers when the first attempt fails and the second works", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const id = await confirmedProject();
    await startGeneration(id);
    nextOutcome = ["fail"];
    expect(await runGeneration(id, 60_000, noSleep)).toBe("done");
  });

  it("makes one clip and the ones after it again, keeping the earlier clips and their references", async () => {
    const { startGeneration, runGeneration, regenerateFrom } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmedProject();
    await startGeneration(id);
    await runGeneration(id, 60_000, noSleep);
    const before = (await getProject(id))!;
    const keptKey = before.clips![0]!.videoKey;
    referenceCalls = [];
    created.length = 0;

    const again = await regenerateFrom(id, 2);
    expect(again.status).toBe("generating");
    expect(again.clips![0]!.status).toBe("succeeded");
    expect(again.clips![0]!.videoKey).toBe(keptKey);
    expect(again.clips![1]!.status).toBe("waiting");
    expect(again.plan!.character).not.toBeNull();

    await runGeneration(id, 60_000, noSleep);
    expect(referenceCalls).toEqual([]);
    expect(created).toHaveLength(before.clips!.length - 1);

    // From clip 1 the person is made fresh, so the new take matches itself.
    await regenerateFrom(id, 1);
    expect((await getProject(id))!.plan!.character).toBeNull();
  });

  it("will not carry on with a later clip once the references have expired, and says what to do", async () => {
    const { startGeneration, step } = await import("@/lib/video/generation");
    const { getProject, updateProject } = await import("@/lib/video/projects");
    const id = await confirmedProject();
    await startGeneration(id);
    // make clip 1 and its references, then jump a day ahead
    await step(id);
    await step(id);
    const day = 25 * 60 * 60 * 1000;
    const p = (await getProject(id))!;
    p.clips![0]!.status = "succeeded";
    p.clips![0]!.finishedAt = new Date().toISOString();
    await updateProject(id, { clips: p.clips });
    const result = await step(id, Date.now() + day);
    expect(result).toBe("failed");
    expect((await getProject(id))!.error).toMatch(/expired/);
  });
});

describe("before starting", () => {
  it("says why when there is no key for the model", async () => {
    delete process.env.ARK_API_KEY;
    resetConfigCache();
    const { blockedReason } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmedProject();
    expect(blockedReason((await getProject(id))!)).toMatch(/Add your BytePlus key/);
  });
  it("uses a model that has a key when the preferred one has none", async () => {
    delete process.env.ARK_API_KEY;
    process.env.ARK_SEEDANCE_API_KEY = "only-20";
    resetConfigCache();
    const { buildPlan } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    // an on-camera script would choose 2.5; with only a 2.0 key it falls back and says so
    const id = await confirmedProject();
    const { plan } = buildPlan((await getProject(id))!);
    delete process.env.ARK_SEEDANCE_API_KEY;
    expect(plan.model).toBe("seedance-2-0");
    expect(plan.reasons.join(" ")).toMatch(/has no API key here/);
  });
});

describe("assembly follows the clips", () => {
  it("finishes the video by itself once every clip is made", async () => {
    const assembled: string[] = [];
    vi.doMock("@/lib/video/assemble", () => ({ assembleVideo: async (id: string) => void assembled.push(id) }));
    vi.resetModules();
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { createProject, updateProject } = await import("@/lib/video/projects");
    const p = await createProject({ clientId: "c1", inputs: { landingPageUrl: "https://a.test", stats: [], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" } });
    await updateProject(p.id, { chosen_script: script(), status: "confirmed" });
    await startGeneration(p.id, { captions: true, logo: true, endCard: false });
    await runGeneration(p.id, 60_000, noSleep);
    expect(assembled).toEqual([p.id]);
    vi.doUnmock("@/lib/video/assemble");
  });

  it("shows a join that has been running far too long as interrupted, so the screen is never stuck", async () => {
    const { effectiveProject } = await import("@/lib/video/generation");
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const project = { id: "x", status: "assembling", final: { state: "running", startedAt: old, stage: "Joining the clips", error: null } } as never;
    const out = effectiveProject(project);
    expect(out.status).toBe("clips_ready");
    expect(out.final!.state).toBe("failed");
    const fresh = effectiveProject({ id: "x", status: "assembling", final: { state: "running", startedAt: new Date().toISOString() } } as never);
    expect(fresh.status).toBe("assembling");
  });
});
