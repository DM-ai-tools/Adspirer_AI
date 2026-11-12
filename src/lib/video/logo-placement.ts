import { generateObject } from "ai";
import { z } from "zod";
import { logger } from "@/lib/observability/logger";
import { extractFramesAt } from "@/lib/video/clip-qa";
import { faceSampleTimes } from "@/lib/video/face-bands";
import { modelCandidates, withModelFallback } from "@/lib/video/model-fallback";
import type { Layout } from "@/lib/video/layout";

/**
 * Where the logo goes on a finished video, decided by looking at the video. A few frames are taken,
 * the candidate places are drawn on them as labelled boxes, and a vision model picks the box that
 * stays clear of faces, the subject and busy detail for the whole video, and how large the logo can
 * be there. Without a vision model, the calmest box (least detail, measured from the pixels) is used.
 * Every candidate is inside the area Reels and Stories leave free of their own buttons and text.
 */

export type LogoSpot = { id: string; label: string; x: number; y: number };
export type LogoPlacement = { x: number; y: number; width: number; spot: string; reason: string; by: "vision" | "pixels" | "default" };

/** How wide the logo plate may be, as a share of the frame width. Bigger than the old fixed 20%. */
export const LOGO_SIZES = { medium: 0.26, large: 0.32 } as const;

/** The places a logo may go: top left, top centre and top right, just inside the platform's safe area. */
export function logoSpots(layout: Layout, width: number, heightFraction: number): LogoSpot[] {
  const margin = 0.05;
  const y = layout.safe.top + 0.012;
  const spots: LogoSpot[] = [
    { id: "A", label: "top left", x: margin, y },
    { id: "B", label: "top centre", x: (1 - width) / 2, y },
    { id: "C", label: "top right", x: 1 - margin - width, y },
  ];
  // A frame with room under the top band (4:5 and 1:1 have small safe margins) may also use the lower left corner, above the captions.
  if (layout.captionY - y > 0.5) spots.push({ id: "D", label: "lower left", x: margin, y: Math.max(y, layout.captionY - 0.12 - heightFraction) });
  return spots;
}

