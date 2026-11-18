import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import type { CreativePlan, QaReport, SceneBrief } from "@/lib/video/pipeline-types";
import type { VideoScene, VideoScript } from "@/lib/video/script";

// Importing the generation module is slow when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

// "Make again from here" sat on "creating the clip" for 20+ minutes: the reference-image step threw, the loop
// swallowed the error and tried again forever, never saying why. These tests pin what must happen instead.

const created: Array<{ seconds: number }> = [];
const tasks = new Map<string, number>();
const stored = new Map<string, Buffer>();
let referenceCalls: string[] = [];
let referenceBehaviour: (kind: string, call: number) => Promise<{ url: string }> = async (kind, call) => ({ url: `https://ark.example/${kind}-${call}.png` });
let projectId = "";
let leaseSeenByReferenceCall: string | null = null;

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
vi.mock("@/lib/video/assemble", () => ({ assembleVideo: async () => undefined }));
vi.mock("@/lib/video/seedream", () => ({
  createReferenceImage: async (_m: string, kind: string) => {
    referenceCalls.push(kind);
    const { getProject } = await import("@/lib/video/projects");
    leaseSeenByReferenceCall = (await getProject(projectId))?.lease_until ?? null;
    return referenceBehaviour(kind, referenceCalls.length);
  },
}));
vi.mock("@/lib/storage/r2", () => ({
  getObjectStorage: () => ({
    put: async (key: string, data: Buffer) => void stored.set(key, Buffer.from(data)),
    get: async (key: string) => stored.get(key) ?? null,
    delete: async (key: string) => void stored.delete(key),
  }),
}));
vi.mock("@/lib/video/pipeline", async (orig) => {
  const real = await orig<typeof import("@/lib/video/pipeline")>();
  return {
    ...real,
    prepareCreative: async (project: import("@/lib/video/projects").VideoProject) => {
      const script = project.chosen_script!;
      const scenes: SceneBrief[] = script.scenes.map((s, i) => ({
        number: s.number, purpose: `p${i}`, informationAdded: `i${i}`, narration: s.line, subject: "the host", setting: "a greenhouse", action: "speaks", framing: "Medium shot", camera: "slow push-in", lighting: "soft",
        style: "doc", characterId: "host", environmentId: "env_a", requiredAssets: [], overlays: [], screenTreatment: "none", seconds: s.seconds, durationBasis: "speech", entry: { mode: "cut", condition: "" },
        exit: { condition: "" }, transition: { kind: "cut", rationale: "" }, risks: [], acceptance: ["her face stays steady"],
      }));
      const creative: CreativePlan = {
        version: 1, createdAt: "", basis: { product: "", audience: "", offer: "", platform: "", objective: "", targetSeconds: 35, assetIds: [] },
        narrative: { approach: "original", whyItFits: "w", arc: [] }, characters: [{ id: "host", description: "A woman in her 40s", role: "the host" }],
        environments: [{ id: "env_a", description: "A greenhouse", sceneNumbers: script.scenes.map((s) => s.number) }], scenes, validation: { ok: true, issues: [], checkedAt: "" },
      };
      return { creative, speech: { lexicon: { locale: "en-AU", entries: [], provider: { ssml: false, phonemes: false, dictionary: false, note: "" }, createdAt: "" }, lines: [] }, script, capabilities: {} as never };
    },
    reviewDownloadedClip: async (_p: unknown, _plan: unknown, clip: { number: number }): Promise<QaReport> => ({ subject: { kind: "clip", clip: clip.number }, attempt: 1, checkedAt: "", verdict: "pass", findings: [], checks: [], framesInspected: 6, limitations: [] }),
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
  projectId = project.id;
  return project.id;
}

beforeEach(() => {
  process.env.ARK_API_KEY = "test-key";
  resetConfigCache();
  created.length = 0;
  tasks.clear();
  stored.clear();
  referenceCalls = [];
  leaseSeenByReferenceCall = null;
  referenceBehaviour = async (kind, call) => ({ url: `https://ark.example/${kind}-${call}.png` });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ARK_API_KEY;
  resetConfigCache();
});

describe("a step that keeps failing is shown as failed, with the reason, not as endless 'creating the clip'", () => {
  it("fails the video with the reason when the reference images cannot be made", async () => {
    const { startGeneration, runGeneration, viewGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    referenceBehaviour = async () => {
      throw new Error("The image model timed out.");
    };
    await startGeneration(id, undefined, "none");
    expect(await runGeneration(id, 3_000, noSleep)).toBe("failed");
    const p = (await getProject(id))!;
    expect(p.status).toBe("failed");
    expect(p.error).toMatch(/timed out/);
    expect(p.clips![0]!.status).toBe("failed");
    // The screen shows a failed clip it can offer "Make again" on, and the reason.
    const view = viewGeneration(p);
    expect(view.status).toBe("failed");
    expect(view.clips[0]!.error).toMatch(/timed out/);
    expect(created).toHaveLength(0);
  });

  it("tries a one-off failure again and carries on", async () => {
    const { startGeneration, runGeneration } = await import("@/lib/video/generation");
    const id = await confirmed();
    let failures = 1;
    referenceBehaviour = async (kind, call) => {
      if (failures-- > 0) throw new Error("socket hang up");
      return { url: `https://ark.example/${kind}-${call}.png` };
    };
    await startGeneration(id, undefined, "none");
    expect(await runGeneration(id, 10_000, noSleep)).toBe("done");
  });

  it("keeps the images that were made when another one fails, so they are not paid for twice", async () => {
    const { startGeneration, advance } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    referenceBehaviour = async (kind, call) => {
      if (kind === "presenter") throw new Error("The image model timed out.");
      return { url: `https://ark.example/${kind}-${call}.png` };
    };
    await startGeneration(id, undefined, "none");
    await advance(id); // plans the video
    await advance(id); // makes the references: the person fails, the place works
    const p = (await getProject(id))!;
    expect(p.plan!.references!.environments.env_a?.url).toMatch(/location/);
    expect(p.plan!.references!.characters.host).toBeUndefined();
  });

  it("clears the failure count once a step works, so separate hiccups never add up to a failure", async () => {
    const { startGeneration, advance } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    let failures = 1;
    referenceBehaviour = async (kind, call) => {
      if (failures-- > 0) throw new Error("socket hang up");
      return { url: `https://ark.example/${kind}-${call}.png` };
    };
    await startGeneration(id, undefined, "none");
    await advance(id); // plans the video
    await advance(id); // one picture fails
    expect((await getProject(id))!.clips![0]!.stepErrors).toBe(1);
    expect((await getProject(id))!.clips![0]!.error).toMatch(/socket hang up/);
    await advance(id); // the missing picture is made
    expect((await getProject(id))!.clips![0]!.stepErrors ?? 0).toBe(0);
  });
});

describe("a slow image cannot let the working lease run out under it", () => {
  it("holds the long lease while reference images are being made, so no second step runs the same work", async () => {
    const { startGeneration, advance } = await import("@/lib/video/generation");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    await advance(id); // plans the video
    await advance(id); // makes the references
    expect(leaseSeenByReferenceCall).not.toBeNull();
    // A reference image can take two minutes: the lease must reach well past that, not the 45s used for polling.
    expect(Date.parse(leaseSeenByReferenceCall!) - Date.now()).toBeGreaterThan(150_000);
  });
});

describe("making again from a later clip", () => {
  it("keeps the earlier clips and the reference images, and makes only the later clips", async () => {
    const { startGeneration, runGeneration, regenerateFrom } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await confirmed();
    await startGeneration(id, undefined, "none");
    expect(await runGeneration(id, 10_000, noSleep)).toBe("done");
    const clipCount = (await getProject(id))!.clips!.length;
    const madeBefore = created.length;
    const imagesBefore = referenceCalls.length;
    expect(clipCount).toBeGreaterThan(1);
    await regenerateFrom(id, clipCount);
    expect(await runGeneration(id, 10_000, noSleep)).toBe("done");
    expect(created.length - madeBefore).toBe(1);
    expect(referenceCalls.length).toBe(imagesBefore);
  });
});
