import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { LocalMockStorage, SupabaseBucketStorage, resetObjectStorage, type BucketApi, type ObjectStorage } from "@/lib/storage/r2";
import { acceptableStandalone, cutPointingPhrase, exportMode, footageOnly, graphicReference, pointingPhrase, resolveFinishing, stripGraphicPhrases, CLEAN_ENDING_RULE, CLEAN_FOOTAGE_RULE } from "@/lib/video/clean-mode";
import { buildPlannedClipPrompt } from "@/lib/video/clip-prompt";
import { decideClip, visionRubric, visionToFindings, type VisionResult } from "@/lib/video/clip-qa";
import { cleanFindings, endingFromAudio, finalFrameTimes, finalRubric, type FinalQaInput, type FinalVisionResult } from "@/lib/video/final-qa";
import { evidenceCautions, metricOf, narrationCautions, rangeDays, splitLabel, timeClaim, type EvidenceReading } from "@/lib/video/evidence";
import { buildClaimRegistry } from "@/lib/video/claims";
import { buildEditPlan, editPlanText, phraseSpan, placeText, transcriptText, type EditPlanInput } from "@/lib/video/edit-plan";
import { clampCues, type AlignedLine, type SubtitleCue } from "@/lib/video/subtitles";
import { hardRulesFor, normalisePlan, planCreative, planPrompt, validatePlan, type PlanInput, type PlanModelOutput } from "@/lib/video/scene-plan";
import { makeNarrationStandalone } from "@/lib/video/standalone";
import { jobAssets, loadOriginal, sha256, snapshotAssets } from "@/lib/video/assets";
import { brandStorageKey, loadManifestLogo, logoState, restoreManifestLogo } from "@/lib/video/brand-resolve";
import { brandView } from "@/lib/video/brand-view";
import { brandBlockers } from "@/lib/video/pipeline";
import type { BrandManifest, SceneBrief } from "@/lib/video/pipeline-types";
import type { VideoProject } from "@/lib/video/projects";
import type { VideoScene, VideoScript } from "@/lib/video/script";

// ------------------------------------------------------------------ a bucket that outlives a server

/** One bucket, as several server instances see it: each `worker` is a fresh adapter over the same stored objects. */
function bucketOver(objects: Map<string, Buffer>, opts: { down?: boolean } = {}): BucketApi {
  return {
    upload: async (p, data) => {
      objects.set(p, Buffer.from(data));
      return { error: null };
    },
    download: async (p) => {
      if (opts.down) return { data: null, error: { message: "fetch failed" } };
      const hit = objects.get(p);
      return hit ? { data: new Blob([new Uint8Array(hit)]), error: null } : { data: null, error: { message: "Object not found", status: 404 } };
    },
    remove: async (paths) => {
      for (const p of paths) objects.delete(p);
      return { error: null };
    },
  };
}
const worker = (objects: Map<string, Buffer>, opts?: { down?: boolean }): ObjectStorage => new SupabaseBucketStorage(async () => bucketOver(objects, opts), undefined, null, { attempts: 3, backoffMs: 1 });

const PNG = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, seed + 1, seed + 2, seed + 3]);
const prov = { source: "operator" as const, detail: "test", confidence: "high" as const };

function manifest(projectId: string, logoBytes: Buffer | null, over: Partial<BrandManifest> = {}): BrandManifest {
  return {
    version: 1,
    createdAt: "2026-11-09T10:26:49.820Z",
    clientId: "c1",
    projectId,
    sourceUrl: { value: "https://acme.example", provenance: [prov] },
    name: { value: "Acme", provenance: [prov] },
    nameCandidates: [],
    internalLabels: [],
    logo: logoBytes
      ? { storageKey: brandStorageKey(projectId, logoBytes, "png"), mime: "image/png", sourceUrl: "https://cdn.acme.example/logo.png", origin: "page", verification: { ok: true, format: "png", width: 400, height: 120, hasAlpha: true, transparentShare: 0.2, luminance: 228, legibleOnLight: false, legibleOnDark: true, problems: [] }, provenance: [prov] }
      : null,
    logoCandidates: [],
    colors: { value: ["#101820"], provenance: [prov] },
    offer: { value: "Free audit", provenance: [prov] },
    cta: { value: { label: "Book a free audit", url: "https://acme.example/audit" }, provenance: [prov] },
    audience: { value: null, provenance: [] },
    claims: [],
    allowTextOnlyBrand: false,
    conflicts: [],
    issues: [],
    ...over,
  };
}

const scene = (number: number, seconds: number, line: string, extra: Partial<VideoScene> = {}): VideoScene => ({ number, start: 0, end: 0, seconds, visual: "A presenter in a bright room", camera: "Medium close-up", speaker: "on_camera", line, keywords: [], stat: null, assetId: null, sound: "room tone", ...extra });