/** The boxes drawn onto a frame for the model to compare, with their letters. */
async function framesWithBoxes(frames: Array<{ bytes: Buffer }>, spots: LogoSpot[], width: number, heightFraction: number): Promise<Buffer[]> {
  const sharp = (await import("sharp")).default;
  return Promise.all(
    frames.map(async (f) => {
      const img = sharp(f.bytes);
      const meta = await img.metadata();
      const W = meta.width ?? 360;
      const H = meta.height ?? 640;
      const boxes = spots
        .map((s) => {
          const x = Math.round(s.x * W);
          const y = Math.round(s.y * H);
          const w = Math.round(width * W);
          const h = Math.max(8, Math.round(heightFraction * H));
          return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff2d55" stroke-width="3"/><text x="${x + 6}" y="${y + Math.min(h - 4, 22)}" font-family="Arial" font-size="20" font-weight="bold" fill="#ff2d55" stroke="#ffffff" stroke-width="1">${s.id}</text>`;
        })
        .join("");
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${boxes}</svg>`);
      return img.composite([{ input: svg, left: 0, top: 0 }]).jpeg({ quality: 80 }).toBuffer();
    }),
  );
}

/** Detail inside a box (the spread of brightness): a calm wall scores low, a face or a busy shelf high. */
export async function busyness(frame: Buffer, box: { x: number; y: number; width: number; height: number }): Promise<number> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(frame).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const left = Math.max(0, Math.min(W - 2, Math.round(box.x * W)));
  const top = Math.max(0, Math.min(H - 2, Math.round(box.y * H)));
  const width = Math.max(2, Math.min(W - left, Math.round(box.width * W)));
  const height = Math.max(2, Math.min(H - top, Math.round(box.height * H)));
  // stats() reads the whole input, not the crop: the crop is made into its own image first.
  const crop = await sharp(frame).extract({ left, top, width, height }).greyscale().png().toBuffer();
  const stats = await sharp(crop).stats();
  return stats.channels[0]?.stdev ?? 0;
}

const choiceSchema = z.object({
  spot: z.string().describe("The letter of the best box"),
  size: z.enum(["medium", "large"]).describe("large when the chosen box and the space around it stay clear in every frame; otherwise medium"),
  reason: z.string().describe("One short sentence: why this place reads best and covers nothing important"),
});

export type LogoChooser = (frames: Buffer[], spots: LogoSpot[]) => Promise<{ spot: string; size: "medium" | "large"; reason: string }>;

export function createLogoChooser(): LogoChooser | null {
  const candidates = modelCandidates();
  if (!candidates.length) return null;
  return async (frames, spots) => {
    const content: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }> = [
      {
        type: "text",
        text: [
          "These are frames from one vertical video ad, taken across its length. Each has the same lettered boxes drawn on it: the places a brand logo could sit for the whole video.",
          `Boxes: ${spots.map((s) => `${s.id} = ${s.label}`).join(", ")}.`,
          "Choose the ONE box where a logo would look best and cover nothing that matters in ANY frame: never over a face, head, hands or the main subject, and preferably over calm background (wall, sky, floor) rather than busy detail. Prefer a top corner on the side away from the person. Say whether the logo can be large there.",
        ].join("\n"),
      },
    ];
    frames.forEach((f, i) => {
      content.push({ type: "text", text: `Frame ${i + 1}:` });
      content.push({ type: "image", image: new Uint8Array(f), mediaType: "image/jpeg" });
    });
    return withModelFallback(async (model) => (await generateObject({ model, schema: choiceSchema, temperature: 0, messages: [{ role: "user", content }] })).object, candidates);
  };
}

/**
 * The logo's place and size for this video. `aspect` is the logo plate's height divided by its width.
 * Never throws: when the frames cannot be read it keeps the usual top-left place at the medium size.
 */
export async function placeLogo(
  file: string,
  seconds: number,
  dir: string,
  layout: Layout,
  frameAspect: number,
  aspect: number,
  chooser: LogoChooser | null = createLogoChooser(),
): Promise<LogoPlacement> {
  const fallback = (reason: string): LogoPlacement => ({ x: 0.05, y: layout.safe.top + 0.012, width: LOGO_SIZES.medium, spot: "top left", reason, by: "default" });
  try {
    const times = faceSampleTimes(seconds, 3, 6);
    const frames = await extractFramesAt(file, times, dir, { width: 360 });
    if (!frames.length) return fallback("No frames could be read, so the logo keeps its usual place.");
    // Box height as a share of the frame height, for the large size (the safest check).
    const heightAt = (w: number) => (w * aspect) / frameAspect;
    const spots = logoSpots(layout, LOGO_SIZES.large, heightAt(LOGO_SIZES.large));

    if (chooser) {
      try {
        const marked = await framesWithBoxes(frames, spots, LOGO_SIZES.large, heightAt(LOGO_SIZES.large));
        const pick = await chooser(marked, spots);
        const spot = spots.find((s) => s.id === pick.spot.trim().toUpperCase().slice(0, 1));
        if (spot) {
          const width = LOGO_SIZES[pick.size];
          // Re-anchor for the chosen size, so a right or centre placement stays aligned to its edge.
          const x = spot.id === "C" ? 1 - 0.05 - width : spot.id === "B" ? (1 - width) / 2 : spot.x;
          return { x, y: spot.y, width, spot: spot.label, reason: pick.reason, by: "vision" };
        }
      } catch (error) {
        logger.warn("Vision logo placement failed; using the calmest corner", { error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Without a vision model: the box with the least detail across the frames (a face or the subject is busy; a wall is calm).
    const scored = await Promise.all(
      spots.map(async (s) => {
        const scores = await Promise.all(frames.map((f) => busyness(f.bytes, { x: s.x, y: s.y, width: LOGO_SIZES.large, height: heightAt(LOGO_SIZES.large) })));
        return { s, score: Math.max(...scores) };
      }),
    );
    scored.sort((a, b) => a.score - b.score);
    const best = scored[0]!;
    const width = best.score < 28 ? LOGO_SIZES.large : LOGO_SIZES.medium;
    const x = best.s.id === "C" ? 1 - 0.05 - width : best.s.id === "B" ? (1 - width) / 2 : best.s.x;
    return { x, y: best.s.y, width, spot: best.s.label, reason: `The calmest place across ${frames.length} frames.`, by: "pixels" };
  } catch (error) {
    return fallback(`The frames could not be read (${error instanceof Error ? error.message : String(error)}), so the logo keeps its usual place.`);
  }
}
