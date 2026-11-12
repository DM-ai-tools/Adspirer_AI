import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "@/lib/video/ffmpeg";
import { layoutFor } from "@/lib/video/layout";
import { LOGO_SIZES, logoSpots, placeLogo, type LogoChooser } from "@/lib/video/logo-placement";

/** A vertical frame: calm grey everywhere, with heavy detail (a stand-in for a face or a busy shelf) over the top left. */
async function frameWithBusyTopLeft(): Promise<Buffer> {
  const W = 540;
  const H = 960;
  const noise = Buffer.alloc(220 * 160 * 3);
  // Big black and white blocks: real detail that survives video compression (a fine pattern averages to grey).
  for (let y = 0; y < 160; y += 1) for (let x = 0; x < 220; x += 1) noise.fill(((x >> 4) + (y >> 4)) % 2 ? 255 : 0, (y * 220 + x) * 3, (y * 220 + x) * 3 + 3);
  const busy = await sharp(noise, { raw: { width: 220, height: 160, channels: 3 } }).png().toBuffer();
  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 120, g: 120, b: 120 } } })
    .composite([{ input: busy, left: 20, top: 130 }])
    .png()
    .toBuffer();
}

let dir = "";
let video = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "logo-place-"));
  const png = path.join(dir, "frame.png");
  await writeFile(png, await frameWithBusyTopLeft());
  video = path.join(dir, "v.mp4");
  await runFfmpeg(["-loop", "1", "-t", "4", "-i", png, "-vf", "fps=10,format=yuv420p", "-c:v", "libx264", video]);
}, 60_000);

describe("placing the logo by looking at the video", () => {
  const layout = layoutFor("9:16");

  it("offers places inside the platform's safe area only", () => {
    for (const s of logoSpots(layout, LOGO_SIZES.large, 0.06)) {
      expect(s.y).toBeGreaterThanOrEqual(layout.safe.top);
      expect(s.x).toBeGreaterThanOrEqual(0.04);
      expect(s.x + LOGO_SIZES.large).toBeLessThanOrEqual(0.96);
    }
  });

  it("without a vision model, avoids the busy corner and makes the logo bigger than the old 20%", async () => {
    const p = await placeLogo(video, 4, path.join(dir, "a"), layout, 16 / 9, 0.3, null);
    expect(p.by).toBe("pixels");
    expect(p.spot).not.toBe("top left");
    expect(p.width).toBeGreaterThan(0.2);
  }, 60_000);

  it("uses the vision model's choice and size, anchored to the chosen edge", async () => {
    let seen = 0;
    const chooser: LogoChooser = async (frames, spots) => {
      seen = frames.length;
      expect(spots.map((s) => s.id)).toEqual(["A", "B", "C"]);
      return { spot: "C", size: "large", reason: "Calm wall on the right, away from his face." };
    };
    const p = await placeLogo(video, 4, path.join(dir, "b"), layout, 16 / 9, 0.3, chooser);
    expect(seen).toBeGreaterThan(0);
    expect(p).toMatchObject({ by: "vision", spot: "top right", width: LOGO_SIZES.large });
    expect(p.x + p.width).toBeCloseTo(0.95, 5);
  }, 60_000);

  it("falls back to the pixels when the vision call fails, and never throws", async () => {
    const p = await placeLogo(video, 4, path.join(dir, "c"), layout, 16 / 9, 0.3, async () => {
      throw new Error("overloaded");
    });
    expect(p.by).toBe("pixels");
    const missing = await placeLogo(path.join(dir, "nope.mp4"), 4, path.join(dir, "d"), layout, 16 / 9, 0.3, null);
    expect(missing.by).toBe("default");
  }, 60_000);
});
