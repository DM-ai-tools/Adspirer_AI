import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { chooseLogoTreatment, contentBox, keyOutBackground, prepareLogo, visibleLuminance } from "@/lib/creatives/logo-prep";

/** A 20x20 RGBA logo: white background, a dark ring, a white centre inside the ring. */
function ringOnWhite(): Uint8Array {
  const w = 20;
  const data = new Uint8Array(w * w * 4).fill(255);
  for (let y = 0; y < w; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const ring = x >= 5 && x <= 14 && y >= 5 && y <= 14;
      const centre = x >= 8 && x <= 11 && y >= 8 && y <= 11;
      if (ring && !centre) {
        const i = (y * w + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      }
    }
  }
  return data;
}

describe("removing a logo's plain background", () => {
  it("makes the backdrop transparent but keeps a white letter enclosed by the mark", () => {
    const data = ringOnWhite();
    expect(keyOutBackground(data, 20, 20)).toBe(true);
    const alpha = (x: number, y: number) => data[(y * 20 + x) * 4 + 3]!;
    expect(alpha(0, 0)).toBe(0);
    expect(alpha(19, 19)).toBe(0);
    expect(alpha(5, 5)).toBe(255); // the ring
    expect(alpha(9, 9)).toBe(255); // the white centre is part of the logo
  });

  it("leaves a logo that is already transparent, or has no flat backdrop, alone", () => {
    const transparent = ringOnWhite();
    transparent[3] = 0;
    expect(keyOutBackground(transparent, 20, 20)).toBe(false);

    const uneven = ringOnWhite();
    uneven[0] = 0; // top-left corner is a different colour from the others
    uneven[1] = 0;
    uneven[2] = 0;
    expect(keyOutBackground(uneven, 20, 20)).toBe(false);
  });

  it("finds the logo's own box and its brightness", () => {
    const data = ringOnWhite();
    keyOutBackground(data, 20, 20);
    expect(contentBox(data, 20, 20)).toEqual({ left: 5, top: 5, width: 10, height: 10 });
    // Dark ring plus the white centre that was kept.
    expect(visibleLuminance(data)).toBeGreaterThan(20);
    expect(visibleLuminance(data)).toBeLessThan(120);
  });
});

describe("how a logo sits on the spot behind it", () => {
  it("pastes it straight on when it reads there", () => {
    expect(chooseLogoTreatment(240, 40)).toEqual({ kind: "direct" }); // dark logo on light
    expect(chooseLogoTreatment(30, 230)).toEqual({ kind: "direct" }); // light logo on dark
  });

  it("uses a white plate for a dark logo on a dark spot, never a black one", () => {
    expect(chooseLogoTreatment(30, 40)).toEqual({ kind: "plate", color: "#ffffff" });
    expect(chooseLogoTreatment(120, 60)).toEqual({ kind: "plate", color: "#ffffff" });
  });

  it("uses a dark plate only for a light logo on a light spot", () => {
    expect(chooseLogoTreatment(235, 240)).toEqual({ kind: "plate", color: "#1f2430" });
  });
});

describe("prepareLogo", () => {
  async function whiteWithBar(): Promise<Buffer> {
    const bar = await sharp({ create: { width: 60, height: 20, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
    return sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: bar, left: 20, top: 20 }])
      .png()
      .toBuffer();
  }

  it("returns a transparent logo cropped to its own shape", async () => {
    const prepared = await prepareLogo(await whiteWithBar(), { maxSize: 100 });
    expect(prepared.backgroundRemoved).toBe(true);
    expect(prepared.luminance).toBeLessThan(40);
    const meta = await sharp(prepared.png).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect([meta.width, meta.height]).toEqual([60, 20]);
  });

  it("does not wipe out a flat single-colour image", async () => {
    const flat = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 200, b: 10 } } }).png().toBuffer();
    const prepared = await prepareLogo(flat, { maxSize: 40 });
    expect(prepared.backgroundRemoved).toBe(false);
    const meta = await sharp(prepared.png).metadata();
    expect([meta.width, meta.height]).toEqual([40, 40]);
  });
});
