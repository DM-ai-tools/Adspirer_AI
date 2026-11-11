import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { BULK_ANGLES } from "@/lib/creatives/bulk/angles";
import { resetObjectStorage, type ObjectStorage } from "@/lib/storage/r2";

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: null, value_proposition: "Better ads" },
    service: null,
    brief: null,
  }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({ analyzeBrandFromUrl: async () => ({ brand_name: "Acme", colors: ["#37ca37"], logo_url: null, title: "Acme" }) }));
vi.mock("@/lib/creatives/page-text", () => ({ readPageText: async () => ({ at: 0, text: "", readable: false }), cleanPageText: (s: string) => s, clearPageCache: () => undefined }));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("@/lib/creatives/generate-draft-image", async () => {
  const { getCreativeDraftAsync, upsertCreativeDraftAsync } = await import("@/lib/creatives/drafts");
  return {
    generateImageForDraft: async (id: string) => {
      const d = (await getCreativeDraftAsync(id))!;
      await upsertCreativeDraftAsync({ ...d, id, image_status: "succeeded", image_url: "https://x/y.png" });
      return {};
    },
  };
});

const hookPrompts: string[] = [];
const state = { visionFails: false, visionCalls: 0 };

vi.mock("ai", () => ({
  generateObject: async (args: { prompt?: string; messages?: unknown[] }) => {
    if (args.messages) {
      state.visionCalls += 1;
      if (state.visionFails) throw new Error("vision is down");
      return {
        object: {
          medium: "moody studio photo",
          composition: "centred subject",
          lighting: "neon rim light",
          colour_treatment: "dark and saturated",
          type_and_graphics: "bold sans headline",
          mood: "premium",
          subject_matter: "objects",
          signature: ["neon rim light", "dark ground"],
          flexible: ["setting"],
        },
      };
    }
    const prompt = args.prompt ?? "";
    if (prompt.includes("Build the message map")) return { object: { pains: ["p"], desires: ["d"], objections: ["o"], proof: ["x"], mechanism: "m", audience: "a" } };
    if (prompt.includes("Write exactly 4 distinct bodies")) {
      return { object: { bodies: ["A", "B", "C", "D"].map((id) => ({ id, format: "proof", text: `body ${id}` })), ctas: [{ label: "Get a quote", cta: "GET_QUOTE" }] } };
    }
    if (prompt.includes("Write one visual idea")) {
      const ideaKeys = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`key "${k}"`));
      return { object: { ideas: ideaKeys.map((k) => ({ angle_key: k, idea: `idea for ${k}` })) } };
    }
    hookPrompts.push(prompt);
    const keys = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`key "${k}"`));
    return {
      object: {
        hooks: keys.map((k, i) => ({
          angle_key: k,
          targets: `target ${k}`,
          post_headline: `Headline ${i}`,
          body_id: "ABCD"[i % 4],
          primary_text: `copy ${i} ${k}`,
          cta_index: 0,
          on_image_text: { headline: `qa${BULK_ANGLES.findIndex((a) => a.key === k)}x qa${BULK_ANGLES.findIndex((a) => a.key === k)}y qa${BULK_ANGLES.findIndex((a) => a.key === k)}z`, highlights: [`label ${k}`], cta_label: "Go" },
          style: `model style ${i}`,
          creative_direction: `idea ${i}`,
        })),
      },
    };
  },
}));

function memoryStorage(): ObjectStorage {
  const objects = new Map<string, Buffer>();
  return {
    name: "TestStorage",
    put: async (key, data, contentType = "application/octet-stream") => {
      objects.set(key, Buffer.from(data as Buffer));
      return { key, contentType, size: objects.get(key)!.length, url: `/x/${key}` };
    },
    get: async (key) => objects.get(key) ?? null,
    delete: async (key) => void objects.delete(key),
    getPublicUrl: (key) => `/x/${key}`,
  };
}

