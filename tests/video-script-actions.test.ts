import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoProject } from "@/lib/video/projects";
import type { VideoScript } from "@/lib/video/script";
import type { AnglePlan, CreativeBrief } from "@/lib/video/script-types";

// Changing ONE version: the others are untouched, edited scenes survive, and the new version goes through the real editor.

vi.mock("@/lib/video/model-fallback", () => ({ modelCandidates: () => [{}], withModelFallback: async (run: (m: unknown) => Promise<unknown>, c: unknown[] = [{}]) => run(c[0]) }));
vi.mock("ai", () => ({ generateObject: async () => ({ object: { issues: [], signals: { opening: 7, naturalness: 7, specificity: 7 }, summary: "Fine. Fine." } }) }));
let plannedFresh: AnglePlan | null = null;
vi.mock("@/lib/video/angles", async (orig) => ({
  ...(await orig<typeof import("@/lib/video/angles")>()),
  planAngles: async (_brief: unknown, opts: { keep?: AnglePlan[] }) => ({ angles: plannedFresh ? [...(opts.keep ?? []), plannedFresh] : (opts.keep ?? []), considered: [], issues: [], limitation: plannedFresh ? null : "Only these angles are supported by the page." }),
}));

const { applyDraft, markEdited, reviseVersion, withSpeech } = await import("@/lib/video/script-actions");
const { buildWrittenScript } = await import("@/lib/video/script-writer");

const prov = { id: "p", kind: "page" as const, label: "Landing page", quote: "We photograph every damaged area and write the report for your insurer" };
const creative: CreativeBrief = {
  version: 1,
  createdAt: "",
  company: { name: "Kestrel Roofing", source: "brand manifest" },
  offer: { name: "Roof inspection", description: "Written report", factIds: ["f1"] },
  conversion: { action: "Book an inspection", target: null, benefit: null, factIds: [] },
  audience: { primary: "Homeowners", situation: "After hail", factIds: [], inferred: true },
  mechanism: null,
  facts: [{ id: "f1", text: "The crew photographs every damaged area and writes a report for your insurer", category: "mechanism", source: prov }],
  inferences: [],
  rejectedFacts: [],
  voice: { tone: "plain", vocabulary: [], avoid: [] },
  defaults: [],
  gaps: [],
  sourceQuality: "rich",
  limitation: null,
  injectionFlags: [],
};
const angle = (id: string, name: string): AnglePlan => ({ id, name, situation: `Situation ${id}`, tension: `Tension ${id}`, centralMessage: `Message ${id}`, hookPremise: `Premise ${id}`, support: { text: "photographs every damaged area", factIds: ["f1"] }, tone: "plain", reasonToAct: "r", whyDifferent: `Different ${id}` });
const A = angle("a", "Angle A");
const B = angle("b", "Angle B");
const C = angle("c", "Angle C");

const words = (n: number, tag = "w") => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
function written(a: AnglePlan, lines: string[], extra: { dramatisation?: boolean } = {}): VideoScript {
  const ctx = { creative, brief: { brandName: "Kestrel Roofing", offerName: "x", stats: [], images: [], targetSeconds: 30, style: "auto", locale: "en-AU" }, targetSeconds: 30, wordsPerSecond: 2.5, assetIds: [], claims: [], sourceText: "We photograph every damaged area and write the report for your insurer", facts: "", corpus: "" };
  return buildWrittenScript(
    {
      title: a.name,
      hook_candidates: [lines[0]!, "Second candidate.", "Third candidate.", "Fourth candidate."].map((line) => ({ line, why: "w" })),
      chosen_hook: 0,
      hook_payoff: "paid off",
      style: "Documentary",
      dramatisation: extra.dramatisation ?? true,
      character: null,
      setting: "s",
      scenes: lines.map((line) => ({ seconds: 4, visual: "A roof being photographed", camera: "static", speaker: "voiceover" as const, line, keywords: [], stat: null, asset_id: null, sound: "" })),
      visual_direction: "A crew on a roof.",
      on_screen: [],
      cta: { spoken: "Book an inspection.", label: "Book Now", target: null, benefit: null },
      sources: [{ claim: "photographs every damaged area", fact_id: "f1" }],
      primary_text: "x",
      headline: "h",
      description: "d",
    },
    a,
    ctx,
  );
}

