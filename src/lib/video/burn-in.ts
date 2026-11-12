import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getObjectStorage } from "@/lib/storage/r2";
import { logger } from "@/lib/observability/logger";
import { isSvg } from "@/lib/creatives/openai-image";
import { prepareLogo } from "@/lib/creatives/logo-prep";
import { probe, runFfmpeg } from "@/lib/video/ffmpeg";
import { phraseMarkup } from "@/lib/video/captions";
import { safeCaptionY } from "@/lib/video/subtitles";
import { accentColour, finalSize, layoutFor, type FinalFormat } from "@/lib/video/layout";
import { captionPiece, logoPiece, type Piece } from "@/lib/video/graphics";
import { bandsForCue, captionCentres, detectFaceBands } from "@/lib/video/face-bands";
import { loadManifestLogo } from "@/lib/video/brand-resolve";
import { getProject, updateProject } from "@/lib/video/projects";
import type { FinalVideo } from "@/lib/video/generation-types";

/**
 * A second export of a finished clean video with the subtitles and/or the verified logo drawn in.
 * It is made from the clean MP4 itself (the same picture and sound, already checked), using the
 * subtitle cues written for that export, so the words and their timing match the SRT exactly. The
 * clean MP4 is kept as it is; this is an extra file beside it.
 */

export type GraphicsExport = NonNullable<FinalVideo["withGraphics"]>;

/** Cues read back from the SRT written for the clean export. */
export function parseSrt(srt: string): Array<{ start: number; end: number; text: string }> {
  const time = (t: string) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(t);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : NaN;
  };
  return srt
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.trim().split("\n");
      const timing = lines.findIndex((l) => l.includes("-->"));
      if (timing < 0) return null;
      const [a, b] = lines[timing]!.split("-->");
      const text = lines.slice(timing + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      const start = time(a ?? "");
      const end = time(b ?? "");
      return Number.isFinite(start) && Number.isFinite(end) && end > start && text ? { start, end, text } : null;
    })
    .filter((c): c is { start: number; end: number; text: string } => c !== null);
}

/** What can be added to this export, and why not when it cannot. */
export function graphicsAvailability(final: FinalVideo | null | undefined, hasLogo: boolean): { captions: boolean; logo: boolean; reason: string | null } {
  if (!final || final.state !== "done" || !final.key) return { captions: false, logo: false, reason: "Finish the video first." };
  const captions = Boolean(final.subtitles?.srtKey);
  return { captions, logo: hasLogo, reason: !captions && !hasLogo ? "This export has no subtitle file and the brand has no verified logo." : null };
}

const FPS = 30;