async function png(): Promise<string> {
  const sharp = (await import("sharp")).default;
  const buf = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#222222" } }).png().toBuffer();
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function styleNames(runId: string): Promise<string[]> {
  const { listCreativeDraftsAsync } = await import("@/lib/creatives/drafts");
  const { readRunMarker } = await import("@/lib/creatives/formats");
  const { getRun } = await import("@/lib/creatives/bulk/runs");
  const run = (await getRun(runId))!;
  const drafts = (await listCreativeDraftsAsync("c1")).filter((d) => readRunMarker(d.creative_direction) === runId);
  const byId = new Map(drafts.map((d) => [d.id, d]));
  return run.items.map((i) => byId.get(i.draft_id)!.creative_direction?.match(/STYLE: ([^.]+)\./)?.[1] ?? "");
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  resetConfigCache();
  resetObjectStorage(memoryStorage());
  hookPrompts.length = 0;
  state.visionFails = false;
  state.visionCalls = 0;
});

describe("a bulk run with the operator's own style", () => {
  it("reads an uploaded image once, and by default 5 images follow it and 10 are variations", async () => {
    const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
    const { getRun } = await import("@/lib/creatives/bulk/runs");
    const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "4:5", styleImages: [await png()], styleDirection: "No 3D renders." });
    expect(run.inputs.styleImageKeys).toHaveLength(1);

    await planAndRender(run.id);

    expect(state.visionCalls).toBe(1);
    const done = (await getRun(run.id))!;
    expect(done.status).toBe("done");
    expect(done.inputs.styleBrief).toContain("moody studio photo");
    const names = await styleNames(run.id);
    expect(names.filter((n) => n === "Reference style")).toHaveLength(5);
    expect(names.filter((n) => n.startsWith("Reference variation, "))).toHaveLength(10);
    // The writer was given the reference once, with the operator's words as firm rules.
    const prompt = hookPrompts[0]!;
    expect(prompt).toContain("REFERENCE STYLE");
    expect(prompt).toContain("neon rim light");
    expect(prompt).toContain("No 3D renders.");
    expect(prompt).toMatch(/FIRM RULES/);
    expect(prompt).not.toMatch(/no two hooks may share a visual idea or a style/);
  });

  it("with 'match all', all 15 follow the reference", async () => {
    const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
    const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "4:5", styleImages: [await png()], styleMatchAll: true });
    await planAndRender(run.id);
    expect((await styleNames(run.id)).every((n) => n === "Reference style")).toBe(true);
  });

  it("works from words alone, without calling the vision model", async () => {
    const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
    const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "4:5", styleDirection: "Retro print posters." });
    await planAndRender(run.id);
    expect(state.visionCalls).toBe(0);
    expect(hookPrompts[0]).toContain("Retro print posters.");
    expect((await styleNames(run.id)).filter((n) => n === "Reference style")).toHaveLength(5);
  });

  it("with no style given, nothing changes: 15 different catalogue styles and no reference in the prompt", async () => {
    const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
    const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "4:5" });
    await planAndRender(run.id);
    expect(new Set(await styleNames(run.id)).size).toBe(15);
    expect(hookPrompts[0]).not.toContain("REFERENCE STYLE");
    expect(hookPrompts[0]).toMatch(/no two hooks may share a visual idea or a style/);
  });

  it("stops with a clear message when the image cannot be read and there are no words to go on", async () => {
    const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
    const { getRun } = await import("@/lib/creatives/bulk/runs");
    state.visionFails = true;
    const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "4:5", styleImages: [await png()] });
    await planAndRender(run.id);
    const failed = (await getRun(run.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Could not read the reference image/);
    expect(failed.error).toMatch(/describe the style in words/);
  });

  it("carries on with the operator's words when the image cannot be read", async () => {
    const { startBulkRun, planAndRender } = await import("@/lib/creatives/bulk/run");
    const { getRun } = await import("@/lib/creatives/bulk/runs");
    state.visionFails = true;
    const run = await startBulkRun({ clientId: "c1", landingPageUrl: "https://acme.test", format: "4:5", styleImages: [await png()], styleDirection: "Bold type posters." });
    await planAndRender(run.id);
    expect((await getRun(run.id))!.status).toBe("done");
    expect(hookPrompts[0]).toContain("Bold type posters.");
  });

  it("refuses a bad image before creating a run", async () => {
    const { startBulkRun } = await import("@/lib/creatives/bulk/run");
    const { listRuns } = await import("@/lib/creatives/bulk/runs");
    const before = (await listRuns("c1")).length;
    await expect(startBulkRun({ clientId: "c1", format: "4:5", styleImages: [`data:image/png;base64,${Buffer.from("nope").toString("base64")}`] })).rejects.toThrow(/could not be read/);
    expect((await listRuns("c1")).length).toBe(before);
  });
});
