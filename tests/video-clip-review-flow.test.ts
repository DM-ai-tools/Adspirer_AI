import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import type { CreativePlan, QaFinding, QaReport, QaVerdict, SceneBrief } from "@/lib/video/pipeline-types";
import type { VideoScene, VideoScript } from "@/lib/video/script";

// The generation loop with the clip inspection in it: what happens to a clip that is rejected.

const created: Array<{ content: Array<Record<string, unknown>>; seconds: number; seed?: number }> = [];
const tasks = new Map<string, number>();
const stored = new Map<string, Buffer>();
let queue: Array<{ verdict: QaVerdict; findings?: QaFinding[] }> = [];
let redesigns = 0;
let referenceKinds: string[] = [];

vi.mock("@/lib/video/seedance", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/seedance")>()),
  createVideoTask: async (input: (typeof created)[number]) => {
    created.push(input);
    const id = `cgt-${created.length}`;
    tasks.set(id, 0);
    return { id };
  },
  getVideoTask: async (_m: string, id: string) => {
    tasks.set(id, (tasks.get(id) ?? 0) + 1);
    if ((tasks.get(id) ?? 0) < 2) return { id, status: "running", videoUrl: null, lastFrameUrl: null, completionTokens: null, error: null };
    return { id, status: "succeeded", videoUrl: `https://ark.example/${id}.mp4`, lastFrameUrl: `https://ark.example/${id}-last.png`, completionTokens: 500_000, error: null };
  },
}));
// Joining the clips is covered by the assembly tests; here it would only spawn ffmpeg on stand-in bytes and slow the loop under test.
vi.mock("@/lib/video/assemble", () => ({ assembleVideo: async () => undefined }));
vi.mock("@/lib/video/seedream", () => ({
  createReferenceImage: async (_m: string, kind: string) => {
    referenceKinds.push(kind);
    return { url: `https://ark.example/${kind}-${referenceKinds.length}.png` };
  },
}));
vi.mock("@/lib/storage/r2", () => ({
  getObjectStorage: () => ({
    put: async (key: string, data: Buffer) => void stored.set(key, Buffer.from(data)),
    get: async (key: string) => stored.get(key) ?? null,
    delete: async (key: string) => void stored.delete(key),
  }),
}));

const finding = (over: Partial<QaFinding> = {}): QaFinding => ({ code: "face_glow", severity: "critical", category: "face", message: "Bright cyan marks appear on the cheek.", evidence: "frame at 2.1s", atSeconds: 2.1, correction: "Keep the cheek clear, natural skin only.", source: "vision", ...over });

vi.mock("@/lib/video/pipeline", async (orig) => {
  const real = await orig<typeof import("@/lib/video/pipeline")>();
  return {
    ...real,
    // The creative plan, the lexicon and the inspection are exercised in their own tests: here they are stubbed so the loop's decisions can be shown.
    prepareCreative: async (project: import("@/lib/video/projects").VideoProject) => {
      const script = project.chosen_script!;
      const scenes: SceneBrief[] = script.scenes.map((s, i) => ({
        number: s.number, purpose: `p${i}`, informationAdded: `i${i}`, narration: s.line, subject: "the host", setting: "a greenhouse", action: "speaks", framing: "Medium shot", camera: "static", lighting: "soft",
        style: "doc", characterId: "host", environmentId: "env_a", requiredAssets: [], overlays: [], screenTreatment: "none", seconds: s.seconds, durationBasis: "speech", entry: { mode: i === 0 ? "cut" : "continue_previous", condition: "same room" },
        exit: { condition: "" }, transition: { kind: "cut", rationale: "" }, risks: [], acceptance: ["her face stays steady"],
      }));
      const creative: CreativePlan = {
        version: 1, createdAt: "", basis: { product: "", audience: "", offer: "", platform: "", objective: "", targetSeconds: 35, assetIds: [] },
        narrative: { approach: "original", whyItFits: "w", arc: [] }, characters: [{ id: "host", description: "A woman in her 40s", role: "the host" }],
        environments: [{ id: "env_a", description: "A greenhouse", sceneNumbers: script.scenes.map((s) => s.number) }], scenes, validation: { ok: true, issues: [], checkedAt: "" },
      };
      return { creative, speech: { lexicon: { locale: "en-AU", entries: [], provider: { ssml: false, phonemes: false, dictionary: false, note: "" }, createdAt: "" }, lines: [] }, script, capabilities: {} as never };
    },
    reviewDownloadedClip: async (_p: unknown, _plan: unknown, clip: { number: number; qaAttempts?: number }): Promise<QaReport> => {
      const next = queue.shift() ?? { verdict: "pass" as const };
      return { subject: { kind: "clip", clip: clip.number }, attempt: (clip.qaAttempts ?? 0) + 1, checkedAt: "", verdict: next.verdict, findings: next.findings ?? [], checks: [], framesInspected: 6, limitations: [] };
    },
    redesignClipScenes: async (_p: unknown, plan: { creative: CreativePlan }) => {
      redesigns += 1;
      return { ...plan.creative, narrative: { ...plan.creative.narrative, approach: "redesigned shot" } };
    },
  };
});

