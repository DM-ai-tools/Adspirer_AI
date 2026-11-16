import { describe, expect, it, vi } from "vitest";
import type { CreativeBrief, VideoConcept } from "@/lib/video/script-types";
import type { VideoScript } from "@/lib/video/script";

// The concepts flow end to end with the models stubbed: the page becomes a sourced brief, three
// concepts are shown, the operator picks one and its full script is written, another can be picked
// (both scripts kept), and new concepts never repeat ones already shown for the client.

vi.mock("@/lib/creatives/service", () => ({
  loadScope: async () => ({
    client: { id: "c1", name: "Acme", brand_voice: null, brand_colors: ["#37ca37"], website_url: null, target_audience: null, value_proposition: "Profit-first ads" },
    service: null,
    brief: null,
  }),
}));
vi.mock("@/lib/brand/analyze-url", () => ({
  analyzeBrandFromUrl: async () => ({ brand_name: "Acme", colors: ["#37ca37"], logo_url: null, title: "Acme", summary: "Acme.", page_excerpt: "Acme runs Google Ads.", page_text: "Acme runs Google Ads for shops." }),
}));
vi.mock("@/lib/video/brand-resolve", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/brand-resolve")>()),
  resolveBrandManifest: async () => ({
    version: 1, createdAt: "", clientId: "c1", projectId: "p", sourceUrl: { value: "https://acme.test", provenance: [] }, name: { value: "Acme", provenance: [] }, nameCandidates: [], internalLabels: [], logo: null, logoCandidates: [],
    colors: { value: ["#37ca37"], provenance: [] }, offer: { value: "Profit-first ads", provenance: [] }, cta: { value: null, provenance: [] }, audience: { value: null, provenance: [] },
    claims: [], allowTextOnlyBrand: true, conflicts: [], issues: [],
  }),
}));
vi.mock("@/lib/creatives/uploaded-logo", () => ({ loadUploadedLogoDataUri: async () => null, pickLogoDocument: () => null }));
vi.mock("@/lib/storage/r2", () => ({ getObjectStorage: () => ({ get: async () => null, put: async () => undefined, delete: async () => undefined }) }));

const creative: CreativeBrief = {
  version: 1,
  createdAt: "",
  company: { name: "Acme", source: "brand manifest" },
  offer: { name: "Profit-first ads", description: "Google Ads management", factIds: [] },
  conversion: { action: "Book a call", target: null, benefit: null, factIds: [] },
  audience: { primary: "Shop owners", situation: "Ad spend rises and sales do not", factIds: [], inferred: true },
  mechanism: null,
  facts: [{ id: "f1", text: "Acme runs Google Ads for shops", category: "offer", source: { id: "p", kind: "page", label: "Landing page", quote: "Acme runs Google Ads for shops" } }],
  inferences: [],
  rejectedFacts: [],
  voice: { tone: "plain", vocabulary: [], avoid: [] },
  defaults: [],
  gaps: [],
  sourceQuality: "rich",
  limitation: null,
  injectionFlags: [],
};
vi.mock("@/lib/video/creative-brief", async (orig) => ({ ...(await orig<typeof import("@/lib/video/creative-brief")>()), buildCreativeBrief: async () => creative }));

let round = 0;
const conceptCalls: Array<{ avoid: string[]; feedback?: string | null; direction: string | null }> = [];
const concept = (n: number): VideoConcept => ({
  id: `concept_${n}`,
  title: `Concept ${n}`,
  format: "trailer",
  logline: `Idea number ${n}`,
  hook: `Hook ${n}`,
  beats: [{ text: "a", seconds: 5 }, { text: "b", seconds: 5 }],
  whyItWorks: "w",
  brandLink: "Google Ads for shops",
  look: "l",
  cast: [],
  settings: ["a shop"],
  voices: [{ id: "narrator", who: "narrator", description: "warm" }],
  seconds: 30,
});
vi.mock("@/lib/video/concepts", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/concepts")>()),
  planConcepts: async (_brief: CreativeBrief, opts: { avoid: string[]; feedback?: string | null; direction: string | null }) => {
    conceptCalls.push(opts);
    const base = round++ * 3;
    return { concepts: [concept(base + 1), concept(base + 2), concept(base + 3)], limitation: null };
  },
}));

