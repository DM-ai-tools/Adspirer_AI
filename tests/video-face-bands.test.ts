import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { runFfmpeg } from "@/lib/video/ffmpeg";
import { bandsForCue, captionCentres, detectFaceBands, faceSampleTimes, type FaceBand, type FaceBandDetector } from "@/lib/video/face-bands";
import { safeCaptionY } from "@/lib/video/subtitles";
import { layoutFor } from "@/lib/video/layout";

describe("keeping captions off faces", () => {
  it("looks often enough across the video that a face never moves far between two looks, and never too often", () => {
    const t = faceSampleTimes(35);
    expect(t.length).toBeGreaterThanOrEqual(10);
    expect(t.length).toBeLessThanOrEqual(16);
    expect(t[0]!).toBeGreaterThan(0);
    expect(t[t.length - 1]!).toBeLessThan(35);
    expect(faceSampleTimes(600).length).toBe(16);
    expect(faceSampleTimes(0)).toEqual([]);
  });

  it("uses the faces seen around a caption, padded, and the nearest look when none fall inside", () => {
    const bands: FaceBand[] = [{ at: 2, top: 0.3, bottom: 0.5 }, { at: 20, top: 0.1, bottom: 0.2 }];
    const samples = [2, 20];
    const near = bandsForCue(bands, samples, 1.5, 3);
    expect(near).toHaveLength(1);
    expect(near[0]!.top).toBeCloseTo(0.28, 2);
    expect(near[0]!.bottom).toBeCloseTo(0.52, 2);
    // a caption at 12-14s has no look inside; the nearer is 20s? no: 2s is 11s away, 20s is 7s away
    expect(bandsForCue(bands, samples, 12, 14)[0]!.top).toBeCloseTo(0.08, 2);
    expect(bandsForCue(bands, [], 1, 2)).toEqual([]);
  });

  it("offers positions inside the free area first and lower ones only as a last resort", () => {
    const layout = layoutFor("9:16");
    const h = 0.06;
    const { inside, lastResort } = captionCentres(layout.captionY, layout.safe, h);
    expect(inside[0]).toBe(layout.captionY);
    for (const c of inside) {
      expect(c - h / 2).toBeGreaterThanOrEqual(layout.safe.top - 1e-9);
      expect(c + h / 2).toBeLessThanOrEqual(1 - layout.safe.bottom + 1e-9);
    }
    for (const c of lastResort) expect(c).toBeGreaterThan(inside[0]!);
  });

  it("moves a caption that would sit on a face to the nearest free place", () => {
    const layout = layoutFor("9:16");
    const h = 0.06;
    const { inside, lastResort } = captionCentres(layout.captionY, layout.safe, h);
    // a close-up: the face fills the usual caption position
    const face = { top: layout.captionY - 0.1, bottom: layout.captionY + 0.05 };
    const centre = safeCaptionY(inside, [face], h) ?? safeCaptionY(lastResort, [face], h);
    expect(centre).not.toBeNull();
    const top = centre! - h / 2;
    const bottom = centre! + h / 2;
    expect(bottom <= face.top || top >= face.bottom).toBe(true);
  });

  describe("on a video", () => {
    let file: string;
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), "faces-"));
      file = path.join(dir, "v.mp4");
      await runFfmpeg(["-f", "lavfi", "-t", "6", "-i", "testsrc2=size=320x568:rate=24", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    }, 60_000);

    it("asks the detector about frames across the video and returns what it found", async () => {
      const seen: number[] = [];
      const detector: FaceBandDetector = async (frames) => {
        seen.push(frames.length);
        return frames.map((f) => ({ at: f.at, top: 0.2, bottom: 0.4 }));
      };
      const out = await detectFaceBands(file, 6, path.join(dir, "w"), detector);
      expect(out.limitation).toBeNull();
      expect(out.samples.length).toBe(seen[0]);
      expect(out.bands.length).toBe(out.samples.length);
    }, 60_000);

    it("says so, and never throws, when there is no detector or it fails", async () => {
      const none = await detectFaceBands(file, 6, path.join(dir, "w2"), null);
      expect(none.bands).toEqual([]);
      expect(none.limitation).toMatch(/could not be placed away from faces/);
      const failing = await detectFaceBands(file, 6, path.join(dir, "w3"), async () => {
        throw new Error("credit balance too low");
      });
      expect(failing.bands).toEqual([]);
      expect(failing.limitation).toMatch(/credit balance too low/);
    }, 60_000);
  });
});