const fitting = (tag: string) => [words(18, `${tag}a`), words(18, `${tag}b`), words(18, `${tag}c`), words(18, `${tag}d`)];

function project(scripts: VideoScript[]): VideoProject {
  return {
    id: "vid_x",
    client_id: "c1",
    service_id: null,
    created_by: null,
    inputs: { landingPageUrl: "https://k.example", stats: [], targetSeconds: 30, style: "auto", locale: "en-AU", format: "9:16", priority: "balanced" },
    assets: [],
    brand: { name: "Kestrel Roofing", colors: null, logoUrl: null, summary: null, brief: creative, angles: [A, B, C] },
    status: "scripts_ready",
    error: null,
    scripts,
    chosen_script: null,
    created_at: "",
    updated_at: "",
  } as unknown as VideoProject;
}

beforeEach(() => {
  plannedFresh = null;
});

describe("edits the operator makes", () => {
  it("marks only the scenes they changed as approved wording", () => {
    const s = written(A, fitting("x"));
    const draft = s.scenes.map((x) => ({ ...x }));
    draft[1] = { ...draft[1]!, line: "My own words for this scene." };
    const marked = markEdited(s, draft);
    expect(marked.map((m) => Boolean(m.edited))).toEqual([false, true, false, false]);
  });

  it("keeps an approval from an earlier edit even if the scene is saved unchanged", () => {
    const s = written(A, fitting("x"));
    s.scenes[0] = { ...s.scenes[0]!, edited: true };
    expect(markEdited(s, s.scenes)[0]!.edited).toBe(true);
  });

  it("recalculates length and the spoken estimate for the words as they stand", () => {
    const s = written(A, fitting("x"));
    const shorter = withSpeech({ ...s, scenes: s.scenes.map((x) => ({ ...x, line: words(5) })) }, 2.5, 30);
    expect(shorter.speech!.words).toBe(20);
    expect(shorter.speech!.estimatedSeconds).toBeLessThan(s.speech!.estimatedSeconds);
    expect(shorter.speech!.fit).toBe("short");
    expect(shorter.durationSeconds).toBeGreaterThan(0);
  });

  it("checks again a figure the operator typed in", () => {
    const s = written(A, fitting("x"));
    const draft = s.scenes.map((x) => ({ ...x }));
    draft[0] = { ...draft[0]!, line: "We checked 9000 roofs last year." };
    const out = applyDraft(s, { scenes: draft }, { requestedSeconds: 30, corpus: "Kestrel Roofing", assetIds: [], claims: [] });
    expect(out.warnings.join(" ")).toMatch(/9000|recorded source/);
    expect(out.scenes[0]!.edited).toBe(true);
  });
});

