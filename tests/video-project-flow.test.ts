import { describe, expect, it, vi } from "vitest";
import type { AnglePlan, CreativeBrief } from "@/lib/video/script-types";

// The script job end to end with the models stubbed: the page is read into a sourced brief, three
// different angles are planned, each is written from its own angle, and each is edited.

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: null, value_proposition: "Profit-first ads" },
    service: null,
    brief: null,
  }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({
  analyzeBrandFromUrl: async () => ({ brand_name: "Acme", colors: ["#37ca37"], logo_url: null, title: "Acme", summary: "Acme.", page_excerpt: "Acme runs Google Ads.", page_text: "Acme runs Google Ads for shops. Clients see 255% average ROI." }),
}));
vi.mock("@/lib/video/brand-resolve", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/brand-resolve")>()),
  resolveBrandManifest: async () => ({
    version: 1, createdAt: "", clientId: "c1", projectId: "p", sourceUrl: { value: "https://acme.test", provenance: [] }, name: { value: "Acme", provenance: [] }, nameCandidates: [], internalLabels: [], logo: null, logoCandidates: [],
    colors: { value: ["#37ca37"], provenance: [] }, offer: { value: "Profit-first ads", provenance: [] }, cta: { value: null, provenance: [] }, audience: { value: null, provenance: [] },
    claims: [{ id: "claim_1", text: "255% average client ROI", kind: "number", figure: "255%", evidence: "255% average ROI", provenance: { source: "image_reading", detail: "results.png", confidence: "high" } }],
    allowTextOnlyBrand: true, conflicts: [], issues: [],
  }),
}));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null, pickLogoDocument: () => null }));
vi.mock("@/lib/creatives/concept-writer", async (orig) => ({ ...(await orig<typeof import("@/lib/creatives/concept-writer")>()), pickModel: () => ({}) }));
vi.mock("@/lib/storage/r2", () => ({ getObjectStorage: () => ({ get: async () => Buffer.from([1, 2, 3]), put: async () => undefined, delete: async () => undefined }) }));

const brief = (quality: CreativeBrief["sourceQuality"]): CreativeBrief => ({
  version: 1,
  createdAt: "",
  company: { name: "Acme", source: "brand manifest" },
  offer: { name: "Profit-first ads", description: "Google Ads management", factIds: [] },
  conversion: { action: "Book a call", target: null, benefit: null, factIds: [] },
  audience: { primary: "Shop owners", situation: "Ad spend rises and sales do not", factIds: [], inferred: true },
  mechanism: null,
  facts: [{ id: "f1", text: "Clients see 255% average ROI", category: "proof", source: { id: "p", kind: "page", label: "Landing page", quote: "Clients see 255% average ROI" }, scope: "average across clients" }],
  inferences: [],
  rejectedFacts: [],
  voice: { tone: "plain", vocabulary: [], avoid: [] },
  defaults: [{ field: "platform", value: "Meta Reels and Stories", why: "this app makes vertical video for Meta" }],
  gaps: quality === "insufficient" ? [{ field: "offer", why: "The page does not say what the offer is.", essential: true, ask: "What exactly do you sell?" }] : [],
  sourceQuality: quality,
  limitation: quality === "insufficient" ? "Nothing on the page says what is being sold." : null,
  injectionFlags: [],
});

let quality: CreativeBrief["sourceQuality"] = "rich";
vi.mock("@/lib/video/creative-brief", async (orig) => ({ ...(await orig<typeof import("@/lib/video/creative-brief")>()), buildCreativeBrief: async () => brief(quality) }));

const angle = (id: string): AnglePlan => ({ id, name: `Angle ${id}`, situation: `Situation ${id}`, tension: `Tension ${id}`, centralMessage: `Message ${id}`, hookPremise: `Premise ${id}`, support: { text: "Clients see 255% average ROI", factIds: ["f1"] }, tone: "plain", reasonToAct: `Reason ${id}`, whyDifferent: `Different ${id}` });
vi.mock("@/lib/video/angles", async (orig) => ({ ...(await orig<typeof import("@/lib/video/angles")>()), planAngles: async () => ({ angles: [angle("a"), angle("b"), angle("c")], considered: [], issues: [], limitation: null }) }));
vi.mock("@/lib/video/editorial", async (orig) => ({ ...(await orig<typeof import("@/lib/video/editorial")>()), editorialPass: async (scripts: unknown[]) => ({ scripts, overlap: { pairs: [], findings: [] } }) }));