const noSleep = async () => undefined;
const scene = (number: number, seconds: number, line: string): VideoScene => ({ number, start: 0, end: 0, seconds, visual: "v", camera: "c", speaker: "on_camera", line, keywords: [], stat: null, assetId: null, sound: "" });

function script(): VideoScript {
  const scenes = [scene(1, 10, "I thought my ads were fine."), scene(2, 10, "Turns out I had no idea where the money went."), scene(3, 10, "Then we ran a free audit."), scene(4, 9, "It showed us every leak, honestly.")];
  let t = 0;
  for (const s of scenes) { s.start = t; t += s.seconds; s.end = t; }
  return { id: "s1", title: "t", angle: { key: "pain", name: "Pain", stage: "Problem aware", kind: "pain" }, pain: "p", framework: { key: "pas", name: "PAS" }, style: "Documentary", durationSeconds: t, hookAlternatives: ["a", "b", "c"], character: null, setting: "", scenes, adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Learn More" }, warnings: [] };
}

async function confirmed() {
  const { createProject, updateProject } = await import("@/lib/video/projects");
  const project = await createProject({ clientId: "c1", inputs: { landingPageUrl: "https://a.test", stats: [], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" } });
  const prov = { source: "operator" as const, detail: "test", confidence: "high" as const };
  await updateProject(project.id, {
    chosen_script: script(),
    status: "confirmed",
    brand: { name: "Acme", colors: null, logoUrl: null, summary: null, manifest: { version: 1, createdAt: "", clientId: "c1", projectId: project.id, sourceUrl: { value: null, provenance: [] }, name: { value: "Acme", provenance: [prov] }, nameCandidates: [], internalLabels: [], logo: null, logoCandidates: [], colors: { value: [], provenance: [] }, offer: { value: null, provenance: [] }, cta: { value: null, provenance: [] }, audience: { value: null, provenance: [] }, claims: [], allowTextOnlyBrand: true, conflicts: [], issues: [] } },
  });
  return project.id;
}

beforeEach(() => {
  process.env.ARK_API_KEY = "test-key";
  resetConfigCache();
  created.length = 0;
  tasks.clear();
  stored.clear();
  queue = [];
  redesigns = 0;
  referenceKinds = [];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ARK_API_KEY;
  resetConfigCache();
});

describe("planning comes before spending", () => {
  it("makes the creative plan first, and nothing is paid for until it is made", async () => {
    const { startGeneration, step } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    expect((await getProject(id))!.plan!.creative).toBeUndefined();
    await step(id);
    const p = (await getProject(id))!;
    expect(p.plan!.creative!.narrative.approach).toBe("original");
    expect(p.plan!.budgetUsd).toBeGreaterThan(p.plan!.estimatedUsd);
    expect(created).toHaveLength(0);
  });
  it("makes one reference per person and per place the clips show, not one global setting", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    await runGeneration(id, 60_000, noSleep);
    expect(referenceKinds.sort()).toEqual(["location", "presenter"]);
  });
});

describe("a clip is only made once it has been inspected", () => {
  it("approves a clean clip and keeps the inspection with it", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    expect(await runGeneration(id, 60_000, noSleep)).toBe("done");
    const p = (await getProject(id))!;
    expect(p.clips!.every((c) => c.status === "succeeded" && c.qa?.verdict === "pass" && c.attemptLog!.length === 1)).toBe(true);
  });

  it("rejects a clip with a facial artifact, tries again with a targeted correction and a new seed, and records both takes", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const { spentUsd } = await import("@/lib/video/pipeline");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    queue = [{ verdict: "retry", findings: [finding()] }];
    expect(await runGeneration(id, 60_000, noSleep)).toBe("done");

    const p = (await getProject(id))!;
    const clip1 = p.clips![0]!;
    expect(clip1.attemptLog).toHaveLength(2);
    expect(clip1.attemptLog![0]!.report!.verdict).toBe("retry");
    expect(clip1.attemptLog![1]!.corrections.join(" ")).toMatch(/cheek clear/);
    // the second request to the model carried the correction and a new seed
    expect(String(created[1]!.content[0]!.text)).toContain("Keep the cheek clear");
    expect(typeof created[1]!.seed).toBe("number");
    expect(created[0]!.seed).toBeUndefined();
    // the rejected take is paid for and counted
    expect(spentUsd(p.clips!)).toBeGreaterThan(p.clips!.reduce((t, c) => t + (c.usd ?? 0), 0));
    expect(clip1.qaAttempts).toBe(1);
  });

  it("preserves clips that were approved: only the rejected clip is made again", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    const clipCount = (await getProject(id))!.clips!.length;
    queue = [{ verdict: "pass" }, { verdict: "retry", findings: [finding()] }];
    await runGeneration(id, 60_000, noSleep);
    const p = (await getProject(id))!;
    expect(p.clips![0]!.attemptLog).toHaveLength(1);
    expect(created.length).toBe(clipCount + 1);
  });

  it("gives a clip whose speech was cut off the seconds it needs, in the plan and the script", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    const before = (await getProject(id))!;
    const total = before.clips![0]!.seconds;
    const lastBefore = new Map(before.chosen_script!.scenes.map((x) => [x.number, x.seconds]));
    queue = [{ verdict: "retry", findings: [finding({ code: "speech_clipped_end", category: "speech", severity: "major", message: "The last words are cut off at the end of the clip.", correction: "Let the last sentence finish before the clip ends." })] }];
    await runGeneration(id, 60_000, noSleep);
    const p = (await getProject(id))!;
    expect(p.clips![0]!.seconds).toBeGreaterThan(total);
    const lastScene = Math.max(...p.clips![0]!.sceneNumbers);
    expect(p.chosen_script!.scenes.find((s) => s.number === lastScene)!.seconds).toBeGreaterThan(lastBefore.get(lastScene)!);
  });
});