describe("changing one version", () => {
  const stubWrite = (calls: Array<{ angle: AnglePlan; opts: Record<string, unknown>; seconds: number }>) =>
    (async (ctx: { targetSeconds: number }, a: AnglePlan, opts: Record<string, unknown> = {}) => {
      calls.push({ angle: a, opts, seconds: ctx.targetSeconds });
      return written(a, fitting(`new${a.id}`));
    }) as never;

  const three = () => [written(A, fitting("a")), written(B, fitting("b")), written(C, fitting("c"))];

  it("replaces only that version and leaves the others exactly as they were", async () => {
    const scripts = three();
    const calls: Array<{ angle: AnglePlan; opts: Record<string, unknown>; seconds: number }> = [];
    const out = await reviseVersion(project(scripts), { scriptId: scripts[1]!.id, action: "regenerate" }, { write: stubWrite(calls) });
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(scripts[0]);
    expect(out[2]).toBe(scripts[2]);
    expect(out[1]!.id).toBe(scripts[1]!.id);
    expect(out[1]!.scenes[0]!.line).toContain("newb");
    // it was written from the same angle, and told what the other versions open with
    expect(calls[0]!.angle.id).toBe("b");
    expect(calls[0]!.opts.avoidOpenings).toEqual([scripts[0]!.hook!.line, scripts[2]!.hook!.line]);
  });

  it("keeps the scenes the operator edited, including edits not saved yet", async () => {
    const scripts = three();
    const draft = scripts[0]!.scenes.map((s) => ({ ...s }));
    draft[2] = { ...draft[2]!, line: "A line I wrote myself." };
    const calls: Array<{ angle: AnglePlan; opts: Record<string, unknown>; seconds: number }> = [];
    await reviseVersion(project(scripts), { scriptId: scripts[0]!.id, action: "rewrite_delivery", instruction: "More like a neighbour talking", draft: { scenes: draft } }, { write: stubWrite(calls) });
    const previous = calls[0]!.opts.previous as VideoScript;
    expect(previous.scenes[2]!.edited).toBe(true);
    expect(previous.scenes[2]!.line).toBe("A line I wrote myself.");
    expect(calls[0]!.opts.delivery).toBe("More like a neighbour talking");
    expect(calls[0]!.angle.id).toBe("a");
  });

  it("asks for a different angle that differs from the other versions, from the same facts, and starts clean", async () => {
    plannedFresh = angle("d", "Angle D");
    const scripts = three();
    const calls: Array<{ angle: AnglePlan; opts: Record<string, unknown>; seconds: number }> = [];
    const out = await reviseVersion(project(scripts), { scriptId: scripts[2]!.id, action: "change_angle", instruction: "Focus on the insurance paperwork" }, { write: stubWrite(calls) });
    expect(calls[0]!.angle.id).toBe("d");
    expect(calls[0]!.opts.previous).toBeUndefined();
    expect(calls[0]!.opts.direction).toBe("Focus on the insurance paperwork");
    expect(out[2]!.id).toBe(scripts[2]!.id);
    expect(out[2]!.angle.name).toBe("Angle D");
  });

  it("says so when the page cannot support another angle, instead of forcing one", async () => {
    plannedFresh = null;
    const scripts = three();
    await expect(reviseVersion(project(scripts), { scriptId: scripts[0]!.id, action: "change_angle" }, { write: stubWrite([]) })).rejects.toThrow(/supported by the page/);
  });

  it("writes to a new length, and needs one", async () => {
    const scripts = three();
    const calls: Array<{ angle: AnglePlan; opts: Record<string, unknown>; seconds: number }> = [];
    await reviseVersion(project(scripts), { scriptId: scripts[0]!.id, action: "retime", seconds: 45 }, { write: stubWrite(calls) });
    expect(calls[0]!.seconds).toBe(45);
    expect(String(calls[0]!.opts.delivery)).toMatch(/45 seconds/);
    await expect(reviseVersion(project(scripts), { scriptId: scripts[0]!.id, action: "retime" }, { write: stubWrite([]) })).rejects.toThrow(/how long/i);
  });

  it("sends the new version through the real editor: a fabricated testimonial stays a hard failure", async () => {
    const scripts = three();
    const bad = async (_ctx: unknown, a: AnglePlan) => written(a, ["I used this product and my business doubled in a month.", words(18, "q"), words(18, "r"), words(18, "s")], { dramatisation: false });
    const out = await reviseVersion(project(scripts), { scriptId: scripts[0]!.id, action: "regenerate" }, { write: bad as never });
    const edited = out[0]!;
    expect(edited.editorial).toBeTruthy();
    expect(edited.editorial!.hardFailures.length).toBeGreaterThan(0);
    expect(edited.verification).toBeTruthy();
    // untouched versions carry no editorial report of their own from this call
    expect(out[1]).toBe(scripts[1]);
  });

  it("refuses when the scripts were written before the brief existed or the version is unknown", async () => {
    const scripts = three();
    const p = project(scripts);
    p.brand!.brief = null;
    await expect(reviseVersion(p, { scriptId: scripts[0]!.id, action: "regenerate" })).rejects.toThrow(/before the creative brief existed/);
    await expect(reviseVersion(project(scripts), { scriptId: "nope", action: "regenerate" })).rejects.toThrow(/not part of this project/);
  });
});