let failWriting = false;
vi.mock("@/lib/video/script-writer", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/script-writer")>()),
  writeScriptForConcept: async (_ctx: unknown, c: VideoConcept): Promise<VideoScript> => {
    if (failWriting) throw new Error("the writer is down");
    return {
      id: `script_${c.id}`,
      title: c.title,
      angle: { key: c.id, name: c.title, stage: "", kind: "custom" },
      pain: "",
      framework: { key: c.id, name: "" },
      style: "trailer",
      durationSeconds: 8,
      hookAlternatives: [],
      character: null,
      setting: "a shop",
      scenes: [
        { number: 1, start: 0, end: 4, seconds: 4, visual: "v", camera: "c", speaker: "voiceover", line: "Acme runs Google Ads for shops.", keywords: [], stat: null, assetId: null, sound: "", lines: [{ voiceId: "narrator", text: "Acme runs Google Ads for shops.", onCamera: false }] },
        { number: 2, start: 4, end: 8, seconds: 4, visual: "v", camera: "c", speaker: "voiceover", line: "Book a call.", keywords: [], stat: null, assetId: null, sound: "", lines: [{ voiceId: "narrator", text: "Book a call.", onCamera: false }] },
      ],
      adCopy: { primaryText: "p", headline: "h", description: "d", cta: "Book Now" },
      warnings: [],
      voices: [{ id: "narrator", who: "narrator", description: "warm" }],
      concept: c,
    };
  },
}));
vi.mock("@/lib/video/editorial", async (orig) => ({ ...(await orig<typeof import("@/lib/video/editorial")>()), editorialPass: async (scripts: unknown[]) => ({ scripts, overlap: { pairs: [], findings: [] } }) }));

const inputs = { landingPageUrl: "https://acme.test", stats: [], targetSeconds: 30, style: "auto", locale: "en-AU", format: "9:16" as const, priority: "balanced" as const, videoType: "action_trailer" };