function script(scenes: VideoScene[]): VideoScript {
  let t = 0;
  for (const s of scenes) {
    s.start = t;
    t += s.seconds;
    s.end = t;
  }
  return { id: "s1", title: "t", angle: { key: "proof", name: "Proof", stage: "Solution aware", kind: "proof" }, pain: "p", framework: { key: "pas", name: "PAS" }, style: "Presenter to camera with composited proof asset", durationSeconds: t, hookAlternatives: ["a", "b", "c"], character: "A man in his late 30s in a blue shirt", setting: "A bright office", scenes, adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Learn More" }, warnings: [] };
}

// ------------------------------------------------------------------ storage: the cause of the lost logo and the lost proof image

describe("files outlive the server that saved them", () => {
  it("a file saved by one server instance is read back, byte for byte, by a new one after a restart or redeploy", async () => {
    const objects = new Map<string, Buffer>();
    await worker(objects).put("video/vid_a/brand/logo-abc.png", PNG(1), "image/png");
    const afterRestart = worker(objects);
    expect(await afterRestart.get("video/vid_a/brand/logo-abc.png")).toEqual(PNG(1));
    expect(await afterRestart.get("video/vid_a/brand/never-saved.png")).toBeNull();
  });

  it("the server's own disk does not: a new container starts with an empty folder (what happened to the logo and the proof image)", async () => {
    const before = new LocalMockStorage(await mkdtemp(path.join(os.tmpdir(), "disk-a-")));
    await before.put("video/vid_a/img_1.png", PNG(2), "image/png");
    const afterRedeploy = new LocalMockStorage(await mkdtemp(path.join(os.tmpdir(), "disk-b-")));
    expect(await afterRedeploy.get("video/vid_a/img_1.png")).toBeNull();
  });

  it("a store that cannot be reached is an error, never reported as a missing file", async () => {
    await expect(worker(new Map(), { down: true }).get("video/vid_a/img_1.png")).rejects.toThrow(/Could not read/);
  });

  it("tries again when the connection drops, and only then", async () => {
    const objects = new Map<string, Buffer>([["video/vid_a/img_1.png", PNG(2)]]);
    let calls = 0;
    const flaky: BucketApi = { ...bucketOver(objects), download: async (p) => ((calls += 1) < 3 ? { data: null, error: { message: "fetch failed" } } : bucketOver(objects).download(p)) };
    expect(await new SupabaseBucketStorage(async () => flaky, undefined, null, { attempts: 3, backoffMs: 1 }).get("video/vid_a/img_1.png")).toEqual(PNG(2));
    expect(calls).toBe(3);
    calls = 0;
    const missing: BucketApi = { ...bucketOver(objects), download: async (p) => ((calls += 1), bucketOver(objects).download(p)) };
    expect(await new SupabaseBucketStorage(async () => missing, undefined, null, { attempts: 3, backoffMs: 1 }).get("video/vid_a/none.png")).toBeNull();
    expect(calls).toBe(1);
  });

  it("keeps a file name with spaces and symbols as one stable object", async () => {
    const objects = new Map<string, Buffer>();
    const s = worker(objects);
    await s.put("docs/E-commerce Industries - 5.33M 7.png", PNG(3), "image/png");
    expect(await worker(objects).get("docs/E-commerce Industries - 5.33M 7.png")).toEqual(PNG(3));
    expect([...objects.keys()][0]).toMatch(/^docs\/[A-Za-z0-9._-]+$/);
  });
});

// ------------------------------------------------------------------ logo: five separate states, checked against storage

describe("the logo after a refresh", () => {
  const view = (m: BrandManifest, choice: VideoProject["inputs"]["brandChoice"] = {}) => ({ id: m.projectId, client_id: "c1", inputs: { brandChoice: choice }, brand: { name: "Acme", colors: null, logoUrl: null, summary: null, manifest: m } }) as unknown as VideoProject;

  it("is found, saved, readable and (once the operator says so) approved, and stays that way for a fresh server instance", async () => {
    const objects = new Map<string, Buffer>();
    const m = manifest("vid_a", PNG(4));
    await worker(objects).put(m.logo!.storageKey, PNG(4), "image/png");
    const state = await logoState(m, null, worker(objects));
    expect(state).toEqual({ nameVerified: true, found: true, saved: true, accessible: true, approved: false });
    const approved = await logoState(m, m.logo!.storageKey, worker(objects));
    expect(approved.approved).toBe(true);
    const shown = brandView(view(m), approved);
    expect(shown.checked && shown.hasLogo).toBe(true);
    // The address is this app's own route, read from storage on every request: nothing in it can expire.
    expect(shown.checked && shown.logo!.url).toMatch(/^\/api\/creatives\/video\/vid_a\/brand\/logo\?v=/);
    expect(shown.checked && shown.logo!.url).not.toMatch(/X-Amz|Signature|Expires|token=|blob:/i);
    expect(shown.checked && shown.logo!.downloadUrl).toContain("download=1");
  });

  it("is NOT shown as a verified logo when its file can no longer be read", async () => {
    const m = manifest("vid_a", PNG(4));
    const state = await logoState(m, m.logo!.storageKey, worker(new Map()));
    expect(state).toMatchObject({ found: true, saved: true, accessible: false, approved: false });
    const shown = brandView(view(m), state);
    expect(shown.checked && shown.hasLogo).toBe(false);
    expect(shown.checked && shown.logoMissing).toBe(true);
    expect(shown.checked && shown.logo).toBeNull();
  });

  it("an approval belongs to one file: a different saved logo is not approved", async () => {
    const objects = new Map<string, Buffer>();
    const m = manifest("vid_a", PNG(5));
    await worker(objects).put(m.logo!.storageKey, PNG(5), "image/png");
    expect((await logoState(m, brandStorageKey("vid_a", PNG(4), "png"), worker(objects))).approved).toBe(false);
  });

  it("puts a lost file back from where it came from, but only when what comes back is the same file", async () => {
    const m = manifest("vid_a", PNG(6));
    const lost = new Map<string, Buffer>();
    const same = await restoreManifestLogo(m, {}, { storage: worker(lost), fetchAsset: async () => ({ bytes: PNG(6), mime: "image/png" }) });
    expect(same).toBe(true);
    expect(await loadManifestLogo(m, worker(lost))).toEqual(PNG(6));

    const lostAgain = new Map<string, Buffer>();
    const different = await restoreManifestLogo(m, {}, { storage: worker(lostAgain), fetchAsset: async () => ({ bytes: PNG(7), mime: "image/png" }) });
    expect(different).toBe(false);
    expect(lostAgain.size).toBe(0);
  });

  it("restores an uploaded logo from the operator's own upload", async () => {
    const objects = new Map<string, Buffer>();
    const m = manifest("vid_a", PNG(8));
    m.logo!.origin = "upload";
    m.logo!.sourceUrl = "acme-logo.png";
    await worker(objects).put("video/vid_a/brand-upload-xyz.png", PNG(8), "image/png");
    expect(await restoreManifestLogo(m, { uploadKey: "video/vid_a/brand-upload-xyz.png" }, { storage: worker(objects) })).toBe(true);
  });

  it("a missing logo does not hold up a clean video, which shows none; the spoken name still has to be verified", () => {
    const noLogo = manifest("vid_a", null, { issues: [{ code: "logo_missing", severity: "blocking", field: "logo", message: "No logo could be verified.", resolution: "Upload one." }] });
    expect(brandBlockers(noLogo, "clean")).toBeNull();
    expect(brandBlockers(noLogo, "branded")).toMatch(/No logo could be verified/);
    const noName = manifest("vid_a", null, { issues: [{ code: "name_unverified", severity: "blocking", field: "name", message: "The company name is not verified.", resolution: "Type it." }] });
    expect(brandBlockers(noName, "clean")).toMatch(/company name is not verified/);
  });

  it("never reads one project's logo for another", async () => {
    const objects = new Map<string, Buffer>();
    await worker(objects).put(brandStorageKey("vid_b", PNG(9), "png"), PNG(9), "image/png");
    const m = manifest("vid_a", PNG(9));
    m.logo!.storageKey = brandStorageKey("vid_b", PNG(9), "png");
    expect(await loadManifestLogo(m, worker(objects))).toBeNull();
  });
});

// ------------------------------------------------------------------ the selected proof image stays the selected proof image

describe("the files a video was started with", () => {
  const objects = new Map<string, Buffer>();
  beforeEach(() => {
    objects.clear();
    process.env.ARK_API_KEY = "test-key";
    resetConfigCache();
    resetObjectStorage(worker(objects));
  });
  afterEach(() => {
    resetObjectStorage(null);
    delete process.env.ARK_API_KEY;
    resetConfigCache();
  });

  async function projectWithProof(name = "E-commerce Industries - 5.33M 7.png") {
    const { createProject, updateProject } = await import("@/lib/video/projects");
    const p = await createProject({ clientId: "c1", inputs: { landingPageUrl: "https://a.test", stats: [], targetSeconds: 20, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" } });
    const key = `video/${p.id}/img_proof.png`;
    await worker(objects).put(key, PNG(20), "image/png");
    const m = manifest(p.id, PNG(21));
    await worker(objects).put(m.logo!.storageKey, PNG(21), "image/png");
    await updateProject(p.id, {
      assets: [{ id: "img_proof", name, caption: "", role: "highlight", key, mime: "image/png", sha256: sha256(PNG(20)), bytes: 12, version: 1, purpose: "approved_proof_screenshot" }],
      chosen_script: script([scene(1, 5, "A proper review finds where budget is leaking."), scene(2, 5, "That process delivered 26.5 million in conversion value.", { stat: "26.5M Conv. value", assetId: "img_proof" })]),
      brand: { name: "Acme", colors: null, logoUrl: null, summary: null, manifest: m },
      status: "confirmed",
    });
    return { id: p.id, key };
  }

  it("are fixed by id, version, role and checksum when the video starts, with a clean finishing whatever was sent", async () => {
    const { startGeneration } = await import("@/lib/video/generation");
    const { id } = await projectWithProof();
    const started = await startGeneration(id, { captions: true, logo: true, endCard: true });
    expect(started.plan!.assets).toEqual([{ id: "img_proof", name: "E-commerce Industries - 5.33M 7.png", purpose: "approved_proof_screenshot", key: `video/${id}/img_proof.png`, mime: "image/png", version: 1, sha256: sha256(PNG(20)), bytes: 12 }]);
    expect(started.plan!.logo).toMatchObject({ sha256: sha256(PNG(21)), origin: "page" });
    expect(started.plan!.finishing).toEqual({ mode: "clean", captions: false, logo: false, endCard: false });
  });

  it("do not change when something else is uploaded to the project afterwards", async () => {
    const { startGeneration, viewGeneration } = await import("@/lib/video/generation");
    const { getProject, updateProject } = await import("@/lib/video/projects");
    const { id } = await projectWithProof();
    await startGeneration(id);
    // Later: a different screenshot is uploaded and the project's list now points at it.
    await worker(objects).put(`video/${id}/img_other.png`, PNG(30), "image/png");
    await updateProject(id, { assets: [{ id: "img_other", name: "another-dashboard.png", caption: "", role: "highlight", key: `video/${id}/img_other.png`, mime: "image/png", sha256: sha256(PNG(30)), bytes: 12, version: 1 }] });
    const now = (await getProject(id))!;
    expect(jobAssets(now).map((a) => a.name)).toEqual(["E-commerce Industries - 5.33M 7.png"]);
    const original = await loadOriginal(jobAssets(now)[0]!);
    expect(original.bytes).toEqual(PNG(20));
    // The job details show the actual selected file: its name, its thumbnail (this app's own route) and its checksum.
    const shown = viewGeneration(now).assets;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ name: "E-commerce Industries - 5.33M 7.png", purpose: "approved_proof_screenshot", sha256: sha256(PNG(20)), available: true });
    expect(shown[0]!.url).toMatch(new RegExp(`^/api/creatives/video/${id}/assets/img_proof\\?v=1-`));
    expect(shown[0]!.downloadUrl).toContain("download=1");
  });

  it("refuse a stored copy that is no longer the selected file, and a missing one, instead of substituting anything", async () => {
    const { startGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const { id, key } = await projectWithProof();
    await startGeneration(id);
    const snapshot = jobAssets((await getProject(id))!)[0]!;
    await worker(objects).put(key, PNG(40), "image/png"); // the bytes at that address were replaced
    await expect(loadOriginal(snapshot)).rejects.toThrow(/not the file that was selected/);
    objects.clear();
    await expect(loadOriginal(snapshot)).rejects.toThrow(/no longer in storage.*nothing else is used in its place/i);
  });

  it("are the same for a worker that starts after the video did", async () => {
    const { startGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const { id } = await projectWithProof();
    await startGeneration(id);
    resetObjectStorage(worker(objects)); // a restarted worker: a new adapter, the same bucket
    const resolved = await loadOriginal(jobAssets((await getProject(id))!)[0]!);
    expect(sha256(resolved.bytes)).toBe(sha256(PNG(20)));
  });

  it("stay apart for two projects made at the same time, even with the same file name", async () => {
    const { startGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const a = await projectWithProof("results.png");
    const b = await projectWithProof("results.png");
    await worker(objects).put(b.key, PNG(50), "image/png");
    const { updateProject } = await import("@/lib/video/projects");
    const pb = (await getProject(b.id))!;
    await updateProject(b.id, { assets: [{ ...pb.assets[0]!, sha256: sha256(PNG(50)) }] });
    await Promise.all([startGeneration(a.id), startGeneration(b.id)]);
    const [sa, sb] = [jobAssets((await getProject(a.id))!)[0]!, jobAssets((await getProject(b.id))!)[0]!];
    expect(sa.key).toContain(a.id);
    expect(sb.key).toContain(b.id);
    expect(sa.sha256).not.toBe(sb.sha256);
    expect((await loadOriginal(sa)).bytes).toEqual(PNG(20));
    expect((await loadOriginal(sb)).bytes).toEqual(PNG(50));
  });

  it("record a file that could not be read at the start as missing, never as present", async () => {
    const snap = await snapshotAssets([{ id: "img_x", name: "gone.png", caption: "", role: "show", key: "video/vid_z/img_x.png", mime: "image/png" }], worker(new Map()));
    expect(snap[0]).toMatchObject({ sha256: null, bytes: null });
  });
});

// ------------------------------------------------------------------ clean is the default and cannot be switched on by accident

describe("clean video is the default", () => {
  it("adds nothing to the picture unless graphics are asked for by name", () => {
    const clean = { mode: "clean", captions: false, logo: false, endCard: false };
    expect(resolveFinishing()).toEqual(clean);
    expect(resolveFinishing(null, undefined)).toEqual(clean);
    // What an older video stored, or an older screen still sends: the flags alone never turn a graphic on.
    expect(resolveFinishing({ captions: true, logo: true, endCard: true })).toEqual(clean);
    expect(resolveFinishing({ captions: true, logo: true, endCard: true }, { captions: true })).toEqual(clean);
    expect(resolveFinishing({ mode: "clean" }, { captions: true, logo: true, endCard: true })).toEqual(clean);
    expect(resolveFinishing({ mode: "branded", captions: true, logo: true, endCard: true }, { mode: "clean" })).toEqual(clean);
    expect(resolveFinishing({ mode: "branded", captions: true, logo: false, endCard: true })).toEqual({ mode: "branded", captions: true, logo: false, endCard: true });
  });

  it("tells an older export (graphics burned in) from a clean one", () => {
    expect(exportMode({ mode: "clean" })).toBe("clean");
    expect(exportMode({})).toBe("branded");
    expect(exportMode(null)).toBe("branded");
  });
});

// ------------------------------------------------------------------ where the generated text came from: the words of the plan and the prompt

/** The third scene of the video this change answers, as its plan was written: the plan's own words asked for the graphics. */
const legacyBrief = (over: Partial<SceneBrief> = {}): SceneBrief => ({
  number: 3,
  purpose: "Proof",
  informationAdded: "The result",
  narration: "In the results, that process delivered 26.5 million in conversion value.",
  subject: "Presenter with composited dashboard asset occupying the right half of frame",
  setting: "Lighter consultation-style corner, warm bookshelf behind",
  action: "Presenter extends one open hand toward the composited asset on screen right, palm up",
  framing: "Medium shot, eye level, presenter on the left third, asset occupying the right two-thirds",
  camera: "Very slow push-in. It draws the viewer's eye toward the asset without a jarring move",
  lighting: "Warm overhead fill from above-right",
  style: "",
  characterId: "char_presenter",
  environmentId: "env_consult",
  requiredAssets: [{ assetId: "img_LQK0hUfl", use: "overlay_inset" }],
  overlays: [{ kind: "stat", text: "26.5M Conv. value (Sales Revenue)", claimId: "claim_3" }],
  screenTreatment: "composite_verified_asset",
  seconds: 6,
  durationBasis: "speech",
  entry: { mode: "cut", condition: "" },
  exit: { condition: "Presenter holds the gesture" },
  transition: { kind: "cut", rationale: "" },
  risks: ["hands"],
  acceptance: [
    "Dashboard asset (img_LQK0hUfl) is visible as an inset on the right side of frame, not obscuring the presenter's face",
    "Stat overlay '26.5M Conv. value (Sales Revenue)' appears and is legible",
    "CTA overlay 'Book Your Free Audit' is fully legible in the lower third",
    "Keywords 'budget leaking' and 'earning more' appear as overlays timed to the spoken words",
    "Presenter's open hand is held steady",
  ],
  ...over,
});

const promptFor = (brief: SceneBrief, clean: boolean, clip = { number: 1, count: 1 }) =>
  buildPlannedClipPrompt({
    scenes: [brief],
    spoken: { [brief.number]: { text: "In the results, that process delivered twenty six point five million in conversion value.", speaker: "on_camera" } },
    characters: [{ id: "char_presenter", description: "Australian man, late 30s, blue open-collar shirt", role: "Presenter" }],
    environments: [{ id: "env_consult", description: "Warm consultation corner", sceneNumbers: [3] }],
    style: "Presenter to camera with composited proof asset",
    clipNumber: clip.number,
    clipCount: clip.count,
    locale: "en-AU",
    refs: { characterIds: ["char_presenter"], environmentIds: ["env_consult"], previousFrame: false, previousVideo: false },
    corrections: [],
    nextContinues: false,
    clean,
  });

describe("what the video model is asked for", () => {
  it("before: the prompt itself told the model to show the overlays, the stat and a dashboard (the cause of the text inside the clips)", () => {
    const before = promptFor(legacyBrief(), false);
    expect(before).toMatch(/Stat overlay '26\.5M Conv\. value \(Sales Revenue\)' appears and is legible/);
    expect(before).toMatch(/composited dashboard asset occupying the right half of frame/);
    expect(before).toMatch(/A graphic is added over this shot afterwards/);
  });

  it("clean: nothing about a graphic reaches the model, even from a plan written before clean video existed", () => {
    const prompt = promptFor(legacyBrief(), true);
    expect(prompt).not.toMatch(/overlay|composit|inset|legible|img_LQK0hUfl|Book Your Free Audit|budget leaking|26\.5M|Sales Revenue|proof asset|graphic is added|added afterwards|for a Meta ad/i);
    // The shot itself asks for no dashboard or asset (the word survives only in the rule that forbids them).
    expect(prompt.split(/\n/).find((l) => l.startsWith("0s-6s"))).not.toMatch(/dashboard|asset|screen/i);
    expect(prompt).toContain("Presenter's open hand is held steady");
    expect(prompt).toContain(CLEAN_FOOTAGE_RULE);
    // A field that had to be dropped is replaced by a plain description, never left as a gap.
    expect(prompt).not.toMatch(/ of {2}| of \.| in \.|Action: \./);
    expect(prompt).toMatch(/Shot 3\. .+ of the person in Lighter consultation-style corner/);
  });

  it("the spoken line is passed on exactly, once, as speech, and never as something to display", () => {
    const prompt = promptFor(legacyBrief(), true);
    const line = 'says, in real time: "In the results, that process delivered twenty six point five million in conversion value."';
    expect(prompt.split(line)).toHaveLength(2);
    expect(prompt).toMatch(/The spoken words are heard, never shown/);
    // A line that happens to contain a word like "logo" or "caption" is still spoken in full.
    const spoken = buildPlannedClipPrompt({ ...baseInput(), spoken: { 3: { text: "Your logo and your caption both matter.", speaker: "on_camera" } } });
    expect(spoken).toContain('"Your logo and your caption both matter."');
  });

  it("ends the last clip on a natural close, and only the last clip", () => {
    expect(promptFor(legacyBrief(), true, { number: 2, count: 2 })).toContain(CLEAN_ENDING_RULE);
    expect(promptFor(legacyBrief(), true, { number: 1, count: 2 })).not.toContain(CLEAN_ENDING_RULE);
    expect(CLEAN_ENDING_RULE).toMatch(/does not end mid-word, on a frozen face, or on a cut to a card, text or logo/);
  });

  function baseInput() {
    return {
      scenes: [legacyBrief()],
      spoken: {},
      characters: [{ id: "char_presenter", description: "A man in a blue shirt", role: "Presenter" }],
      environments: [{ id: "env_consult", description: "Warm corner", sceneNumbers: [3] }],
      style: "Cinematic",
      clipNumber: 1,
      clipCount: 1,
      locale: "en-AU",
      refs: { characterIds: [], environmentIds: [], previousFrame: false, previousVideo: false },
      corrections: [],
      nextContinues: false,
      clean: true,
    };
  }

  it("recognises wording that asks for a graphic, and wording that rules one out", () => {
    expect(graphicReference("Keyword overlays 'free' and 'yours to keep' appear at the correct spoken moments")).toBeTruthy();
    expect(graphicReference("CTA overlay 'Book Your Free Audit' is fully legible in the lower third")).toBeTruthy();
    expect(graphicReference("Presenter gestures toward the screenshot beside them")).toBeTruthy();
    expect(graphicReference("No readable text, logos or captions are visible in the footage")).toBeNull();
    expect(graphicReference("Presenter holds eye contact with the lens")).toBeNull();
    expect(graphicReference("Open-collar shirt, buttons undone at the neck")).toBeNull();
    expect(footageOnly(["Eyes are directed at lens", "The words 'spent' and 'lost' appear as keyword overlays"])).toEqual(["Eyes are directed at lens"]);
    expect(stripGraphicPhrases("Presenter to camera with composited proof asset")).toBe("Presenter to camera");
    expect(stripGraphicPhrases("Cinematic, warm and natural")).toBe("Cinematic, warm and natural");
  });
});

// ------------------------------------------------------------------ the plan: dialogue, footage and editing notes are separate fields

const PLAN_INPUT: PlanInput = {
  mode: "clean",
  brandName: "Acme",
  product: "Free audit",
  audience: "Store owners",
  offer: "Free audit",
  platform: "Reels",
  objective: "Proof",
  targetSeconds: 10,
  locale: "en-AU",
  script: {
    style: "Presenter to camera with composited proof asset",
    character: "A man in a blue shirt",
    setting: "An office",
    scenes: [
      { number: 1, line: "A proper review finds where budget is leaking.", seconds: 5, speaker: "on_camera", keywords: ["budget leaking"], stat: null, assetId: null, visual: "Presenter to camera", camera: "Static", sound: "" },
      { number: 2, line: "That process delivered 26.5 million in conversion value.", seconds: 5, speaker: "on_camera", keywords: ["26.5 million"], stat: "26.5M Conv. value", assetId: "img_proof", visual: "Presenter gestures toward the composited screenshot beside them", camera: "Slow push", sound: "" },
    ],
  },
  assets: [{ id: "img_proof", name: "E-commerce Industries - 5.33M 7.png", summary: "A Google Ads dashboard", stats: [{ value: "26.5M", label: "Conv. value" }] }],
  claims: [{ id: "claim_3", text: "26.5M Conv. value", kind: "number", figure: "26.5M", evidence: "printed", provenance: { source: "image_reading", detail: "Read from the uploaded image", confidence: "medium" }, assetId: "img_proof" }],
  capabilities: { referenceImages: true, firstLastFrame: true, nativeAudio: true, ssml: false, phonemeDictionary: false, lipSync: "native_model_audio", transcription: true, visionReview: true, perspectiveScreenTracking: false, gaps: ["Screens are composited flat (a verified screenshot placed over footage)."] },
  maxSeconds: 60,
};

type RawScene = PlanModelOutput["scenes"][number];
const rawScene = (n: 1 | 2, over: Partial<RawScene> = {}): RawScene => ({
  number: n,
  purpose: n === 1 ? "Name the mechanism" : "Give the proof",
  informationAdded: n === 1 ? "A review locates wasted spend" : "The size of the outcome one account reached",
  narration: PLAN_INPUT.script.scenes[n - 1]!.line,
  subject: n === 1 ? "The presenter, chest up" : "The presenter, waist up, beside a bookshelf",
  setting: n === 1 ? "A quiet office by a window" : "A warm corner with a low bookshelf",
  action: n === 1 ? "He shifts his weight and opens one hand" : "He nods once, slowly, as he finishes the line",
  framing: n === 1 ? "Medium close-up at eye level" : "Medium shot, slightly left of centre",
  camera: "Static, held for the directness of the line",
  lighting: "Soft window light from the left",
  style: "Natural, unpolished realism",
  characterId: "char_presenter",
  environmentId: n === 1 ? "env_office" : "env_corner",
  requiredAssets: [],
  overlays: [],
  screenTreatment: n === 1 ? "none" : "footage_without_screen",
  seconds: 5,
  durationBasis: "The spoken line plus a beat",
  entry: { mode: "cut", condition: "Cut in on the first word" },
  exit: { condition: n === 1 ? "He settles as the line ends" : "He finishes the last word, then holds a relaxed expression for a second" },
  transition: { kind: "cut", rationale: "" },
  risks: ["A hand gesture may distort"],
  acceptance: ["The presenter looks at the lens"],
  editingNotes: [],
  ...over,
});
const rawPlan = (scenes: RawScene[]): PlanModelOutput => ({
  narrative: { approach: "One person, two rooms", whyItFits: "Direct proof", arc: ["mechanism", "proof"] },
  characters: [{ id: "char_presenter", description: "A man in his late 30s in a blue shirt", role: "Presenter" }],
  environments: [
    { id: "env_office", description: "A quiet office by a window", sceneNumbers: [1] },
    { id: "env_corner", description: "A warm corner with a low bookshelf", sceneNumbers: [2] },
  ],
  scenes,
});
const CTX = { scriptScenes: PLAN_INPUT.script.scenes, assetIds: ["img_proof"], claimIds: ["claim_3"], maxSeconds: 60, claims: PLAN_INPUT.claims, mode: "clean" as const };
const errorCodes = (plan: PlanModelOutput) => validatePlan(normalisePlan(plan, PLAN_INPUT, "now"), CTX).filter((i) => i.severity === "error").map((i) => i.code);

describe("the creative plan of a clean video", () => {
  it("tells the planner the footage is the whole picture and keeps suggestions in a field of their own", () => {
    const prompt = planPrompt(PLAN_INPUT);
    expect(prompt).toMatch(/THIS IS A CLEAN VIDEO/);
    expect(prompt).toMatch(/never shown in this video and never recreated or imitated/);
    expect(prompt).toMatch(/spoken line \(heard, never displayed\)/);
    expect(prompt).toMatch(/editingNotes/);
    expect(prompt).not.toMatch(/Those are composited by the renderer|the renderer can composite these|stat to show|uploaded asset to show|keywords highlighted|composited proof asset/);
    // The writer's visual pointed at a screenshot: the planner is told to design the shot afresh instead of being handed it.
    expect(prompt).not.toContain("gestures toward the composited screenshot");
    expect(hardRulesFor({ mode: "clean" }).join(" ")).toMatch(/The last scene is the ending of the film itself, because no end card follows it/);
    expect(hardRulesFor({}).join(" ")).toMatch(/Those are composited by the renderer/);
  });

  it("accepts a plan that describes only filmed footage", () => {
    expect(errorCodes(rawPlan([rawScene(1), rawScene(2)]))).toEqual([]);
  });

  it("sends a plan back when a footage field mentions a graphic, a screen to read, or a frozen ending", () => {
    expect(errorCodes(rawPlan([rawScene(1), rawScene(2, { subject: "Presenter with composited dashboard asset on the right half of frame" })]))).toEqual(expect.arrayContaining(["graphic_in_footage", "text_in_footage"]));
    expect(errorCodes(rawPlan([rawScene(1, { action: "He points at the caption beside him" }), rawScene(2)]))).toContain("graphic_in_footage");
    expect(errorCodes(rawPlan([rawScene(1), rawScene(2, { exit: { condition: "CTA is visible; clip ends on a held frame" } })]))).toEqual(expect.arrayContaining(["graphic_in_footage", "ending_not_natural"]));
    expect(errorCodes(rawPlan([rawScene(1), rawScene(2, { exit: { condition: "Cuts to the end card" } })]))).toContain("ending_not_natural");
  });

  it("turns anything the model listed as a graphic into an editing note, so it can never be composited or shown to the video model", () => {
    const plan = normalisePlan(
      rawPlan([
        rawScene(1, { overlays: [{ kind: "keyword", text: "budget leaking", claimId: null, assetId: null }], acceptance: ["Eyes at lens", "Keyword 'budget leaking' appears as an overlay"] }),
        rawScene(2, { requiredAssets: [{ assetId: "img_proof", use: "overlay_inset" }], overlays: [{ kind: "stat", text: "26.5M Conv. value", claimId: "claim_3", assetId: null }], screenTreatment: "composite_verified_asset" }),
      ]),
      PLAN_INPUT,
      "now",
    );
    expect(plan.mode).toBe("clean");
    for (const s of plan.scenes) {
      expect(s.overlays).toEqual([]);
      expect(s.requiredAssets).toEqual([]);
      expect(s.screenTreatment).not.toBe("composite_verified_asset");
      expect(s.acceptance.some((a) => /overlay/i.test(a))).toBe(false);
    }
    expect(plan.scenes[0]!.editingNotes).toEqual([{ kind: "keyword", text: "budget leaking" }]);
    expect(plan.scenes[1]!.editingNotes).toEqual([{ kind: "stat", text: "26.5M Conv. value", claimId: "claim_3" }, { kind: "image", assetId: "img_proof" }]);
  });

  it("keeps a suggested figure tied to an approved claim", () => {
    const withFigure = (note: RawScene["editingNotes"][number]) => errorCodes(rawPlan([rawScene(1), rawScene(2, { editingNotes: [note] })]));
    expect(withFigure({ kind: "stat", text: "26.5M Conv. value", claimId: "claim_3", assetId: null, position: null, note: null })).toEqual([]);
    expect(withFigure({ kind: "stat", text: "31M in sales", claimId: "claim_3", assetId: null, position: null, note: null })).toContain("stat_unsupported");
    expect(withFigure({ kind: "stat", text: "26.5M Conv. value", claimId: null, assetId: null, position: null, note: null })).toContain("stat_without_claim");
    expect(withFigure({ kind: "image", text: null, claimId: null, assetId: "img_unknown", position: null, note: null })).toContain("unknown_asset");
  });

  it("repairs a plan that asked for graphics before any clip is paid for", async () => {
    const bad = rawPlan([rawScene(1), rawScene(2, { action: "He gestures toward the stat overlay as it appears" })]);
    const good = rawPlan([rawScene(1), rawScene(2)]);
    const generate = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good);
    const plan = await planCreative(PLAN_INPUT, { generate, now: () => "now" });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(String(generate.mock.calls[1]![0])).toMatch(/graphic_in_footage/);
    expect(plan.validation.ok).toBe(true);
    expect(plan.mode).toBe("clean");
  });
});

// ------------------------------------------------------------------ narration that pointed at the screenshot

describe("a spoken line that points at an image the clean video does not show", () => {
  const LINE = "In the results shown here, that process delivered 26.5 million in conversion value.";

  it("is recognised", () => {
    expect(pointingPhrase(LINE)).toBe("shown here");
    expect(pointingPhrase("As you can see here, spend fell by 40%.")).toMatch(/as you can see/i);
    expect(pointingPhrase("Look at these numbers.")).toBeTruthy();
    expect(pointingPhrase("Book your free audit and see exactly where your budget is going.")).toBeNull();
    expect(pointingPhrase("In these results, that process delivered 26.5 million.")).toBeNull();
  });

  it("is reworded so the video stands on its own, keeping every figure", async () => {
    const withoutModel = await makeNarrationStandalone(script([scene(1, 5, "A proper review finds the leaks."), scene(2, 6, LINE, { stat: "26.5M", assetId: "img_proof" })]), { reword: async () => null });
    expect(withoutModel.changes).toEqual([{ scene: 2, was: LINE, now: "In the results, that process delivered 26.5 million in conversion value.", reason: expect.stringContaining("shown here") }]);
    expect(withoutModel.script.scenes[1]).toMatchObject({ line: "In the results, that process delivered 26.5 million in conversion value.", originalLine: LINE, assetId: "img_proof" });
    expect(cutPointingPhrase("As you can see here, spend fell by 40%.")).toBe("Spend fell by 40%.");

    const withModel = await makeNarrationStandalone(script([scene(1, 6, LINE)]), { reword: async () => "For one account, that process delivered 26.5 million in conversion value." });
    expect(withModel.script.scenes[0]!.line).toBe("For one account, that process delivered 26.5 million in conversion value.");
  });

  it("does not take a rewording that changes a figure, adds one, or still points at the screen", async () => {
    expect(acceptableStandalone(LINE, "That process delivered 27 million in conversion value.")).toBe(false);
    expect(acceptableStandalone(LINE, "That process delivered 26.5 million in conversion value, a 497% return.")).toBe(false);
    expect(acceptableStandalone(LINE, "As you can see, that process delivered 26.5 million in conversion value.")).toBe(false);
    const fell = await makeNarrationStandalone(script([scene(1, 6, LINE)]), { reword: async () => "That process delivered 30 million." });
    expect(fell.script.scenes[0]!.line).toBe("In the results, that process delivered 26.5 million in conversion value.");
  });

  it("reports a line it cannot reword instead of generating from it", async () => {
    const out = await makeNarrationStandalone(script([scene(1, 3, "Look at this chart.")]), { reword: async () => null });
    expect(out.unresolved).toEqual([{ scene: 1, line: "Look at this chart.", phrase: expect.stringMatching(/look at this chart/i) }]);
    expect(out.changes).toEqual([]);
  });
});

// ------------------------------------------------------------------ the checker: it still catches text, and knows what a clean video is

describe("the clip inspection", () => {
  const seen = (textSeen: VisionResult["textSeen"]): VisionResult => ({ observations: [], textSeen, faceConsistent: true, summary: "" });

  it("still rejects text and graphics drawn into the footage", () => {
    const findings = visionToFindings(
      seen([
        { text: "budget leaking", atSeconds: 11.4, kind: "word", placement: "graphic", prominence: "prominent" },
        { text: "Book Your Free Audit", atSeconds: 18, kind: "word", placement: "graphic", prominence: "prominent" },
        { text: "269%", atSeconds: 0, kind: "number", placement: "graphic", prominence: "prominent" },
        { text: "dashboard panel", atSeconds: 0, kind: "ui", placement: "scene", prominence: "incidental" },
      ]),
      [],
    );
    expect(findings.map((f) => [f.code, f.severity])).toEqual([["fabricated_text", "critical"], ["fabricated_text", "critical"], ["fabricated_text", "critical"], ["fabricated_text", "critical"]]);
    expect(decideClip(findings, { attempt: 1, maxAttempts: 3, spentUsd: 1, budgetUsd: 10, nextAttemptUsd: 1, visionAvailable: true, requireVision: true }).verdict).toBe("retry");
  });

  it("an inspector that says nothing about prominence is treated as before: any text is rejected", () => {
    expect(visionToFindings(seen([{ text: "OPEN", atSeconds: 1, kind: "word" }]), [])[0]).toMatchObject({ code: "fabricated_text", severity: "critical" });
  });

  it("notes a small background detail without paying for the shot again", () => {
    const findings = visionToFindings(seen([{ text: "a blurred book spine", atSeconds: 3, kind: "gibberish", placement: "scene", prominence: "incidental" }]), []);
    expect(findings).toEqual([expect.objectContaining({ code: "incidental_text", severity: "minor" })]);
    expect(decideClip(findings, { attempt: 1, maxAttempts: 3, spentUsd: 1, budgetUsd: 10, nextAttemptUsd: 1, visionAvailable: true, requireVision: true }).verdict).toBe("pass");
  });

  it("asks the inspector to tell a graphic from an incidental detail", () => {
    const rubric = visionRubric({ scenes: [], characterDescription: null, expectsSpeech: true, allowedText: [] });
    expect(rubric).toMatch(/placement = graphic when it is drawn OVER the picture/);
    expect(rubric).toMatch(/prominence = incidental ONLY when/);
  });
});

describe("the final inspection of a clean video", () => {
  const input = (over: Partial<FinalQaInput> = {}): FinalQaInput => ({
    file: "x.mp4",
    workDir: ".",
    attempt: 1,
    seconds: 37.1,
    endCardSeconds: 0,
    clean: true,
    manifest: { name: { value: "Acme", provenance: [] }, logo: null, internalLabels: [{ value: "TR Internal Version 1", provenance: prov }], allowTextOnlyBrand: false, claims: [], cta: { value: { label: "Book a free audit" }, provenance: [] }, offer: { value: null, provenance: [] } },
    expected: { brandName: null, ctaLabel: null, claimTexts: [], captionTexts: [], allowedOverlayText: [] },
    cues: [],
    expectsLogo: false,
    asr: null,
    ...over,
  });
  const vision = (over: Partial<FinalVisionResult> = {}): FinalVisionResult => ({ textSeen: [], logoSeen: [], captionIssues: [], summary: "", ending: { state: "composed", detail: "relaxed, mouth closed" }, ...over });

  it("does not ask for a logo, captions, a brand name or an end card: their absence is correct", () => {
    expect(cleanFindings(input(), vision())).toEqual([]);
  });

  it("fails on a subtitle, a headline, a logo or a card in the picture, whoever drew it", () => {
    const codes = cleanFindings(
      input(),
      vision({
        textSeen: [
          { text: "see exactly where your budget is going.", atSeconds: 36.9, region: "caption", legible: true, prominence: "prominent" },
          { text: "Book Your Free Audit", atSeconds: 36.9, region: "overlay", legible: true, prominence: "prominent" },
          { text: "TrafficRadius Learn More", atSeconds: 38, region: "end_card", legible: true, prominence: "prominent" },
          { text: "269%", atSeconds: 16.9, region: "footage", legible: true, prominence: "prominent" },
        ],
        logoSeen: [{ atSeconds: 2, matchesReference: null, region: "overlay" }],
      }),
    ).map((f) => [f.code, f.severity]);
    expect(codes).toEqual([["graphic_in_clean_video", "critical"], ["graphic_in_clean_video", "critical"], ["graphic_in_clean_video", "critical"], ["fabricated_text", "critical"], ["invented_branding", "critical"]]);
  });

  it("does not fail on an incidental background detail", () => {
    const findings = cleanFindings(input(), vision({ textSeen: [{ text: "EXIT", atSeconds: 4, region: "footage", legible: true, prominence: "incidental" }] }));
    expect(findings).toEqual([expect.objectContaining({ code: "incidental_text", severity: "minor" })]);
  });

  it("checks the ending is a natural close: not cut off mid-word, not frozen, not a card", () => {
    expect(cleanFindings(input(), vision({ ending: { state: "card_or_text", detail: "a green card with the company name" } }))[0]).toMatchObject({ code: "ending_card", severity: "major" });
    expect(cleanFindings(input(), vision({ ending: { state: "mid_speech", detail: "mouth open" } }))[0]).toMatchObject({ code: "ending_cut_off" });
    expect(cleanFindings(input(), vision({ ending: { state: "frozen_or_distorted", detail: "smeared face" } }))[0]).toMatchObject({ code: "ending_frozen" });
    expect(endingFromAudio(37.1, [{ word: "going", start: 36.6, end: 37.05 }])[0]).toMatchObject({ code: "ending_cut_off", severity: "major" });
    expect(endingFromAudio(37.1, [{ word: "going", start: 35.4, end: 36.0 }])).toEqual([]);
  });

  it("looks across the whole film and closely at its last second", () => {
    const times = finalFrameTimes({ seconds: 37.1, endCardSeconds: 0, cues: [{ start: 1, end: 2, text: "x" }], clean: true });
    expect(times.filter((t) => t.note === "the ending").length).toBe(3);
    expect(times.some((t) => /caption/.test(t.note))).toBe(false);
    expect(finalRubric({ endCardSeconds: 0, hasLogoReference: false, clean: true })).toMatch(/must contain NO subtitles, captions, highlighted words/);
  });
});

// ------------------------------------------------------------------ the manual override is kept, and recorded as what it is

describe("approving a result the inspection did not", () => {
  beforeEach(() => {
    resetObjectStorage(worker(new Map()));
  });
  afterEach(() => resetObjectStorage(null));

  const finding = (code: string, severity: "critical" | "major" | "minor", message: string) => ({ code, severity, category: "text" as const, message, evidence: "", correction: "", source: "vision" as const });

  async function blockedProject() {
    const { createProject, updateProject } = await import("@/lib/video/projects");
    const p = await createProject({ clientId: "c1", inputs: { stats: [], targetSeconds: 20, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" } });
    const report = { subject: { kind: "final" as const }, attempt: 1, checkedAt: "t", verdict: "unresolved" as const, findings: [finding("fabricated_text", "critical", 'Readable text ("269%") appears inside the footage.'), finding("unexpected_text", "major", "Text on screen is not part of the approved copy."), finding("subtitle_too_short", "minor", "Cue 2 is brief.")], checks: [], framesInspected: 12, limitations: [] };
    const clip = { number: 1, seconds: 6, sceneNumbers: [1], status: "failed" as const, taskId: null, attempts: 1, error: "did not pass", videoKey: "video/p/clip-1.mp4", lastFrameUrl: null, sourceVideoUrl: null, finishedAt: "t", tokens: 1, usd: 1, prompt: null, unresolved: true, qa: { ...report, subject: { kind: "clip" as const, clip: 1 }, verdict: "retry" as const }, decision: { verdict: "retry" as const, summary: "text in the footage", estimateUsd: 1, addSeconds: 0, corrections: [], inspectionFailed: false, at: "t" } };
    await updateProject(p.id, {
      status: "paused",
      plan: { model: "seedance-2-0", modelLabel: "x", resolution: "720p", ratio: "9:16", format: "9:16", reasons: [], estimatedUsd: 1, character: null, setting: null, chainVideo: false, finishing: { mode: "clean", captions: false, logo: false, endCard: false }, checkpoint: "none", createdAt: "t" },
      clips: [clip],
      final: { state: "blocked", stage: null, error: "Not approved for delivery", startedAt: "t", key: null, reviewKey: "video/p/final-1.mp4", seconds: 37, width: 1080, height: 1920, bytes: 1, createdAt: "t", qa: [], includes: null, report, mode: "clean" },
    });
    return p.id;
  }

  it("still lets the operator deliver a blocked export, and records who, when and exactly what was open", async () => {
    const { acceptBlockedFinal, viewGeneration } = await import("@/lib/video/generation");
    const id = await blockedProject();
    const done = await acceptBlockedFinal(id, "user_1");
    expect(done.status).toBe("done");
    expect(done.final).toMatchObject({ state: "done", key: "video/p/final-1.mp4", reviewKey: null, acceptedAnyway: true });
    expect(done.final!.override).toMatchObject({ by: "user_1", findings: [{ code: "fabricated_text", severity: "critical" }, { code: "unexpected_text", severity: "major" }] });
    expect(done.final!.override!.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The findings stay on the video, and it is never reported as having passed.
    expect(done.final!.report!.findings).toHaveLength(3);
    const view = viewGeneration(done).final!;
    expect(view.checkStatus).toBe("approved_despite_warnings");
    expect(view.videoUrl).toBeTruthy();
  });

  it("nothing but that request turns a blocked export into a delivered one", async () => {
    const { viewGeneration, continueGeneration } = await import("@/lib/video/generation");
    const { getProject } = await import("@/lib/video/projects");
    const id = await blockedProject();
    await continueGeneration(id);
    const p = (await getProject(id))!;
    expect(p.final!.state).toBe("blocked");
    expect(p.final!.acceptedAnyway).toBeUndefined();
    const view = viewGeneration(p).final!;
    expect(view.checkStatus).toBe("issues");
    expect(view.videoUrl).toBeNull();
  });

  it("lets the operator use a clip as it is, recorded the same way", async () => {
    const { resolveDecision, viewGeneration } = await import("@/lib/video/generation");
    const id = await blockedProject();
    const next = await resolveDecision(id, 1, "use", "user_1");
    const clip = next.clips![0]!;
    expect(clip).toMatchObject({ status: "succeeded", acceptedWithIssues: true, decision: null });
    expect(clip.override).toMatchObject({ by: "user_1", findings: [{ code: "fabricated_text" }, { code: "unexpected_text" }] });
    expect(viewGeneration(next).clips[0]!.checkStatus).toBe("approved_despite_warnings");
  });

  it("tells passed, issues detected and approved despite warnings apart", async () => {
    const { clipCheckStatus, finalCheckStatus, overrideRecord } = await import("@/lib/video/generation");
    const qa = (verdict: "pass" | "retry") => ({ subject: { kind: "clip" as const, clip: 1 }, attempt: 1, checkedAt: "t", verdict, findings: [], checks: [], framesInspected: 8, limitations: [] });
    expect(clipCheckStatus({ status: "succeeded", qa: qa("pass") })).toBe("passed");
    expect(clipCheckStatus({ status: "failed", qa: qa("retry"), unresolved: true })).toBe("issues");
    expect(clipCheckStatus({ status: "succeeded", qa: qa("retry"), acceptedWithIssues: true })).toBe("approved_despite_warnings");
    expect(clipCheckStatus({ status: "succeeded", qa: null })).toBe("unchecked");
    expect(finalCheckStatus({ state: "done", report: { ...qa("pass"), subject: { kind: "final" } } })).toBe("passed");
    expect(finalCheckStatus({ state: "blocked", report: null })).toBe("issues");
    expect(finalCheckStatus({ state: "done", report: { ...qa("pass"), subject: { kind: "final" } }, acceptedAnyway: true })).toBe("approved_despite_warnings");
    // An inspection that never ran is recorded as that, not as an empty list of problems.
    expect(overrideRecord([], ["visual review failed: no credit"], "user_1", "t").findings).toEqual([{ code: "not_inspected", severity: "major", message: expect.stringContaining("no credit") }]);
  });
});

// ------------------------------------------------------------------ the figure stays tied to its source

describe("the uploaded results screenshot", () => {
  /** What is printed in "E-commerce Industries - 5.33M 7.png": the tool's own labels, the labels added on top, the selected period and the added note. */
  const IMAGE: EvidenceReading = {
    stats: [
      { value: "$5.33M", label: "Cost", annotationLabel: "Ad Spent" },
      { value: "$22.40", label: "Cost / conv." },
      { value: "26.5M", label: "Conv. value", annotationLabel: "Sales Revenue" },
      { value: "4.97", label: "Conv. value / cost", annotationLabel: "ROAS" },
    ],
    dateRange: "1 June 2025 – 31 May 2026",
    annotations: ["In <1 year"],
    currencyCode: null,
  };

  it("keeps ad spend, conversion value, sales revenue, cost per conversion and value per cost apart", () => {
    expect(IMAGE.stats.map((s) => metricOf(s.label))).toEqual(["ad_spend", "cost_per_conversion", "conversion_value", "conversion_value_per_cost"]);
    expect(metricOf("Sales Revenue")).toBe("sales_revenue");
    expect(metricOf("Ad Spent")).toBe("ad_spend");
    expect(metricOf("ROAS")).toBe("conversion_value_per_cost");
  });

  it("flags that 26.5M is labelled conversion value by the dashboard and sales revenue only by the added note", () => {
    const cautions = evidenceCautions(IMAGE);
    const label = cautions.filter((c) => c.code === "label_differs");
    expect(label).toHaveLength(1);
    expect(label[0]).toMatchObject({ figure: "26.5M" });
    expect(label[0]!.message).toMatch(/"Conv\. value".*"Sales Revenue".*not independently verified sales revenue/);
  });

  it("flags the time claim: the selected period is a full year, not less than one", () => {
    expect(rangeDays(IMAGE.dateRange)).toBe(365);
    expect(timeClaim("In <1 year")).toMatchObject({ days: 365, under: true });
    const time = evidenceCautions(IMAGE).find((c) => c.code === "time_claim_unsupported");
    expect(time!.message).toMatch(/"In <1 year".*1 June 2025 – 31 May 2026 \(365 days\).*Do not repeat the time claim until it is confirmed/);
    // A shorter period would support it.
    expect(evidenceCautions({ ...IMAGE, dateRange: "1 June 2025 – 30 November 2025" }).some((c) => c.code === "time_claim_unsupported")).toBe(false);
  });

  it("does not take the dollar sign for a currency", () => {
    expect(evidenceCautions(IMAGE).find((c) => c.code === "currency_unstated")!.message).toMatch(/prints "\$" without naming the currency/);
    expect(evidenceCautions({ ...IMAGE, currencyCode: "AUD" }).some((c) => c.code === "currency_unstated")).toBe(false);
  });

  it("reads an image stored the earlier way, with both labels in one string", () => {
    expect(splitLabel({ value: "26.5M", label: "Conv. value (Sales Revenue)" })).toEqual({ label: "Conv. value", annotationLabel: "Sales Revenue" });
    const old = evidenceCautions({ stats: [{ value: "$5.33M", label: "Cost (Ad Spent)" }, { value: "26.5M", label: "Conv. value (Sales Revenue)" }, { value: "4.97", label: "Conv. value / cost (ROAS)" }] });
    expect(old.filter((c) => c.code === "label_differs").map((c) => c.figure)).toEqual(["26.5M"]);
  });

  it("flags narration that goes beyond the image, and leaves alone narration that does not", () => {
    expect(narrationCautions([{ sceneNumber: 3, text: "In the results, that process delivered 26.5 million in conversion value." }], [IMAGE])).toEqual([]);
    const over = narrationCautions([{ sceneNumber: 3, text: "That delivered 26.5 million in sales revenue in under a year, in Australian dollars." }], [IMAGE]);
    expect(over.join(" ")).toMatch(/speaks of 26\.5M as sales or revenue/);
    expect(over.join(" ")).toMatch(/"in under a year".*does not support/);
    expect(over.join(" ")).toMatch(/names a currency/);
  });

  it("records each figure as what the image prints, with its file, its measure and its period", () => {
    const claims = buildClaimRegistry({ stats: [], assets: [{ id: "img_proof", name: "E-commerce Industries - 5.33M 7.png", analysis: { stats: IMAGE.stats, dateRange: IMAGE.dateRange } }] });
    const value = claims.find((c) => c.figure === "26.5M")!;
    expect(value).toMatchObject({ text: "26.5M Conv. value", assetId: "img_proof", metric: "conversion_value", dateRange: "1 June 2025 – 31 May 2026" });
    expect(value.text).not.toMatch(/Sales Revenue/);
    expect(claims.find((c) => c.figure === "$5.33M")).toMatchObject({ metric: "ad_spend", assetId: "img_proof" });
  });
});

// ------------------------------------------------------------------ the placement plan: separate, selective, timed to the final edit

describe("the placement plan", () => {
  const word = (text: string, start: number, end: number) => ({ text, start, end, matched: true });
  const lines = (shift = 0): AlignedLine[] => [
    { sceneNumber: 1, fromAudio: true, matchedShare: 1, words: [word("A", 0.2, 0.3), word("proper", 0.3, 0.7), word("review", 0.7, 1.1), word("finds", 1.1, 1.5), word("where", 1.5, 1.7), word("budget", 1.7, 2.1), word("is", 2.1, 2.2), word("leaking.", 2.2, 2.8)].map((w) => ({ ...w, start: w.start + shift, end: w.end + shift })) },
    { sceneNumber: 2, fromAudio: true, matchedShare: 1, words: [word("That", 5.2, 5.4), word("delivered", 5.4, 6.0), word("26.5", 6.0, 6.6), word("million", 6.6, 7.0), word("in", 7.0, 7.1), word("conversion", 7.1, 7.7), word("value.", 7.7, 8.2), word("Book", 8.4, 8.6), word("a", 8.6, 8.7), word("free", 8.7, 9.0), word("audit.", 9.0, 9.4)].map((w) => ({ ...w, start: w.start + shift, end: w.end + shift })) },
  ];
  const planInput = (over: Partial<EditPlanInput> = {}, shift = 0): EditPlanInput => ({
    seconds: 10.4 + shift,
    format: "9:16",
    width: 1080,
    height: 1920,
    scenes: [
      { number: 1, line: "A proper review finds where budget is leaking.", stat: null, assetId: null, keywords: ["budget is leaking", "review"] },
      { number: 2, line: "That delivered 26.5 million in conversion value. Book a free audit.", stat: "26.5M Conv. value", assetId: "img_proof", keywords: ["conversion value"] },
    ],
    briefs: [
      { number: 1, editingNotes: [{ kind: "keyword", text: "budget is leaking" }, { kind: "keyword", text: "review" }, { kind: "cta", text: "Book a free audit" }] },
      { number: 2, editingNotes: [{ kind: "keyword", text: "conversion value" }, { kind: "stat", text: "26.5M Conv. value", claimId: "claim_3" }, { kind: "cta", text: "Book a free audit" }] },
    ],
    windows: [{ number: 1, start: 0 + shift, end: 5 + shift }, { number: 2, start: 5 + shift, end: 10.4 + shift }],
    aligned: lines(shift),
    faces: { bands: [], samples: [], limitation: null },
    assets: [{ id: "img_proof", name: "E-commerce Industries - 5.33M 7.png", purpose: "approved_proof_screenshot", sha256: "abc123", available: true, cautions: ["Settle the label."], figures: ["26.5M"] }],
    claims: PLAN_INPUT.claims,
    logo: { available: true, fileName: "acme-logo.webp", sha256: "def456", needsDarkPlate: true },
    brand: { name: "Acme", ctaLabel: "Book a free audit", url: "acme.example", accent: "#37CA37" },
    now: "now",
    ...over,
  });

  it("gives each suggestion its wording, times, scene, position, alignment, styling and concerns", () => {
    const plan = buildEditPlan(planInput());
    expect(plan.textOverlays.map((o) => [o.scene, o.kind, o.text])).toEqual([[1, "keyword", "budget is leaking"], [2, "stat", "26.5M Conv. value"]]);
    const stat = plan.textOverlays[1]!;
    // On screen from just before the figure is said until just after the point is made.
    expect(stat.start).toBeCloseTo(5.9, 1);
    expect(stat.end).toBeGreaterThan(7.7);
    expect(stat).toMatchObject({ alignment: "centre", scene: 2 });
    expect(stat.position).toMatch(/Lower third, centred/);
    expect(stat.styling).toMatch(/figure large and bold/);
    expect(stat.source).toMatch(/26\.5M Conv\. value \(Read from the uploaded image\)/);
    const keyword = plan.textOverlays[0]!;
    expect(keyword.start).toBeCloseTo(1.6, 1);
    expect(keyword.end).toBeLessThanOrEqual(5);
  });

  it("is selective: one suggestion a scene at most, and a call to action only where the video ends", () => {
    const plan = buildEditPlan(planInput());
    expect(plan.textOverlays).toHaveLength(2);
    expect(plan.textOverlays.some((o) => o.kind === "cta" && o.scene === 1)).toBe(false);
    const ctaOnly = buildEditPlan(planInput({ briefs: [{ number: 1, editingNotes: [] }, { number: 2, editingNotes: [{ kind: "cta", text: "Book a free audit" }] }] }));
    expect(ctaOnly.textOverlays).toEqual([expect.objectContaining({ kind: "cta", scene: 2, text: "Book a free audit" })]);
    expect(ctaOnly.textOverlays[0]!.start).toBeCloseTo(8.3, 1);
  });

  it("is recalculated from the timeline it is given: a different edit gives different times", () => {
    const before = buildEditPlan(planInput());
    const after = buildEditPlan(planInput({}, 2)); // the same speech two seconds later (a longer first clip, say)
    expect(after.textOverlays[1]!.start).toBeCloseTo(before.textOverlays[1]!.start + 2, 2);
    expect(after.proofImages[0]!.start).toBeCloseTo(before.proofImages[0]!.start + 2, 2);
    expect(after.videoSeconds).toBeCloseTo(12.4, 2);
    for (const o of after.textOverlays) {
      expect(o.start).toBeGreaterThanOrEqual(0);
      expect(o.end).toBeLessThanOrEqual(after.videoSeconds);
      expect(o.end).toBeGreaterThan(o.start);
    }
  });

  it("moves text away from a face and says so", () => {
    const low = placeText({ bands: [{ at: 6, top: 0.45, bottom: 0.8 }], samples: [6], limitation: null }, 5.9, 8.7);
    expect(low.position).toMatch(/Upper third/);
    expect(low.concerns.join(" ")).toMatch(/A face spans 43% to 82%/);
    const unknown = placeText({ bands: [], samples: [], limitation: "Faces could not be located." }, 1, 3);
    expect(unknown.concerns.join(" ")).toMatch(/Face positions were not measured/);
  });

  it("says when a time is not measured instead of presenting it as measured", () => {
    const plan = buildEditPlan(planInput({ aligned: lines().map((l) => ({ ...l, fromAudio: false })) }));
    expect(plan.textOverlays[0]!.concerns.join(" ")).toMatch(/could not be located in the audio/);
  });

  it("offers the proof image as the exact original file, with where it could go and what to settle first", () => {
    const plan = buildEditPlan(planInput());
    expect(plan.proofImages).toEqual([expect.objectContaining({ assetId: "img_proof", fileName: "E-commerce Industries - 5.33M 7.png", sha256: "abc123", available: true, scenes: [2], cautions: ["Settle the label."] })]);
    expect(plan.proofImages[0]!.instructions).toMatch(/original file exactly as supplied.*do not crop, redraw, restyle or re-type it.*do not let a video or image model recreate it/);
    expect(plan.proofImages[0]!.start).toBeCloseTo(5.55, 1);
    expect(buildEditPlan(planInput({ assets: [{ ...planInput().assets[0]!, available: false }] })).proofImages[0]!.available).toBe(false);
  });

  it("carries the logo and an end card only as suggestions, and says the MP4 contains neither", () => {
    const plan = buildEditPlan(planInput());
    expect(plan.logo).toMatchObject({ available: true, fileName: "acme-logo.webp", sha256: "def456" });
    expect(plan.logo!.note).toMatch(/needs a dark plate/);
    expect(plan.endCard!.lines).toEqual(["Acme", "Book a free audit", "acme.example"]);
    expect(plan.endCard!.note).toMatch(/Optional.*It is not part of the MP4/);
    expect(plan.note).toMatch(/The MP4 is clean: it contains none of what is listed here/);
    const text = editPlanText(plan, "Acme");
    expect(text).toMatch(/ON-SCREEN TEXT \(optional\)[\s\S]*"26\.5M Conv\. value"[\s\S]*PROOF IMAGES[\s\S]*SHA-256 abc123[\s\S]*END CARD \(optional\)/);
  });

  it("finds when a phrase is said from the words as spoken", () => {
    expect(phraseSpan(lines()[1]!.words, "conversion value")).toEqual({ start: 7.1, end: 8.2 });
    expect(phraseSpan(lines()[1]!.words, "not said here")).toBeNull();
  });

  it("writes a transcript with the written form, the times from the audio, and how each written term was spoken", () => {
    const text = transcriptText({
      title: "Acme",
      seconds: 10.4,
      speech: [{ sceneNumber: 2, display: "That delivered 26.5 million. Book your free 30-minute audit.", spoken: "That delivered twenty six point five million. Book your free thirty-minute audit.", segments: [{ display: "That delivered ", spoken: "That delivered " }, { display: "26.5 million", spoken: "twenty six point five million", term: "26.5 million" }, { display: ". Book your free ", spoken: ". Book your free " }, { display: "30-minute", spoken: "thirty-minute", term: "30-minute" }, { display: " audit.", spoken: " audit." }], uncertain: [] }],
      aligned: [lines()[1]!],
      windows: [{ number: 2, start: 5, end: 10.4 }],
      timedFromAudio: true,
    });
    expect(text).toContain("[00:05.2 - 00:09.4] That delivered 26.5 million. Book your free 30-minute audit.");
    expect(text).toContain('"26.5 million" is said as "twenty six point five million"');
    expect(text).toContain('"30-minute" is said as "thirty-minute"');
    expect(text).toMatch(/Times are measured from the final audio/);
  });
});

describe("subtitle cues", () => {
  it("never run past the end of the video (the last cue used to)", () => {
    const cue = (start: number, end: number): SubtitleCue => ({ start, end, words: [{ text: "x", start, end, matched: true }], lines: ["x"], text: "x" });
    const out = clampCues([cue(30, 33), cue(34.96, 37.25), cue(37.2, 38)], 37.09);
    expect(out.map((c) => [c.start, c.end])).toEqual([[30, 33], [34.96, 37.09]]);
    expect(out[1]!.words[0]!.end).toBe(37.09);
  });
});
