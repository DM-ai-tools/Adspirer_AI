import { generateObject } from "ai";
import { z } from "zod";
import { logger } from "@/lib/observability/logger";
import { extractFramesAt } from "@/lib/video/clip-qa";
import { modelCandidates, withModelFallback } from "@/lib/video/model-fallback";

/**
 * Where people's faces are in the footage, so captions can be kept off them. A face is found by a
 * vision model looking at sampled frames (there is no face detector in this stack); the answer is the
 * vertical band each face occupies as fractions of the frame height. When it cannot run, captions
 * keep their default place and the final inspection (which also looks for captions over faces)
 * decides whether the video can be delivered.
 */
export type FaceBand = { at: number; top: number; bottom: number };

export type FaceBandDetector = (frames: Array<{ at: number; bytes: Buffer }>) => Promise<FaceBand[]>;

const schema = z.object({
  frames: z.array(
    z.object({
      index: z.number().int().describe("The frame's number as given, starting at 0"),
      faces: z.array(z.object({ top: z.number().min(0).max(1), bottom: z.number().min(0).max(1) })).max(6).describe("Each human face (or head, if the face is turned away) as the top and bottom of its box, as fractions of the frame height from the top"),
    }),
  ),
});

export function createFaceBandDetector(): FaceBandDetector | null {
  const candidates = modelCandidates();
  if (!candidates.length) return null;
  return async (frames) => {
    const content: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }> = [
      { type: "text", text: "For each numbered frame, give the vertical extent of every human face or head visible, as fractions of the frame height (0 = top edge, 1 = bottom edge), from the top of the hair to the bottom of the chin. If no person is visible, give an empty list. Do not guess a face that is not there." },
    ];
    frames.forEach((f, i) => {
      content.push({ type: "text", text: `Frame ${i}:` });
      content.push({ type: "image", image: new Uint8Array(f.bytes), mediaType: "image/jpeg" });
    });
    const object = await withModelFallback(async (model) => (await generateObject({ model, schema, temperature: 0, messages: [{ role: "user", content }] })).object, candidates);
    const out: FaceBand[] = [];
    for (const f of object.frames) {
      const at = frames[f.index]?.at;
      if (at === undefined) continue;
      for (const face of f.faces) if (face.bottom > face.top) out.push({ at, top: face.top, bottom: face.bottom });
    }
    return out;
  };
}

/** Moments to look at: spread across the video, close enough that a face never moves far between two. */
export function faceSampleTimes(seconds: number, every = 2.5, max = 16): number[] {
  if (seconds <= 0) return [];
  const count = Math.min(max, Math.max(2, Math.ceil(seconds / every)));
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * seconds) / count * 100) / 100);
}

/**
 * The bands to keep a caption out of while it is shown: the faces in samples taken during it (a
 * second either side, because a face moves), or the nearest sample if none fall inside.
 */
export function bandsForCue(bands: FaceBand[], samples: number[], start: number, end: number, pad = 0.02): Array<{ top: number; bottom: number }> {
  if (!samples.length) return [];
  const inside = samples.filter((t) => t >= start - 1 && t <= end + 1);
  const used = inside.length ? inside : [samples.reduce((best, t) => (Math.abs(t - (start + end) / 2) < Math.abs(best - (start + end) / 2) ? t : best), samples[0]!)];
  return bands.filter((b) => used.includes(b.at)).map((b) => ({ top: Math.max(0, b.top - pad), bottom: Math.min(1, b.bottom + pad) }));
}

/**
 * Where a caption's centre may go, best first: its usual place, then positions further up and down
 * inside the area Reels and Stories leave free, then (last resort) lower down.
 */
export function captionCentres(usual: number, safe: { top: number; bottom: number }, heightFraction: number): { inside: number[]; lastResort: number[] } {
  const lo = safe.top + heightFraction / 2;
  const hi = 1 - safe.bottom - heightFraction / 2;
  const steps = [0, 0.04, -0.04, 0.08, -0.08, 0.12, -0.12, 0.16, -0.16, 0.2, -0.2, 0.25, -0.25, 0.3, -0.3].map((d) => Math.round((usual + d) * 1000) / 1000);
  const inside = steps.filter((c) => c >= lo && c <= hi);
  const lastResort = [hi + 0.03, hi + 0.06, hi + 0.09].filter((c) => c + heightFraction / 2 <= 0.97);
  return { inside, lastResort };
}

/** Faces by frame for a rendered video: samples it, asks the detector, and never throws (a failure means no bands and a recorded limitation). */
export async function detectFaceBands(file: string, seconds: number, dir: string, detector: FaceBandDetector | null = createFaceBandDetector()): Promise<{ bands: FaceBand[]; samples: number[]; limitation: string | null }> {
  if (!detector) return { bands: [], samples: [], limitation: "No vision model is configured, so captions could not be placed away from faces." };
  try {
    const frames = await extractFramesAt(file, faceSampleTimes(seconds), dir, { width: 360 });
    if (!frames.length) return { bands: [], samples: [], limitation: "No frames could be read to find faces." };
    const bands = await detector(frames.map((f) => ({ at: f.at, bytes: f.bytes })));
    return { bands, samples: frames.map((f) => f.at), limitation: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Face detection for caption placement failed", { error: message });
    return { bands: [], samples: [], limitation: `Faces could not be located (${message}), so captions use their usual place.` };
  }
}