describe("concepts first, then the script", () => {
  it("shows three concepts and writes nothing else until one is picked", async () => {
    const { createProject, getProject } = await import("@/lib/video/projects");
    const { writeProjectScripts } = await import("@/lib/video/brief");
    const project = await createProject({ clientId: "client-flow-1", inputs });
    await writeProjectScripts(project.id);
    const p = (await getProject(project.id))!;
    expect(p.status).toBe("concepts_ready");
    expect(p.brand?.concepts?.map((c) => c.id)).toEqual(["concept_1", "concept_2", "concept_3"]);
    expect(p.brand?.shownConcepts).toEqual(["Idea number 1", "Idea number 2", "Idea number 3"]);
    expect(p.scripts ?? []).toEqual([]);
    expect(conceptCalls.at(-1)!.direction).toMatch(/trailer/i);
  });

  it("writes the full script for the picked concept, and keeps it when another is picked", async () => {
    const { createProject, getProject } = await import("@/lib/video/projects");
    const { writeProjectScripts, writeConceptScript } = await import("@/lib/video/brief");
    const project = await createProject({ clientId: "client-flow-2", inputs });
    await writeProjectScripts(project.id);
    const [first, second] = (await getProject(project.id))!.brand!.concepts!;
    await writeConceptScript(project.id, first!.id);
    let p = (await getProject(project.id))!;
    expect(p.status).toBe("scripts_ready");
    expect(p.scripts?.map((s) => s.concept?.id)).toEqual([first!.id]);
    await writeConceptScript(project.id, second!.id);
    p = (await getProject(project.id))!;
    expect(p.scripts?.map((s) => s.concept?.id)).toEqual([first!.id, second!.id]);
  });

  it("goes back to the concepts with the reason when the script cannot be written", async () => {
    const { createProject, getProject } = await import("@/lib/video/projects");
    const { writeProjectScripts, writeConceptScript } = await import("@/lib/video/brief");
    const project = await createProject({ clientId: "client-flow-3", inputs });
    await writeProjectScripts(project.id);
    const [first] = (await getProject(project.id))!.brand!.concepts!;
    failWriting = true;
    try {
      await writeConceptScript(project.id, first!.id);
    } finally {
      failWriting = false;
    }
    const p = (await getProject(project.id))!;
    expect(p.status).toBe("concepts_ready");
    expect(p.error).toMatch(/writer is down/);
  });

  it("makes three new concepts that avoid every idea already shown, here and for the client before", async () => {
    const { createProject, getProject } = await import("@/lib/video/projects");
    const { writeProjectScripts, moreConcepts } = await import("@/lib/video/brief");
    const earlier = await createProject({ clientId: "client-flow-4", inputs });
    await writeProjectScripts(earlier.id);
    const shownEarlier = (await getProject(earlier.id))!.brand!.shownConcepts!;

    const project = await createProject({ clientId: "client-flow-4", inputs });
    await writeProjectScripts(project.id);
    // the new project's first concepts already avoid the earlier project's ideas
    for (const idea of shownEarlier) expect(conceptCalls.at(-1)!.avoid).toContain(idea);
    const firstShown = (await getProject(project.id))!.brand!.shownConcepts!;

    await moreConcepts(project.id, "funnier, less serious");
    const p = (await getProject(project.id))!;
    expect(p.status).toBe("concepts_ready");
    for (const idea of [...shownEarlier, ...firstShown]) expect(conceptCalls.at(-1)!.avoid).toContain(idea);
    expect(conceptCalls.at(-1)!.feedback).toBe("funnier, less serious");
    expect(p.brand!.concepts!.some((c) => firstShown.includes(c.logline))).toBe(false);
    expect(p.brand!.shownConcepts).toEqual([...firstShown, ...p.brand!.concepts!.map((c) => c.logline)]);
  });
});

describe("confirming a script", () => {
  it("no longer needs any stat to be said", async () => {
    const { createProject, getProject, updateProject } = await import("@/lib/video/projects");
    const { writeProjectScripts, writeConceptScript } = await import("@/lib/video/brief");
    const { confirmScript } = await import("@/lib/video/script-actions");
    const project = await createProject({ clientId: "client-flow-5", inputs });
    await writeProjectScripts(project.id);
    const [first] = (await getProject(project.id))!.brand!.concepts!;
    await writeConceptScript(project.id, first!.id);
    const withImage = await updateProject(project.id, {
      assets: [{ id: "IMG", name: "results.png", caption: "", role: "show", key: "k", mime: "image/png", analysis: { kind: "stats_screenshot", summary: "results", stats: [{ value: "255%", label: "ROI" }], mainStat: { value: "255%", label: "ROI" }, hasFace: false } as never }],
    });
    const script = withImage.scripts![0]!;
    const confirmed = confirmScript(withImage, { scriptId: script.id, edits: { title: script.title, scenes: script.scenes, adCopy: script.adCopy } });
    expect(confirmed.chosen.id).toBe(script.id);
    expect(confirmed.chosen.scenes[0]!.lines).toEqual(script.scenes[0]!.lines);
  });

  it("keeps who says a line when the operator edits its words", async () => {
    const { markEdited } = await import("@/lib/video/script-actions");
    const original = {
      scenes: [{ number: 1, start: 0, end: 4, seconds: 4, visual: "v", camera: "c", speaker: "on_camera", line: "Found you.", keywords: [], stat: null, assetId: null, sound: "", lines: [{ voiceId: "maya", text: "Found you.", onCamera: true }] }],
    } as unknown as VideoScript;
    const [edited] = markEdited(original, [{ ...original.scenes[0]!, line: "Got you at last." }]);
    expect(edited!.lines).toEqual([{ voiceId: "maya", text: "Got you at last.", onCamera: true }]);
    expect(edited!.edited).toBe(true);
  });
});