describe("a clip that cannot be approved", () => {
  it("redesigns the shot when the same problem keeps coming back, then carries on", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    queue = [{ verdict: "redesign", findings: [finding()] }];
    expect(await runGeneration(id, 60_000, noSleep)).toBe("done");
    const p = (await getProject(id))!;
    expect(redesigns).toBe(1);
    expect(p.clips![0]!.redesigns).toBe(1);
    expect(p.plan!.creative!.narrative.approach).toBe("redesigned shot");
  });

  it("stops and says exactly what is wrong instead of shipping it", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    queue = [{ verdict: "unresolved", findings: [finding()] }];
    expect(await runGeneration(id, 60_000, noSleep)).toBe("failed");
    const p = (await getProject(id))!;
    expect(p.status).toBe("failed");
    expect(p.clips![0]!.status).toBe("failed");
    expect(p.clips![0]!.unresolved).toBe(true);
    expect(p.error).toMatch(/could not be approved.*cyan marks/i);
    // the rejected clip is kept to look at, and the next clip was never paid for
    expect(p.clips![0]!.videoKey).toBeTruthy();
    expect(p.clips![1]!.status).toBe("waiting");
    expect(created).toHaveLength(1);
  });

  it("never approves a clip with a critical finding, whatever the verdict says", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    queue = [{ verdict: "pass", findings: [finding({ code: "fabricated_text", message: "A wordmark reading 'Whlubler' is drawn in the footage." })] }];
    expect(await runGeneration(id, 60_000, noSleep)).toBe("failed");
    const p = (await getProject(id))!;
    expect(p.clips![0]!.status).toBe("failed");
    expect(p.error).toMatch(/Whlubler/);
  });

  it("stops at the cost cap instead of retrying without limit", async () => {
    const { startGeneration, step } = await import("@/lib/video/generation");
    const { getProject, updateProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    await step(id); // planning
    const p = (await getProject(id))!;
    p.plan!.budgetUsd = 0.01;
    await updateProject(id, { plan: p.plan });
    await step(id); // reference images
    await step(id);
    const after = (await getProject(id))!;
    expect(after.status).toBe("failed");
    expect(after.error).toMatch(/cost cap/);
    expect(created).toHaveLength(0);
  });

  it("does not generate at all when the plan fails its checks", async () => {
    vi.resetModules();
    vi.doMock("@/lib/video/pipeline", async (orig) => ({
      ...(await orig<typeof import("@/lib/video/pipeline")>()),
      prepareCreative: async () => {
        throw new Error("The creative plan did not pass its checks, so nothing was generated: Scenes 2 and 3 repeat the same room.");
      },
    }));
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    expect(await runGeneration(id, 60_000, noSleep)).toBe("failed");
    expect((await getProject(id))!.error).toMatch(/repeat the same room/);
    expect(created).toHaveLength(0);
    expect(referenceKinds).toHaveLength(0);
    vi.doUnmock("@/lib/video/pipeline");
  });
});
