import { describe, expect, it } from "vitest";
import { BULK_ANGLES, pickBulkAngles } from "@/lib/creatives/bulk/angles";
import { REFERENCE_CLOSE_COUNT } from "@/lib/creatives/bulk/styles";
import {
  assignStyles,
  closeMatchCount,
  formatStyleBrief,
  hasStyleGuide,
  prepareStyleImages,
  referenceBlock,
  VARIATION_AXES,
  type StyleGuide,
} from "@/lib/creatives/bulk/style-reference";

const guide = (over: Partial<StyleGuide> = {}): StyleGuide => ({ imageBrief: "Medium: moody studio photo", direction: null, matchAll: false, ...over });

describe("hasStyleGuide", () => {
  it("is true for images or words, false for nothing or blank words", () => {
    expect(hasStyleGuide(guide())).toBe(true);
    expect(hasStyleGuide({ imageBrief: null, direction: "dark and moody", matchAll: false })).toBe(true);
    expect(hasStyleGuide({ imageBrief: null, direction: "   ", matchAll: true })).toBe(false);
    expect(hasStyleGuide(null)).toBe(false);
    expect(hasStyleGuide(undefined)).toBe(false);
  });
});

describe("assignStyles", () => {
  const angles = pickBulkAngles(15);

  it("with no reference, draws the usual catalogue: 15 different styles", () => {
    for (const g of [null, undefined, { imageBrief: null, direction: " ", matchAll: true }]) {
      const styles = assignStyles(angles, g);
      expect(styles.size).toBe(15);
      expect(new Set([...styles.values()].map((s) => s.key)).size).toBe(15);
      expect([...styles.values()].every((s) => s.family !== "reference")).toBe(true);
    }
  });

  it("with 'match all', every image follows the reference", () => {
    const styles = assignStyles(angles, guide({ matchAll: true }));
    expect([...styles.values()].every((s) => s.name === "Reference style")).toBe(true);
    expect(styles.size).toBe(15);
  });

  it("by default, the first few follow it closely and the rest are variations that each move a different way", () => {
    const assigned = assignStyles(angles, guide());
    const styles = angles.map((a) => assigned.get(a.key)!);
    const close = styles.slice(0, REFERENCE_CLOSE_COUNT);
    const rest = styles.slice(REFERENCE_CLOSE_COUNT);
    expect(close.every((s) => s.name === "Reference style")).toBe(true);
    expect(rest).toHaveLength(15 - REFERENCE_CLOSE_COUNT);
    expect(rest.every((s) => s.name.startsWith("Reference variation, "))).toBe(true);
    expect(new Set(rest.map((s) => s.name)).size).toBe(rest.length);
  });

  it("has enough ways to vary for the rest of a run", () => {
    expect(VARIATION_AXES.length).toBeGreaterThanOrEqual(15 - REFERENCE_CLOSE_COUNT);
  });

  it("keeps working when there are more variations than ways to vary", () => {
    const many = BULK_ANGLES.slice(0, 24);
    const styles = assignStyles(many, guide());
    expect(styles.size).toBe(24);
  });

  it("works for a reference given only in words", () => {
    const styles = assignStyles(angles, { imageBrief: null, direction: "retro poster look", matchAll: false });
    expect([...styles.values()].every((s) => s.family === "reference")).toBe(true);
  });

  it("style names never contain a full stop (the export reads 'STYLE: name.')", () => {
    for (const s of assignStyles(angles, guide()).values()) expect(s.name).not.toMatch(/\./);
  });

  it("closeMatchCount never exceeds the number of images", () => {
    expect(closeMatchCount(15, true)).toBe(15);
    expect(closeMatchCount(15, false)).toBe(REFERENCE_CLOSE_COUNT);
    expect(closeMatchCount(3, false)).toBe(3);
  });
});

describe("referenceBlock", () => {
  it("shows the image brief and the operator's words as firm rules", () => {
    const text = referenceBlock(guide({ direction: "Real people only. No 3D." }));
    expect(text).toContain("moody studio photo");
    expect(text).toContain("Real people only. No 3D.");
    expect(text).toMatch(/FIRM RULES/);
  });
  it("copes with words only", () => {
    expect(referenceBlock({ imageBrief: null, direction: "bold type poster", matchAll: false })).toContain("bold type poster");
  });
});

describe("formatStyleBrief", () => {
  it("writes every field the writer needs", () => {
    const out = formatStyleBrief({
      medium: "studio photo",
      composition: "centred",
      lighting: "rim light",
      colour_treatment: "muted",
      type_and_graphics: "bold sans",
      mood: "calm",
      subject_matter: "objects",
      signature: ["a", "b"],
      flexible: ["setting"],
    });
    for (const part of ["Medium", "Composition", "Light", "Colour treatment", "Type and graphics", "Mood", "Signature traits", "Free to change"]) expect(out).toContain(part);
  });
});

describe("prepareStyleImages", () => {
  async function png(width: number, height: number): Promise<string> {
    const sharp = (await import("sharp")).default;
    const buf = await sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();
    return `data:image/png;base64,${buf.toString("base64")}`;
  }

  it("turns a picture into a JPEG no bigger than 1280 on a side", async () => {
    const sharp = (await import("sharp")).default;
    const [out] = await prepareStyleImages([await png(3000, 2000)]);
    const meta = await sharp(out!).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1280);
  });

  it("takes at most three", async () => {
    const one = await png(40, 40);
    expect(await prepareStyleImages([one, one, one, one, one])).toHaveLength(3);
  });

  it("refuses a file that is not an image, with a plain message", async () => {
    await expect(prepareStyleImages([`data:image/png;base64,${Buffer.from("not a picture").toString("base64")}`])).rejects.toThrow(/could not be read/);
    await expect(prepareStyleImages(["data:text/html;base64,PGI+"])).rejects.toThrow(/JPG, PNG or WebP/);
    await expect(prepareStyleImages(["data:image/png;base64,"])).rejects.toThrow();
  });
});
