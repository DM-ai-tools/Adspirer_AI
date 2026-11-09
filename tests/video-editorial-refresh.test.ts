import { describe, expect, it } from "vitest";
import { refreshEditorial } from "@/lib/video/editorial";
import type { VideoScript } from "@/lib/video/script";
import type { CreativeBrief, EditorialReport } from "@/lib/video/script-types";

const brief = { version: 1, createdAt: "", company: { name: "Kestrel Roofing", source: "m" }, offer: { name: "Roof inspection", description: "", factIds: [] }, conversion: { action: "Book an inspection", target: null, benefit: null, factIds: [] }, audience: { primary: "Homeowners", situation: "", factIds: [], inferred: true }, mechanism: null, facts: [], inferences: [], rejectedFacts: [], voice: { tone: "plain", vocabulary: [], avoid: [] }, defaults: [], gaps: [], sourceQuality: "rich", limitation: null, injectionFlags: [] } as CreativeBrief;
const ctx = { brief, angles: [], facts: "", claims: [], sourceText: "Book an inspection online. Inspections are free for homeowners with a storm claim.", wordsPerSecond: 2.5, targetSeconds: 15, assetIds: [], locale: "en-AU" };
const stale: EditorialReport = { passes: 1, fixes: [], open: [{ scene: 2, severity: "hard", area: "offer", problem: "The call to action promises something free that the page does not offer.", fix: "x" }], hardFailures: [{ scene: 2, severity: "hard", area: "offer", problem: "stale", fix: "x" }], limitation: null, signals: { opening: 7, naturalness: 7, specificity: 7 }, checkedAt: "" };

const script = (lines: string[]): VideoScript =>
  ({
    id: "s",
    title: "t",
    scenes: lines.map((line, i) => ({ number: i + 1, start: i * 4, end: i * 4 + 4, seconds: 4, visual: "A roof being photographed", camera: "static", speaker: "voiceover", line, keywords: [], stat: null, assetId: null, sound: "" })),
    adCopy: { primaryText: "x", headline: "h", description: "d", cta: "Book Now" },
    cta: { spoken: lines[lines.length - 1], label: "Book Now", target: null, benefit: null },
    dramatisation: true,
    warnings: [],
    editorial: stale,
    verification: { score: 7, verdict: "needs_review", summary: "Strong opening. Weak close.", fixes: [], issues: [], checkedAt: "" },
  }) as unknown as VideoScript;

describe("refreshing the report after later changes", () => {
  it("no longer lists a hard failure that was corrected, and keeps what the editor did and rated", () => {
    const fixed = refreshEditorial(script(["Hail hides damage in the shingle mat, where the bruises crack months later.", "Our crew climbs up and photographs every damaged area for the report your insurer wants.", "Book an inspection online."]), ctx);
    expect(fixed.editorial!.hardFailures).toEqual([]);
    expect(fixed.editorial!.open.some((i) => i.severity === "hard")).toBe(false);
    expect(fixed.editorial!.signals.opening).toBe(7);
    expect(fixed.verification!.score).toBe(7);
    expect(fixed.verification!.summary).toMatch(/Strong opening/);
  });

  it("still lists a hard failure that is really there", () => {
    const bad = refreshEditorial(script(["Hail hides damage in the shingle mat, where the bruises crack months later.", "Our crew climbs up and photographs every damaged area for the report your insurer wants.", "Book your free inspection online."]), ctx);
    expect(bad.editorial!.hardFailures.length).toBeGreaterThan(0);
    expect(bad.editorial!.hardFailures[0]!.problem).toMatch(/free/);
  });

  it("returns a script with no editorial report unchanged", () => {
    const s = { ...script(["Hello."]), editorial: undefined } as unknown as VideoScript;
    expect(refreshEditorial(s, ctx)).toBe(s);
  });
});
