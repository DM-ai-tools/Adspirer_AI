import { describe, expect, it, vi } from "vitest";
import { BULK_ANGLES } from "@/lib/creatives/bulk/angles";

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: null, value_proposition: "Profit-first ads" },
    service: null,
    brief: null,
  }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({
  analyzeBrandFromUrl: async () => ({ brand_name: "Acme", colors: ["#37ca37"], logo_url: null, title: "Acme", summary: "Acme.", page_excerpt: "Acme runs Google Ads." }),
}));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("@/lib/storage/r2", () => ({ getObjectStorage: () => ({ get: async () => Buffer.from([1, 2, 3]) }) }));

const scene = (seconds: number, line: string, extra: Record<string, unknown> = {}) => ({
  seconds,
  visual: "A presenter at a desk",
  camera: "Medium",
  speaker: "voiceover",
  line,
  keywords: [],
  stat: null,
  asset_id: null,
  sound: "beat",
  ...extra,
});

vi.mock("ai", () => ({
  generateObject: async (args: { prompt?: string; messages?: unknown }) => {
    // The image read has messages, not a prompt.
    if (args.messages) {
      return { object: { kind: "stats_screenshot", summary: "A results dashboard", stats: [{ value: "255%", label: "average client ROI" }], hasFace: false } };
    }
    const prompt = args.prompt ?? "";
    if (prompt.includes("Analyse the offer")) return { object: { pains: ["a"], desires: ["b"], objections: ["c"], proof: ["d"], mechanism: "m" } };
    const keys = BULK_ANGLES.map((a) => a.key).filter((k) => prompt.includes(`angle_key "${k}"`));
    return {
      object: {
        scripts: keys.map((k, i) => ({
          angle_key: k,
          title: `S${i}`,
          pain: "p",
          style: `style ${i}`,
          hook_alternatives: ["a", "b", "c"],
          character: null,
          setting: "s",
          // The uploaded image's stat is used in scene 3 and its image is shown there.
          scenes: [scene(3, "Stop wasting spend."), scene(8, "We track every dollar."), scene(9, "Clients see 255% average ROI.", { stat: "255%", asset_id: "IMG" }), scene(8, "Plenty trust us."), scene(7, "Book a call.")],
          primary_text: "Hook.\nBody.",
          headline: "h",
          description: "d",
          cta: "Learn More",
        })),
      },
    };
  },
}));

describe("writing scripts for a project with an uploaded image", () => {
  it("reads the image, uses its stat in the scripts, and records progress through to done", async () => {
    const { createProject, getProject, updateProject } = await import("@/lib/video/projects");
    const { writeProjectScripts } = await import("@/lib/video/brief");

    const project = await createProject({
      clientId: "c1",
      inputs: { landingPageUrl: "https://acme.test", stats: [], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" },
    });
    await updateProject(project.id, { assets: [{ id: "IMG", name: "results.png", caption: "", role: "show", key: "k", mime: "image/png" }] });

    await writeProjectScripts(project.id);

    const done = (await getProject(project.id))!;
    expect(done.status).toBe("scripts_ready");
    expect(done.progress?.stage).toBe("done");
    // The image was read and is now marked to highlight.
    expect(done.assets[0]!.analysis?.stats[0]?.value).toBe("255%");
    expect(done.assets[0]!.role).toBe("highlight");
    // The stat came from the image, so it passes the fact check and is tied to that image.
    expect(done.scripts).toHaveLength(3);
    for (const s of done.scripts!) {
      expect(s.scenes[2]!.stat).toBe("255%");
      expect(s.scenes[2]!.assetId).toBe("IMG");
      expect(s.warnings.join(" ")).not.toMatch(/255/);
    }
  });
});