const scene = (line: string, extra: Record<string, unknown> = {}) => ({ seconds: 4, visual: "A shop counter", camera: "Medium", speaker: "voiceover", line, keywords: [], stat: null, asset_id: null, sound: "beat", ...extra });

vi.mock("ai", () => ({
  generateObject: async (args: { prompt?: string; messages?: unknown }) => {
    // The image read has messages, not a prompt.
    if (args.messages) return { object: { kind: "stats_screenshot", summary: "A results dashboard", stats: [{ value: "255%", label: "average client ROI" }], hasFace: false } };
    const prompt = args.prompt ?? "";
    const id = /Name: Angle (\w)/.exec(prompt)?.[1] ?? "x";
    const lines = [`Opening for ${id} that names a real moment.`, `Second thought for ${id} with more detail about how it works.`, `Clients see 255% average ROI, which is the proof for ${id}.`, `Close with the real next step for ${id}.`];
    return {
      object: {
        title: `Version ${id}`,
        hook_candidates: [lines[0], "Another opening.", "A third opening.", "A fourth opening."].map((line) => ({ line, why: "why" })),
        chosen_hook: 0,
        hook_payoff: "paid off in scene 3",
        style: `style ${id}`,
        dramatisation: true,
        character: null,
        setting: "a shop",
        // The uploaded image's stat is used in scene 3 and its image is shown there.
        scenes: lines.map((line, i) => scene(line, i === 2 ? { stat: "255%", asset_id: "IMG" } : {})),
        visual_direction: "A shop counter, then the results image.",
        on_screen: ["255%"],
        cta: { spoken: "Book a call.", label: "Book Now", target: null, benefit: null },
        sources: [{ claim: "Clients see 255% average ROI", fact_id: "f1" }],
        primary_text: "Hook.\nBody.",
        headline: "h",
        description: "d",
      },
    };
  },
}));

describe("writing scripts for a project with an uploaded image", () => {
  it("reads the image, plans three different angles, writes each from its own, and records progress through to done", async () => {
    quality = "rich";
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
    // The brief and the angles are kept, so one version can be changed later without losing the others.
    expect(done.brand?.brief?.sourceQuality).toBe("rich");
    expect(done.brand?.angles).toHaveLength(3);
    // Each version came from its own angle, with its own opening, source and speech estimate.
    expect(done.scripts).toHaveLength(3);
    expect(new Set(done.scripts!.map((s) => s.angle.name)).size).toBe(3);
    expect(new Set(done.scripts!.map((s) => s.hook!.line)).size).toBe(3);
    for (const s of done.scripts!) {
      // The stat came from the image, so it passes the fact check and is tied to that image.
      expect(s.scenes[2]!.stat).toBe("255%");
      expect(s.scenes[2]!.assetId).toBe("IMG");
      expect(s.warnings.join(" ")).not.toMatch(/255/);
      expect(s.sources!.length).toBeGreaterThan(0);
      expect(s.speech!.requestedSeconds).toBe(35);
    }
  });

  it("asks for what is essential instead of inventing when the page cannot support scripts", async () => {
    quality = "insufficient";
    const { createProject, getProject } = await import("@/lib/video/projects");
    const { writeProjectScripts } = await import("@/lib/video/brief");
    const project = await createProject({ clientId: "c1", inputs: { landingPageUrl: "https://acme.test", stats: [], targetSeconds: 35, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" } });
    await writeProjectScripts(project.id);
    const done = (await getProject(project.id))!;
    expect(done.status).toBe("needs_context");
    expect(done.error).toContain("What exactly do you sell?");
    expect(done.scripts).toBeNull();
    expect(done.brand?.brief?.gaps[0]?.essential).toBe(true);
    quality = "rich";
  });
});
