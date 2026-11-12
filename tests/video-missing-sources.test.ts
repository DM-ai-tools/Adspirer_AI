import { describe, expect, it } from "vitest";
import { adaptToMissingSources, dropUnsourcedStats, type VideoScene, type VideoScript } from "@/lib/video/script";
import type { ApprovedClaim } from "@/lib/video/pipeline-types";

const scene = (number: number, over: Partial<VideoScene>): VideoScene => ({ number, start: 0, end: 3, seconds: 3, visual: "A founder at a desk.", camera: "c", speaker: "voiceover", line: "Hook.", keywords: [], stat: null, assetId: null, sound: "", ...over });
const script = (scenes: VideoScene[]): VideoScript =>
  ({ id: "s", title: "t", scenes, adCopy: { primaryText: "Grow.", headline: "Grow", description: "d", cta: "Learn More" } }) as unknown as VideoScript;
const claims: ApprovedClaim[] = [];

describe("a figure with no recorded source", () => {
  it("is left off the screen and its scene is told to picture the situation instead", () => {
    const s = script([scene(1, { line: "Hook." }), scene(4, { line: "Clients went 8-figures.", stat: "8-figures", visual: "A big number card." })]);
    const { script: out, adjustments } = adaptToMissingSources(s, claims);
    expect(out.scenes[1]!.stat).toBeNull();
    expect(out.scenes[1]!.visual).toMatch(/CHANGED: .*no recorded source.*footage instead/);
    expect(adjustments).toEqual([expect.objectContaining({ scene: 4, change: expect.stringMatching(/not shown on screen/) })]);
    // The other scene is untouched.
    expect(out.scenes[0]).toBe(s.scenes[0]);
  });

  it("re-pictures a scene that shows a report or result even when no figure is drawn", () => {
    const s = script([scene(2, { line: "Revenue doubled.", visual: "A dashboard showing the results climbing." })]);
    const { script: out, adjustments } = adaptToMissingSources(s, claims);
    expect(out.scenes[0]!.visual).toMatch(/show no number, chart, report or screen/);
    expect(adjustments[0]).toMatchObject({ scene: 2, change: expect.stringMatching(/no longer shows a report, chart or screen/) });
  });

  it("leaves a scene whose picture does not depend on the figure, and keeps the spoken line as written", () => {
    const s = script([scene(3, { line: "Revenue doubled.", visual: "A founder smiles in a bright studio." })]);
    const { script: out, adjustments } = adaptToMissingSources(s, claims);
    expect(out.scenes[0]).toBe(s.scenes[0]);
    expect(out.scenes[0]!.line).toBe("Revenue doubled.");
    expect(adjustments).toEqual([]);
  });

  it("changes nothing when every figure has a source", () => {
    const backed: ApprovedClaim[] = [{ id: "c1", text: "8-figures", kind: "number", figure: "8", evidence: "x", provenance: { source: "page_text", detail: "d", confidence: "high" } } as unknown as ApprovedClaim];
    const s = script([scene(1, { line: "Clients went 8-figures.", stat: "8-figures" })]);
    expect(adaptToMissingSources(s, backed).adjustments).toEqual([]);
  });

  it("dropUnsourcedStats only removes the unsourced on-screen figures", () => {
    const s = script([scene(1, { stat: "doubled" }), scene(2, { stat: null })]);
    expect(dropUnsourcedStats(s, claims).scenes.map((x) => x.stat)).toEqual([null, null]);
    expect(dropUnsourcedStats(script([scene(1, {})]), claims).scenes[0]!.stat).toBeNull();
  });
});
