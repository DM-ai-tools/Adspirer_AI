import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getObjectStorage } from "@/lib/storage/r2";
import { logger } from "@/lib/observability/logger";
import { loadLogoBuffer, isSvg } from "@/lib/creatives/openai-image";
import { prepareLogo } from "@/lib/creatives/logo-prep";
import { measure, probe, runFfmpeg } from "@/lib/video/ffmpeg";
import { transcribeWords } from "@/lib/video/asr";
import { alignWords, fillGaps, matchedShare, phraseMarkup, sceneWindows, splitWords, statWindow, toPhrases, type AsrWord, type TimedWord } from "@/lib/video/captions";
import { accentColour, endCardBackground, finalSize, layoutFor, type FinalFormat } from "@/lib/video/layout";
import { captionPiece, endCardPng, imagePiece, logoPiece, statPiece, type Piece } from "@/lib/video/graphics";
import { DEFAULT_FINISHING, type FinalVideo, type Finishing, type QaCheck } from "@/lib/video/generation-types";
import { claimProjectLease, getProject, releaseProjectLease, updateProject, type VideoProject } from "@/lib/video/projects";

/** The closing card runs this long. */
export const END_CARD_SECONDS = 2.2;
const FPS = 30;

export type Overlay = { piece: Piece; x: number; y: number; start: number; end: number };

/** Time the words of one scene: from the transcript where it matches, evenly otherwise. */
export function timeScene(line: string, asr: AsrWord[] | null, window: { start: number; end: number }): { words: TimedWord[]; fromTranscript: boolean } {
  const words = splitWords(line);
  if (asr && asr.length) {
    const aligned = alignWords(words, asr, window);
    if (matchedShare(aligned) >= 0.4) return { words: aligned, fromTranscript: true };
  }
  const even: TimedWord[] = words.map((text) => ({ text, start: NaN, end: NaN, matched: false }));
  return { words: fillGaps(even, window), fromTranscript: false };
}

/** The ffmpeg filter that lays every overlay on the video at its time and place, and levels the sound. */
export function buildOverlayFilter(overlays: Array<Pick<Overlay, "x" | "y" | "start" | "end">>): string {
  const lines: string[] = [];
  let label = "0:v";
  overlays.forEach((o, i) => {
    const out = i === overlays.length - 1 ? "vout" : `v${i + 1}`;
    lines.push(`[${label}][${i + 1}:v]overlay=x=${Math.round(o.x)}:y=${Math.round(o.y)}:format=auto:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'[${out}]`);
    label = out;
  });
  if (!overlays.length) lines.push("[0:v]null[vout]");
  lines.push("[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]");
  return lines.join(";\n");
}

const slash = (p: string) => p.replace(/\\/g, "/");

async function setStage(projectId: string, current: FinalVideo, stage: string): Promise<void> {
  current.stage = stage;
  await updateProject(projectId, { final: current }).catch(() => undefined);
}

