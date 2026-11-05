import { describe, expect, it } from "vitest";
import { AD_ANGLES, planCreativeSet } from "@/lib/creatives/creative-styles";
import { buildConceptPrompt } from "@/lib/creatives/concept-writer";
import {
  fallbackSizeFor,
  generationSize,
  parseImageFormat,
  readAspectMarker,
  stripAspectMarker,
  withAspectMarker,
} from "@/lib/creatives/formats";

describe("planCreativeSet", () => {
  it("never repeats an angle within a batch, across many draws", () => {
    for (let i = 0; i < 200; i += 1) {
      const plan = planCreativeSet(5);
      expect(new Set(plan.map((p) => p.angle.key)).size).toBe(5);
    }
  });
  it("assigns angles only: the look of each image is left to the writer", () => {
    expect(Object.keys(planCreativeSet(1)[0]!)).toEqual(["angle"]);
    expect(AD_ANGLES.length).toBeGreaterThanOrEqual(8);
  });
  it("puts each angle and the concept-first brief in the concept prompt", () => {
    const plan = planCreativeSet(3);
    const prompt = buildConceptPrompt(
      { clientId: "c", serviceId: null, count: 3, brand: { name: "Acme" }, business: {}, offer: { name: "Audits" } },
      plan,
    );
    for (const p of plan) expect(prompt).toContain(p.angle.name);
    expect(prompt).toMatch(/CONCEPT FIRST/);
  });
});

describe("wide image formats", () => {
  it("renders each shape natively at a size with edges in multiples of 16", () => {
    for (const f of ["1:1", "4:5", "9:16", "16:9", "1.91:1"] as const) {
      const [w, h] = generationSize(f).split("x").map(Number);
      expect(w! % 16).toBe(0);
      expect(h! % 16).toBe(0);
      expect(Math.max(w!, h!) / Math.min(w!, h!)).toBeLessThanOrEqual(3);
    }
    expect(fallbackSizeFor("16:9")).toBe("1536x1024");
    expect(fallbackSizeFor("4:5")).toBe("1024x1536");
  });
  it("reads wide formats from words", () => {
    expect(parseImageFormat("1.91:1")).toBe("1.91:1");
    expect(parseImageFormat("landscape")).toBe("16:9");
  });
  it("keeps the shape on a draft so a rework stays in it", () => {
    const marked = withAspectMarker("STYLE: x.", "9:16");
    expect(readAspectMarker(marked)).toBe("9:16");
    expect(stripAspectMarker(marked)).toBe("STYLE: x.");
    expect(readAspectMarker("STYLE: old draft")).toBeNull();
    expect(readAspectMarker(withAspectMarker(marked, "16:9"))).toBe("16:9");
  });
});

import { findSimilarOnImageText } from "@/lib/creatives/concept-writer";
import { splitDirection } from "@/lib/creatives/variations";

describe("on-image wording varies across a set", () => {
  const t = (headline: string, highlights: string[]) => ({ headline, highlights, cta_label: "Go" });
  it("flags a shared headline or chip, and passes a varied set", () => {
    expect(findSimilarOnImageText([t("Scale Your Ecommerce Store", ["3x ROI"]), t("Scale Your Ecommerce Sales", ["Free audit"])])).toMatch(/headline/);
    expect(findSimilarOnImageText([t("Profit first", ["3x ROI"]), t("Stop wasting ad spend", ["3x roi"])])).toMatch(/highlight/);
    expect(findSimilarOnImageText([t("Profit first, proof always", ["3x ROI"]), t("Stop wasting ad spend", ["Free audit"])])).toBeNull();
  });
});

describe("splitDirection", () => {
  it("separates the printed words from the style so variations can reword only those", () => {
    const { base, onImage } = splitDirection('STYLE: Poster. A big idea.\nON-IMAGE TEXT (typeset): headline "X".\nASPECT: 9:16');
    expect(base).toBe("STYLE: Poster. A big idea.");
    expect(onImage).toMatch(/^ON-IMAGE TEXT/);
  });
});