export async function burnInGraphics(projectId: string, options: { captions: boolean; logo: boolean }): Promise<void> {
  const project = await getProject(projectId);
  const final = project?.final;
  if (!project || !final || final.state !== "done" || !final.key) throw new Error("Finish the video before adding a logo or subtitles.");
  if (!options.captions && !options.logo) throw new Error("Choose subtitles, the logo, or both.");
  const startedAt = new Date().toISOString();
  const save = (withGraphics: GraphicsExport) => updateProject(projectId, { final: { ...final, withGraphics } });
  await save({ state: "running", stage: "Preparing", error: null, key: null, captions: options.captions, logo: options.logo, startedAt, createdAt: null, bytes: null });

  const dir = await mkdtemp(path.join(os.tmpdir(), "vid-graphics-"));
  try {
    const storage = getObjectStorage();
    const source = await storage.get(final.key);
    if (!source) throw new Error("The finished video file is missing from storage. Finish the video again.");
    const input = path.join(dir, "clean.mp4");
    await writeFile(input, source);
    const info = await probe(input);
    const seconds = info.seconds;
    const format = project.inputs.format as FinalFormat;
    const { width: W, height: H } = finalSize(format);
    const layout = layoutFor(format);
    const manifest = project.brand?.manifest ?? null;
    const accent = accentColour(manifest?.colors.value.length ? manifest.colors.value : project.brand?.colors);
    const overlays: Array<{ piece: Piece; x: number; y: number; start: number; end: number }> = [];

    if (options.logo) {
      // Only the verified logo, from its stored file; never a stand-in.
      const bytes = manifest ? await loadManifestLogo(manifest, storage) : null;
      if (!bytes) throw new Error("There is no verified logo file to put on the video. Check the brand (or upload the logo) first.");
      const png = (await prepareLogo(bytes, { isSvg: isSvg(bytes) })).png;
      const piece = await logoPiece(png, W, layout.logo.width);
      overlays.push({ piece, x: layout.logo.x * W, y: layout.logo.y * H, start: 0, end: seconds });
    }

    if (options.captions) {
      if (!final.subtitles?.srtKey) throw new Error("This export has no subtitle file to draw from.");
      const srt = await storage.get(final.subtitles.srtKey);
      if (!srt) throw new Error("The subtitle file is missing from storage. Finish the video again.");
      const cues = parseSrt(srt.toString("utf8"));
      await save({ state: "running", stage: "Finding the faces so the subtitles stay clear of them", error: null, key: null, captions: options.captions, logo: options.logo, startedAt, createdAt: null, bytes: null });
      const faces = await detectFaceBands(input, seconds, path.join(dir, "faces"));
      const keywords = (project.chosen_script?.scenes ?? []).flatMap((s) => s.keywords);
      for (const cue of cues) {
        const words = cue.text.split(/\s+/).map((text) => ({ text, start: cue.start, end: cue.end, matched: false }));
        const piece = await captionPiece(phraseMarkup({ words, start: cue.start, end: cue.end }, keywords, accent), W);
        const busy = overlays.filter((o) => o.start < cue.end && o.end > cue.start).map((o) => ({ top: o.y / H, bottom: (o.y + o.piece.height) / H }));
        const heightFraction = piece.height / H;
        const avoid = [...busy, ...bandsForCue(faces.bands, faces.samples, cue.start, cue.end)];
        const { inside, lastResort } = captionCentres(layout.captionY, layout.safe, heightFraction);
        const centre = safeCaptionY(inside, avoid, heightFraction) ?? safeCaptionY(lastResort, avoid, heightFraction) ?? layout.captionY;
        overlays.push({ piece, x: (W - piece.width) / 2, y: centre * H - piece.height / 2, start: Math.max(cue.start, 0), end: Math.min(cue.end, seconds) });
      }
    }

    await save({ state: "running", stage: "Drawing them onto the video", error: null, key: null, captions: options.captions, logo: options.logo, startedAt, createdAt: null, bytes: null });
    const args = ["-i", input];
    const filter: string[] = [];
    let label = "0:v";
    for (const [i, o] of overlays.entries()) {
      const f = path.join(dir, `o${i}.png`);
      await writeFile(f, o.piece.png);
      args.push("-i", f);
      const out = i === overlays.length - 1 ? "vout" : `v${i + 1}`;
      filter.push(`[${label}][${i + 1}:v]overlay=x=${Math.round(o.x)}:y=${Math.round(o.y)}:format=auto:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'[${out}]`);
      label = out;
    }
    if (!overlays.length) filter.push("[0:v]null[vout]");
    const scriptFile = path.join(dir, "filter.txt");
    await writeFile(scriptFile, filter.join(";\n"));
    const output = path.join(dir, "with-graphics.mp4");
    // The sound is the clean export's own (already levelled), copied untouched.
    args.push("-filter_complex_script", scriptFile, "-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "copy", "-movflags", "+faststart", output);
    await runFfmpeg(args, { timeoutMs: 270_000 });

    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(output);
    const key = `video/${projectId}/final-with-graphics-${Date.now()}.mp4`;
    await storage.put(key, bytes, "video/mp4");
    const latest = await getProject(projectId);
    const previous = latest?.final?.withGraphics?.key;
    if (previous && previous !== key) await storage.delete(previous).catch(() => undefined);
    await updateProject(projectId, { final: { ...(latest?.final ?? final), withGraphics: { state: "done", stage: null, error: null, key, captions: options.captions, logo: options.logo, startedAt, createdAt: new Date().toISOString(), bytes: bytes.length } } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Adding the logo and subtitles failed", { projectId, error: message });
    const latest = await getProject(projectId).catch(() => null);
    await updateProject(projectId, { final: { ...(latest?.final ?? final), withGraphics: { state: "failed", stage: null, error: message, key: null, captions: options.captions, logo: options.logo, startedAt, createdAt: null, bytes: null } } }).catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
