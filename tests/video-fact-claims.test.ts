import { describe, expect, it } from "vitest";
import { claimsFromFacts, effectiveClaims, mergeClaims } from "@/lib/video/claims";
import { blockedReason } from "@/lib/video/generation";
import { claimNotice } from "@/lib/video/pipeline";
import type { BrandManifest } from "@/lib/video/pipeline-types";
import type { VideoScene, VideoScript } from "@/lib/video/script";
import type { BriefFact } from "@/lib/video/script-types";
import type { VideoProject } from "@/lib/video/projects";

// The case that blocked a real script: the page says "a 30-90 day plan", the brief verified it with a quote,
// but the manifest's own claim list (built from a shorter stretch of the page) never saw that sentence.

const prov = { source: "page_text" as const, detail: "Landing page", confidence: "medium" as const };
const manifest = (): BrandManifest =>
  ({
    version: 1, createdAt: "", clientId: "c", projectId: "p", sourceUrl: { value: "https://a.example", provenance: [prov] }, name: { value: "Acme", provenance: [prov] }, nameCandidates: [], internalLabels: [], logo: null, logoCandidates: [],
    colors: { value: [], provenance: [] }, offer: { value: null, provenance: [] }, cta: { value: null, provenance: [] }, audience: { value: null, provenance: [] },
    claims: [{ id: "claim_5", text: "FREE 30-MINUTE GOOGLE ADS AUDIT", kind: "number", figure: "30", evidence: "FREE 30-MINUTE", provenance: prov }, { id: "claim_8", text: "Trusted by 1,500+ Australian Businesses", kind: "number", figure: "1,500+", evidence: "x", provenance: prov }],
    allowTextOnlyBrand: true, conflicts: [], issues: [],
  }) as BrandManifest;

const facts: BriefFact[] = [
  { id: "f10", text: "The audit includes a 30–90 day Google Ads roadmap.", category: "mechanism", source: { id: "p", kind: "page", label: "Landing page", quote: "A 30–90 day plan that will quickly boost conversions, sales, and returns." } },
  { id: "f2", text: "No figures in this one.", category: "feature", source: { id: "p", kind: "page", label: "Landing page", quote: "Clear priorities, no fluff." } },
];

const scene = (number: number, line: string): VideoScene => ({ number, start: 0, end: 3, seconds: 3, visual: "v", camera: "c", speaker: "voiceover", line, keywords: [], stat: null, assetId: null, sound: "" });
const script = (primaryText: string): VideoScript => ({ id: "s", title: "t", scenes: [scene(1, "Hook."), scene(2, "Book it.")], adCopy: { primaryText, headline: "Audit", description: "d", cta: "Learn More" } }) as unknown as VideoScript;

describe("figures in the brief's verified facts count as sourced", () => {
  it("takes every figure of a verified fact, including both ends of a range", () => {
    const out = claimsFromFacts(facts);
    expect(out.map((c) => c.figure)).toEqual(["30", "90"]);
    expect(out[0]!.evidence).toMatch(/30–90 day plan/);
    expect(out[0]!.provenance.source).toBe("page_text");
  });

  it("adds them to the manifest's claims without repeating a figure that is already there", () => {
    const merged = effectiveClaims({ manifest: manifest(), brief: { facts } });
    expect(merged.map((c) => c.figure)).toEqual(["30", "1,500+", "90"]);
    expect(mergeClaims(merged, claimsFromFacts(facts))).toHaveLength(merged.length);
    expect(effectiveClaims({ manifest: manifest(), brief: null })).toHaveLength(2);
    expect(effectiveClaims(null)).toEqual([]);
  });

  it("no longer warns about a script whose figure the page states, and still warns about one that no source states", () => {
    const m = manifest();
    const ok = script("A prioritised 30 to 90 day action plan, and trusted by over 1,500 businesses.");
    // the old check, with the manifest's claims alone, refuses it
    expect(claimNotice(ok, m)).toMatch(/"90"/);
    // with the verified facts counted it passes
    expect(claimNotice(ok, m, effectiveClaims({ manifest: m, brief: { facts } }))).toBeNull();
    const invented = script("We have helped 4,000 clients and delivered a 95 day plan.");
    expect(claimNotice(invented, m, effectiveClaims({ manifest: m, brief: { facts } }))).toMatch(/no recorded source/);
  });

  it("the Generate video gate counts the verified facts, and a figure with no source never blocks it", () => {
    const project = { chosen_script: script("A prioritised 30 to 90 day action plan."), brand: { name: "Acme", colors: null, logoUrl: null, summary: null, manifest: manifest(), brief: { facts } }, assets: [], inputs: { format: "9:16", priority: "balanced" } } as unknown as VideoProject;
    expect(blockedReason(project) ?? "").not.toMatch(/no recorded source/);
    const without = { ...project, brand: { ...project.brand!, brief: { facts: [] } } } as unknown as VideoProject;
    // Nothing is checked at the gate any more: the missing source is a notice, and the video is still made.
    expect(blockedReason(without) ?? "").not.toMatch(/no recorded source/);
    expect(claimNotice(without.chosen_script!, without.brand!.manifest!, effectiveClaims(without.brand))).toMatch(/video can still be made/);
  });
});