/** Join the clips and add captions, highlights, stats, the operator's images, the logo and an end card. */
export async function assembleVideo(projectId: string, options: Partial<Finishing> = {}): Promise<void> {
  if (!(await claimProjectLease(projectId, 280_000))) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-"));
  let current: FinalVideo = { state: "running", stage: "Starting", error: null, startedAt: new Date().toISOString(), key: null, seconds: null, width: null, height: null, bytes: null, createdAt: null, qa: [], includes: null };
  try {
    const project = await getProject(projectId);
    if (!project?.clips?.length || !project.chosen_script) throw new Error("There are no clips to join yet.");
    if (project.clips.some((c) => c.status !== "succeeded" || !c.videoKey)) throw new Error("Every clip must be finished before they are joined.");
    const finishing: Finishing = { ...DEFAULT_FINISHING, ...(project.plan?.finishing ?? {}), ...options };
    await updateProject(projectId, { status: "assembling", final: current, error: null });

    const script = project.chosen_script;
    const format = project.inputs.format as FinalFormat;
    const { width: W, height: H } = finalSize(format);
    const layout = layoutFor(format);
    const accent = accentColour(project.brand?.colors);
    const storage = getObjectStorage();

    // 1. Every clip to the same size, rate and audio format.
    await setStage(projectId, current, "Preparing the clips");
    const normFiles: string[] = [];
    const actual: number[] = [];
    for (const clip of project.clips) {
      const src = path.join(dir, `clip-${clip.number}.mp4`);
      const bytes = await storage.get(clip.videoKey!);
      if (!bytes) throw new Error(`Clip ${clip.number} is missing from storage.`);
      await writeFile(src, bytes);
      const info = await probe(src);
      const out = path.join(dir, `norm-${clip.number}.mp4`);
      const fadeOut = Math.max(info.seconds - 0.03, 0).toFixed(3);
      const args = ["-i", src];
      if (!info.hasAudio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      args.push(
        "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=${FPS},setsar=1,format=yuv420p`,
        "-af", `aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.03,afade=t=out:st=${fadeOut}:d=0.03`,
        "-map", "0:v:0", "-map", info.hasAudio ? "0:a:0" : "1:a:0", "-shortest",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "15", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out,
      );
      await runFfmpeg(args);
      normFiles.push(out);
      actual.push((await probe(out)).seconds);
    }

    // 2. Join them.
    await setStage(projectId, current, "Joining the clips");
    const listFile = path.join(dir, "list.txt");
    await writeFile(listFile, normFiles.map((f) => `file '${slash(f)}'`).join("\n"));
    const joined = path.join(dir, "joined.mp4");
    await runFfmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", joined]);
    const joinedSeconds = (await probe(joined)).seconds;

    // 3. When each scene falls in the finished video, and when each word is spoken.
    const windows = sceneWindows(script.scenes, project.clips.map((c, i) => ({ sceneNumbers: c.sceneNumbers, plannedSeconds: c.seconds, actualSeconds: actual[i]! })));
    let asr: AsrWord[] | null = null;
    if (finishing.captions) {
      await setStage(projectId, current, "Timing the captions to the voice");
      const wav = path.join(dir, "voice.wav");
      await runFfmpeg(["-i", joined, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
      asr = await transcribeWords(await readFile(wav));
    }

    // 4. The graphics.
    await setStage(projectId, current, "Drawing captions and graphics");
    const overlays: Overlay[] = [];
    let transcriptTimed = false;
    let statCount = 0;
    let imageCount = 0;

    if (finishing.logo && project.brand?.logoUrl) {
      try {
        const raw = await loadLogoBuffer(project.brand.logoUrl);
        const prepared = await prepareLogo(raw, { isSvg: isSvg(raw) });
        const piece = await logoPiece(prepared.png, W, layout.logo.width);
        overlays.push({ piece, x: layout.logo.x * W, y: layout.logo.y * H, start: 0, end: joinedSeconds });
      } catch (error) {
        logger.warn("The logo could not be placed on the video", { error: error instanceof Error ? error.message : String(error) });
      }
    }

    for (const w of windows) {
      const scene = script.scenes.find((s) => s.number === w.number)!;
      const timed = scene.line ? timeScene(scene.line, asr, w) : { words: [] as TimedWord[], fromTranscript: false };
      if (timed.fromTranscript) transcriptTimed = true;

      if (finishing.captions && timed.words.length) {
        for (const phrase of toPhrases(timed.words)) {
          const piece = await captionPiece(phraseMarkup(phrase, scene.keywords, accent), W);
          overlays.push({ piece, x: (W - piece.width) / 2, y: layout.captionY * H - piece.height / 2, start: Math.max(phrase.start, w.start), end: Math.min(phrase.end, joinedSeconds) });
        }
      }
      if (scene.stat) {
        const piece = await statPiece(scene.stat, W, accent);
        const when = statWindow(w, timed.words, scene.stat);
        overlays.push({ piece, x: (W - piece.width) / 2, y: layout.statY * H - piece.height / 2, start: when.start, end: when.end });
        statCount += 1;
      }
      if (scene.assetId) {
        const asset = project.assets.find((a) => a.id === scene.assetId);
        const bytes = asset ? await storage.get(asset.key) : null;
        if (bytes) {
          const piece = await imagePiece(bytes, Math.round(W * layout.imageMaxW), Math.round(H * layout.imageMaxH));
          overlays.push({ piece, x: (W - piece.width) / 2, y: layout.imageY * H - piece.height / 2, start: Math.min(w.start + 0.2, w.end - 1), end: w.end });
          imageCount += 1;
        }
      }
    }

    // 5. Lay it all over the video and level the sound.
    await setStage(projectId, current, "Adding the graphics and levelling the sound");
    const files: string[] = [];
    const args = ["-i", joined];
    for (const [i, o] of overlays.entries()) {
      const f = path.join(dir, `o${i}.png`);
      await writeFile(f, o.piece.png);
      files.push(f);
      args.push("-i", f);
    }
    const scriptFile = path.join(dir, "filter.txt");
    await writeFile(scriptFile, buildOverlayFilter(overlays));
    const overlaid = path.join(dir, "overlaid.mp4");
    args.push("-filter_complex_script", scriptFile, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", overlaid);
    await runFfmpeg(args, { timeoutMs: 270_000 });

    // 6. The closing card, then the final file.
    let finalFile = overlaid;
    let endCardSeconds = 0;
    if (finishing.endCard) {
      await setStage(projectId, current, "Adding the end card");
      let logoPng: Buffer | null = null;
      if (project.brand?.logoUrl) {
        try {
          const raw = await loadLogoBuffer(project.brand.logoUrl);
          logoPng = (await prepareLogo(raw, { isSvg: isSvg(raw) })).png;
        } catch {
          logoPng = null;
        }
      }
      const card = await endCardPng(W, H, { background: endCardBackground(project.brand?.colors), accent, logoPng, brandName: project.brand?.name ?? "", cta: script.adCopy.cta });
      const cardFile = path.join(dir, "endcard.png");
      await writeFile(cardFile, card);
      const endFile = path.join(dir, "end.mp4");
      await runFfmpeg(["-loop", "1", "-t", String(END_CARD_SECONDS), "-i", cardFile, "-f", "lavfi", "-t", String(END_CARD_SECONDS), "-i", "anullsrc=r=48000:cl=stereo", "-vf", `fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-tune", "stillimage", "-c:a", "aac", "-b:a", "192k", "-shortest", endFile]);
      finalFile = path.join(dir, "final.mp4");
      await runFfmpeg(["-i", overlaid, "-i", endFile, "-filter_complex", "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]", "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", finalFile], { timeoutMs: 270_000 });
      endCardSeconds = END_CARD_SECONDS;
    }

    // 7. Check the result before calling it done.
    await setStage(projectId, current, "Checking the finished video");
    const info = await probe(finalFile);
    const qa = await measure(finalFile, Math.max(info.seconds - endCardSeconds - 0.1, 1));
    const expected = actual.reduce((t, s) => t + s, 0) + endCardSeconds;
    const checks: QaCheck[] = [
      { name: "Length", ok: Math.abs(info.seconds - expected) <= 1, detail: `${info.seconds.toFixed(1)}s (expected about ${expected.toFixed(1)}s)` },
      { name: "Within 60 seconds", ok: info.seconds <= 60, detail: `${info.seconds.toFixed(1)}s` },
      { name: "Size", ok: info.width === W && info.height === H, detail: `${info.width}x${info.height} (wanted ${W}x${H})` },
      { name: "Sound present and not too quiet", ok: info.hasAudio && qa.meanVolumeDb !== null && qa.meanVolumeDb > -40, detail: qa.meanVolumeDb !== null ? `${qa.meanVolumeDb} dB average` : "no audio found" },
      { name: "No black frames", ok: qa.blackSeconds < 0.5, detail: `${qa.blackSeconds}s of black` },
      { name: "No long silences", ok: qa.silentStretches === 0, detail: qa.silentStretches ? `${qa.silentStretches} silent stretch(es) over 1.5s` : "none" },
    ];
    const bytes = await readFile(finalFile);
    const key = `video/${projectId}/final-${Date.now()}.mp4`;
    await storage.put(key, bytes, "video/mp4");
    if (project.final?.key) await storage.delete(project.final.key).catch(() => undefined);

    current = {
      state: "done",
      stage: null,
      error: null,
      startedAt: current.startedAt,
      key,
      seconds: Math.round(info.seconds * 10) / 10,
      width: info.width,
      height: info.height,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
      qa: checks,
      includes: { captions: finishing.captions, logo: overlays.some((o) => o.start === 0 && o.end === joinedSeconds), endCard: finishing.endCard, stats: statCount, images: imageCount, captionTiming: !finishing.captions ? "none" : transcriptTimed ? "transcript" : "estimated" },
    };
    await updateProject(projectId, { final: current, status: "done", error: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Assembling the video failed", { projectId, error: message });
    current = { ...current, state: "failed", stage: null, error: message };
    // The clips are fine: go back to "clips ready" so the join can be tried again.
    await updateProject(projectId, { final: current, status: "clips_ready" }).catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await releaseProjectLease(projectId);
  }
}

export type { VideoProject };
