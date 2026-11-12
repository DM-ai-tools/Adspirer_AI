import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getObjectStorage } from "@/lib/storage/r2";
import { logger } from "@/lib/observability/logger";
import { isSvg } from "@/lib/creatives/openai-image";
import { prepareLogo } from "@/lib/creatives/logo-prep";
import { measure, probe, runFfmpeg } from "@/lib/video/ffmpeg";
import { transcribeWords } from "@/lib/video/asr";
import { alignWords, fillGaps, matchedShare, phraseMarkup, sceneWindows, splitWords, statWindow, type AsrWord, type TimedWord } from "@/lib/video/captions";
import { alignSpeechLine, buildCues, checkCues, clampCues, safeCaptionY, toSrt, toVtt } from "@/lib/video/subtitles";
import { refineWindows } from "@/lib/video/audio-windows";
import { accentColour, endCardBackground, finalSize, layoutFor, type FinalFormat } from "@/lib/video/layout";
import { captionPiece, endCardPng, imagePiece, logoPiece, statPiece, type Piece } from "@/lib/video/graphics";
import type { FinalVideo, QaCheck } from "@/lib/video/generation-types";
import { claimProjectLease, getProject, releaseProjectLease, updateProject, type VideoProject } from "@/lib/video/projects";
import { loadManifestLogo } from "@/lib/video/brand-resolve";
import { effectiveClaims } from "@/lib/video/claims";
import { dropUnsourcedStats } from "@/lib/video/script";
import { brandBlockers } from "@/lib/video/pipeline";
import { hasCritical, type BrandManifest, type QaFinding, type QaReport, type SpeechLine } from "@/lib/video/pipeline-types";
import { finalBlocks, reviewFinal } from "@/lib/video/final-qa";
import { nameFromUrl, projectName } from "@/lib/video/naming";
import { bandsForCue, captionCentres, detectFaceBands } from "@/lib/video/face-bands";
import { imageSpansFor } from "@/lib/video/image-timing";
import { requiredStatsFrom } from "@/lib/video/required-stats";
import { resolveFinishing, type FinishingInput } from "@/lib/video/clean-mode";
import { assetCautions, jobAssets, loadOriginal, sha256 } from "@/lib/video/assets";
import { buildEditPlan, editPlanText, transcriptText } from "@/lib/video/edit-plan";
import { narrationCautions } from "@/lib/video/evidence";

/** The closing card runs this long. */
export const END_CARD_SECONDS = 2.2;
const FPS = 30;
/** The sound eases out over this long at the very end of a clean video, so it never stops on a click. */
const CLOSING_FADE = 0.25;

/** `fade`: seconds to fade in and out; `slide`: pixels it rises while arriving (an image eases in instead of popping). */
export type Overlay = { piece: Piece; x: number; y: number; start: number; end: number; fade?: number; slide?: number };

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

/**
 * The ffmpeg filter that lays every overlay on the video at its time and place, and levels the sound.
 * With no overlays the picture passes through untouched. `closingFadeAt` eases the sound out from that time.
 */
export function buildOverlayFilter(overlays: Array<Pick<Overlay, "x" | "y" | "start" | "end" | "fade" | "slide">>, closingFadeAt?: number): string {
  const lines: string[] = [];
  let label = "0:v";
  overlays.forEach((o, i) => {
    const out = i === overlays.length - 1 ? "vout" : `v${i + 1}`;
    if (o.fade) {
      // The image arrives and leaves with a short fade, rising a little as it arrives. Its input is a looped picture so the fade has frames to work on.
      const f = o.fade;
      const arrived = (o.start + f).toFixed(2);
      lines.push(`[${i + 1}:v]format=rgba,fade=t=in:st=${o.start.toFixed(2)}:d=${f}:alpha=1,fade=t=out:st=${Math.max(o.end - f, o.start).toFixed(2)}:d=${f}:alpha=1[f${i}]`);
      const rise = o.slide ? `+if(lt(t,${arrived}),(${arrived}-t)*${Math.round(o.slide / f)},0)` : "";
      lines.push(`[${label}][f${i}]overlay=x=${Math.round(o.x)}:y='${Math.round(o.y)}${rise}':format=auto:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'[${out}]`);
    } else {
      lines.push(`[${label}][${i + 1}:v]overlay=x=${Math.round(o.x)}:y=${Math.round(o.y)}:format=auto:enable='between(t,${o.start.toFixed(2)},${o.end.toFixed(2)})'[${out}]`);
    }
    label = out;
  });
  if (!overlays.length) lines.push("[0:v]null[vout]");
  const fade = closingFadeAt !== undefined && closingFadeAt > 0 ? `,afade=t=out:st=${closingFadeAt.toFixed(2)}:d=${CLOSING_FADE}` : "";
  lines.push(`[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=channel_layouts=stereo${fade}[aout]`);
  return lines.join(";\n");
}

const slash = (p: string) => p.replace(/\\/g, "/");

async function setStage(projectId: string, current: FinalVideo, stage: string): Promise<void> {
  current.stage = stage;
  await updateProject(projectId, { final: current }).catch(() => undefined);
}

/** How long the closing card is shown: long enough to read what is on it, within the overall budget. */
export function endCardSecondsFor(wordCount: number, joinedSeconds: number, maxTotal = 60): number {
  const wanted = Math.min(Math.max(1.6 + wordCount * 0.3, END_CARD_SECONDS + 0.3), 4.5);
  const room = maxTotal - joinedSeconds;
  return Math.round(Math.max(Math.min(wanted, room), 2) * 10) / 10;
}

const wordsOf = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

/** The speech text of every scene: what the plan settled, else the script's own line (display and speech identical). */
export function speechLinesFor(project: VideoProject): SpeechLine[] {
  const script = project.chosen_script!;
  const planned = project.plan?.speech?.lines ?? [];
  return script.scenes
    .filter((s) => s.line.trim())
    .map((s) => planned.find((l) => l.sceneNumber === s.number && l.display === s.line) ?? { sceneNumber: s.number, display: s.line, spoken: s.line, segments: [{ display: s.line, spoken: s.line }], uncertain: [] });
}

/**
 * Join the clips into the finished video and inspect it.
 *
 * Clean (the default): the picture is the footage and nothing else. No captions, highlighted words,
 * logo, stat card, proof image or end card is drawn, whatever a stored setting says. Subtitle files,
 * a transcript and a placement plan are written beside it, timed to this export.
 *
 * Branded (only when asked for by name): captions, the verified logo, stats, the operator's own
 * images and an end card are composited. An original file that cannot be read stops the export; it
 * is never skipped or replaced.
 */
export async function assembleVideo(projectId: string, options: FinishingInput = {}): Promise<void> {
  if (!(await claimProjectLease(projectId, 420_000))) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-"));
  let current: FinalVideo = { state: "running", stage: "Starting", error: null, startedAt: new Date().toISOString(), key: null, seconds: null, width: null, height: null, bytes: null, createdAt: null, qa: [], includes: null };
  try {
    const project = await getProject(projectId);
    if (!project?.clips?.length || !project.chosen_script) throw new Error("There are no clips to join yet.");
    if (project.clips.some((c) => c.status !== "succeeded" || !c.videoKey)) throw new Error("Every clip must be finished before they are joined.");
    const finishing = resolveFinishing(project.plan?.finishing, options);
    const clean = finishing.mode === "clean";
    current.mode = finishing.mode;
    // The brand in the video is the verified one or nothing. A clean video shows no logo, so only the (spoken) name has to be settled.
    const manifest = project.brand?.manifest ?? null;
    const brandProblem = brandBlockers(manifest, finishing.mode);
    if (brandProblem) throw new Error(brandProblem);
    const verified = manifest as BrandManifest;
    await updateProject(projectId, { status: "assembling", final: current, error: null });

    const allClaims = effectiveClaims(project.brand);
    // A figure shown big on screen needs a recorded source. One without is not drawn (the video is still made).
    const script = dropUnsourcedStats(project.chosen_script, allClaims);
    const format = project.inputs.format as FinalFormat;
    const { width: W, height: H } = finalSize(format);
    const layout = layoutFor(format);
    const accent = accentColour(verified.colors.value.length ? verified.colors.value : project.brand?.colors);
    const storage = getObjectStorage();
    const brandName = verified.name.value ?? "";
    const ctaLabel = verified.cta.value?.label ?? script.adCopy.cta ?? null;
    // The files this video was started with, not whatever the project holds now.
    const snapshots = jobAssets(project);

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

    // 3. When each scene falls in the finished video, and when each word is actually spoken.
    const planned = sceneWindows(script.scenes, project.clips.map((c, i) => ({ sceneNumbers: c.sceneNumbers, plannedSeconds: c.seconds, actualSeconds: actual[i]! })));
    const speech = speechLinesFor(project);
    let asr: AsrWord[] | null = null;
    // The voice is always located: burned-in captions need it, and so do the subtitle files and the placement plan of a clean video.
    if (finishing.captions || clean) {
      await setStage(projectId, current, clean ? "Timing the subtitles to the voice" : "Timing the captions to the voice");
      const wav = path.join(dir, "voice.wav");
      await runFfmpeg(["-i", joined, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
      asr = await transcribeWords(await readFile(wav));
    }
    // Subtitles come from the audio as finally cut, through the spoken-to-display mapping: the display text is never altered.
    const aligned = speech.map((line) => {
      const w = planned.find((x) => x.number === line.sceneNumber) ?? { start: 0, end: joinedSeconds };
      return alignSpeechLine(line, asr, w);
    });
    const windows = refineWindows(planned, aligned, joinedSeconds);
    const transcriptTimed = aligned.some((a) => a.fromAudio);
    // The narration's real length, from where each line was found in the audio (the script only had an estimate).
    const located = aligned.filter((a) => a.fromAudio && a.words.length);
    const measuredSpeech = located.length ? Math.round(located.reduce((t, a) => t + (Math.max(...a.words.map((w) => w.end)) - Math.min(...a.words.map((w) => w.start))), 0) * 10) / 10 : null;
    const speechUse = { measuredSeconds: measuredSpeech, estimatedSeconds: script.speech?.estimatedSeconds ?? null };

    // 4. The graphics (branded only), the cues and where the faces are.
    await setStage(projectId, current, clean ? "Writing the subtitles and the placement plan" : "Drawing captions and graphics");
    const overlays: Overlay[] = [];
    const captionOverlays: Overlay[] = [];
    let statCount = 0;
    let imageCount = 0;
    const imageWindows: Array<{ start: number; end: number }> = [];

    const logoBytes = await loadManifestLogo(verified, storage);
    let logoPng: Buffer | null = null;
    if (!clean) {
      // A logo that is on record but cannot be read stops the export: the video is never finished without it, and never with text in its place.
      if ((finishing.logo || finishing.endCard) && verified.logo && !logoBytes) throw new Error("The verified logo file is no longer in storage, so it cannot be put on the video. Check the brand again (or upload the logo) and finish the video again.");
      if (logoBytes) {
        try {
          logoPng = (await prepareLogo(logoBytes, { isSvg: isSvg(logoBytes) })).png;
        } catch (error) {
          throw new Error(`The verified logo could not be prepared for the video: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (finishing.logo && logoPng) {
        const piece = await logoPiece(logoPng, W, layout.logo.width);
        overlays.push({ piece, x: layout.logo.x * W, y: layout.logo.y * H, start: 0, end: joinedSeconds });
      }
    }

    // The cues are worked out in both modes: burned in for a branded video, written to subtitle files for a clean one.
    const cues = finishing.captions || clean ? clampCues(buildCues(aligned), joinedSeconds) : [];
    const hasImages = script.scenes.some((s) => s.assetId);
    const hasNotes = clean && (script.scenes.some((s) => s.stat || s.keywords.length) || Boolean(project.plan?.creative?.scenes.some((s) => s.editingNotes?.length)));
    const faces = (!clean && cues.length) || hasImages || hasNotes ? await detectFaceBands(joined, joinedSeconds, path.join(dir, "faces")) : { bands: [], samples: [], limitation: null as string | null };
    const statOverlays: Overlay[] = [];
    const figuresByAsset: Record<string, string[]> = {};
    for (const r of requiredStatsFrom(project.assets.map((a) => ({ id: a.id, name: a.name, stats: a.analysis?.stats ?? [], mainStat: a.analysis?.mainStat ?? null })))) (figuresByAsset[r.assetId] ??= []).push(r.value);

    let crowded = 0;
    if (!clean) {
      for (const w of windows) {
        const scene = script.scenes.find((s) => s.number === w.number)!;
        const line = aligned.find((a) => a.sceneNumber === w.number);
        const words = line?.words ?? [];
        if (scene.stat) {
          const piece = await statPiece(scene.stat, W, accent);
          const when = statWindow(w, words, scene.stat);
          const card: Overlay = { piece, x: (W - piece.width) / 2, y: layout.statY * H - piece.height / 2, start: when.start, end: when.end };
          overlays.push(card);
          statOverlays.push(card);
          statCount += 1;
        }
      }

      // The operator's stat images: each arrives just before its figure is said, stays for the point, and leaves; one continuous showing per run of scenes that use it.
      const spans = imageSpansFor({
        scenes: script.scenes.map((s) => ({ number: s.number, assetId: s.assetId, stat: s.stat })),
        windows,
        words: new Map(aligned.map((a) => [a.sceneNumber, a.words])),
        figuresByAsset,
        totalSeconds: joinedSeconds,
      });
      for (const span of spans) {
        const snapshot = snapshots.find((a) => a.id === span.assetId);
        if (!snapshot) throw new Error(`Scene ${span.scenes.join(", ")} uses an uploaded image (${span.assetId}) that is not among this video's files.`);
        // The original bytes, checked against the checksum taken when the video was started. Missing or different: the export stops.
        const { bytes } = await loadOriginal(snapshot, storage);
        const piece = await imagePiece(bytes, Math.round(W * layout.imageMaxW), Math.round(H * layout.imageMaxH));
        const heightFraction = piece.height / H;
        // Placed in the free middle of the frame: off any face, clear of the big-stat card, and leaving room for the caption beneath it.
        const faceBands = bandsForCue(faces.bands, faces.samples, span.start, span.end);
        const cards = statOverlays.filter((c) => c.start < span.end && c.end > span.start).map((c) => ({ top: c.y / H, bottom: (c.y + c.piece.height) / H }));
        const captionRoom = { top: layout.captionY - 0.05, bottom: layout.captionY + 0.05 };
        const { inside } = captionCentres(layout.imageY, layout.safe, heightFraction);
        const centre = safeCaptionY(inside, [...faceBands, ...cards, captionRoom], heightFraction) ?? safeCaptionY(inside, [...faceBands, ...cards], heightFraction) ?? layout.imageY;
        overlays.push({ piece, x: (W - piece.width) / 2, y: centre * H - piece.height / 2, start: span.start, end: span.end, fade: 0.3, slide: 30 });
        imageWindows.push({ start: span.start, end: span.end });
        imageCount += 1;
      }

      // Captions: grouped into readable cues, kept off the logo, the stat and the image card wherever they are on screen.
      const keywordsAt = (t: number) => {
        const w = windows.find((x) => t >= x.start - 0.05 && t <= x.end + 0.05);
        return script.scenes.find((s) => s.number === w?.number)?.keywords ?? [];
      };
      for (const cue of finishing.captions ? cues : []) {
        const piece = await captionPiece(phraseMarkup({ words: cue.words, start: cue.start, end: cue.end }, keywordsAt(cue.start), accent), W);
        const busy = overlays.filter((o) => o.start < cue.end && o.end > cue.start).map((o) => ({ top: o.y / H, bottom: (o.y + o.piece.height) / H }));
        const heightFraction = piece.height / H;
        const avoid = [...busy, ...bandsForCue(faces.bands, faces.samples, cue.start, cue.end)];
        const { inside, lastResort } = captionCentres(layout.captionY, layout.safe, heightFraction);
        const centre = safeCaptionY(inside, avoid, heightFraction) ?? safeCaptionY(lastResort, avoid, heightFraction);
        if (centre === null) crowded += 1;
        const o: Overlay = { piece, x: (W - piece.width) / 2, y: (centre ?? layout.captionY) * H - piece.height / 2, start: Math.max(cue.start, 0), end: Math.min(cue.end, joinedSeconds) };
        overlays.push(o);
        captionOverlays.push(o);
      }
    }
    // A subtitle FILE that reads fast is for the editor to adjust: it is noted, and does not hold a clean video back. Burned-in captions are held to the limit.
    const cueFindings: QaFinding[] = cues.length ? checkCues(cues, { videoSeconds: joinedSeconds }).map((f) => (clean && f.code !== "subtitle_outside_video" && f.code !== "subtitle_empty" ? { ...f, severity: "minor" as const } : f)) : [];
    if (faces.limitation) cueFindings.push({ code: "faces_not_located", severity: "minor", category: "composition", message: faces.limitation, evidence: "face location step", correction: "", source: "rule" });
    if (crowded) cueFindings.push({ code: "caption_crowded", severity: "minor", category: "composition", message: `${crowded} caption${crowded === 1 ? "" : "s"} had no free space away from the logo and cards and sit at the default position.`, evidence: `${crowded} cue(s)`, correction: "Show fewer graphics at the same time.", source: "rule" });

    // Subtitle files from the very same cues (as the burned-in captions, when there are any).
    const stamp = Date.now();
    let subtitles: FinalVideo["subtitles"] = null;
    if (cues.length) {
      const srtKey = `video/${projectId}/subtitles-${stamp}.srt`;
      const vttKey = `video/${projectId}/subtitles-${stamp}.vtt`;
      await storage.put(srtKey, toSrt(cues), "application/x-subrip");
      await storage.put(vttKey, toVtt(cues), "text/vtt");
      subtitles = { srtKey, vttKey, cues: cues.length };
    }

    // 5. Level the sound; lay the graphics over the video when there are any (a clean video has none: the picture passes through untouched).
    await setStage(projectId, current, clean ? "Levelling the sound" : "Adding the graphics and levelling the sound");
    const args = ["-i", joined];
    for (const [i, o] of overlays.entries()) {
      const f = path.join(dir, `o${i}.png`);
      await writeFile(f, o.piece.png);
      // A faded overlay needs frames over time, so its picture is looped for the length of the video.
      // (It is never longer than the video: a longer picture would stretch the video itself.)
      if (o.fade) args.push("-loop", "1", "-framerate", String(FPS), "-t", String(Math.max(Math.floor(joinedSeconds * 100) / 100 - 0.05, 1)));
      args.push("-i", f);
    }
    const scriptFile = path.join(dir, "filter.txt");
    await writeFile(scriptFile, buildOverlayFilter(overlays, clean ? Math.max(joinedSeconds - CLOSING_FADE, 0) : undefined));
    const overlaid = path.join(dir, "overlaid.mp4");
    args.push("-filter_complex_script", scriptFile, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", overlaid);
    await runFfmpeg(args, { timeoutMs: 270_000 });

    // 6. The closing card (branded only), drawn only from verified brand data. A clean video ends on its own last shot.
    let finalFile = overlaid;
    let endCardSeconds = 0;
    const offerText = verified.offer.value && verified.offer.value.length <= 70 ? verified.offer.value : null;
    const urlText = nameFromUrl(verified.cta.value?.url ?? verified.sourceUrl.value);
    if (finishing.endCard) {
      // The card carries the real logo, or the name alone only where the operator allowed that. It never stands in for a logo that went missing.
      if (!logoPng && !verified.allowTextOnlyBrand) throw new Error("An end card needs the verified logo, and none is available. Check the brand again, allow a name-only card in the brand check, or finish the video without an end card.");
      await setStage(projectId, current, "Adding the end card");
      endCardSeconds = endCardSecondsFor(wordsOf(brandName) + wordsOf(offerText) + wordsOf(ctaLabel) + 2, joinedSeconds);
      const card = await endCardPng(W, H, { background: endCardBackground(verified.colors.value), accent, logoPng, brandName, offer: offerText, cta: ctaLabel, url: urlText });
      const cardFile = path.join(dir, "endcard.png");
      await writeFile(cardFile, card);
      const endFile = path.join(dir, "end.mp4");
      await runFfmpeg(["-loop", "1", "-t", String(endCardSeconds), "-i", cardFile, "-f", "lavfi", "-t", String(endCardSeconds), "-i", "anullsrc=r=48000:cl=stereo", "-vf", `fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-tune", "stillimage", "-c:a", "aac", "-b:a", "192k", "-shortest", endFile]);
      finalFile = path.join(dir, "final.mp4");
      await runFfmpeg(["-i", overlaid, "-i", endFile, "-filter_complex", "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]", "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", finalFile], { timeoutMs: 270_000 });
    }

    // 7. Inspect the exported video again: stitching and rendering can add problems no single clip had.
    await setStage(projectId, current, "Inspecting the finished video");
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

    const claimTexts = allClaims.flatMap((c) => [c.text, ...(c.figure ? [c.figure] : [])]);
    const report = await reviewFinal(
      {
        file: finalFile,
        workDir: dir,
        attempt: 1,
        seconds: info.seconds,
        endCardSeconds,
        clean,
        manifest: { name: verified.name, logo: verified.logo, internalLabels: verified.internalLabels, allowTextOnlyBrand: verified.allowTextOnlyBrand, claims: allClaims, cta: verified.cta, offer: verified.offer },
        expected: {
          brandName: clean ? null : brandName || null,
          ctaLabel: finishing.endCard ? ctaLabel : null,
          claimTexts,
          captionTexts: clean ? [] : cues.map((c) => c.text),
          allowedOverlayText: clean ? [] : [...script.scenes.flatMap((s) => (s.stat ? [s.stat] : [])), ...(offerText ? [offerText] : []), ...(urlText ? [urlText] : []), brandName],
        },
        cues: cues.map((c) => ({ start: c.start, end: c.end, text: c.text })),
        expectsLogo: !clean && Boolean(logoPng) && (finishing.endCard || finishing.logo),
        asr,
        requireVision: true,
        logoReference: clean ? null : logoBytes,
        verifiedAssetWindows: imageWindows,
      },
    );
    const findings = [...report.findings, ...cueFindings];
    const blocking = findings.filter((f) => f.severity !== "minor");
    const merged: QaReport = { ...report, findings, verdict: finalBlocks(report) || blocking.length ? (report.verdict === "pass" ? "unresolved" : report.verdict) : report.verdict };
    for (const c of report.checks) checks.push({ name: c.name, ok: c.ok, detail: c.detail });
    const blocked = finalBlocks(merged) || hasCritical(findings) || blocking.length > 0;

    // 8. What is handed over beside a clean video: the transcript and the placement plan, on this export's own timeline.
    let deliverables: FinalVideo["deliverables"] = null;
    if (clean) {
      const title = projectName(project);
      const cautions = [
        ...project.assets.flatMap((a) => assetCautions(a).map((c) => `${a.name}: ${c.message}`)),
        ...narrationCautions(script.scenes.filter((s) => s.line.trim()).map((s) => ({ sceneNumber: s.number, text: s.line })), project.assets.map((a) => a.analysis)),
      ];
      const available = new Map<string, boolean>();
      for (const snapshot of snapshots) available.set(snapshot.id, await loadOriginal(snapshot, storage).then(() => true, () => false));
      const logoSnapshot = project.plan?.logo ?? null;
      const plan = buildEditPlan({
        seconds: info.seconds,
        format,
        width: W,
        height: H,
        scenes: script.scenes.map((s) => ({ number: s.number, line: s.line, stat: s.stat, assetId: s.assetId, keywords: s.keywords })),
        briefs: project.plan?.creative?.mode === "clean" ? project.plan.creative.scenes : [],
        windows,
        aligned,
        faces,
        assets: snapshots.map((a) => {
          const current = project.assets.find((x) => x.id === a.id);
          return { id: a.id, name: a.name, purpose: a.purpose, sha256: a.sha256, available: available.get(a.id) ?? false, cautions: current ? assetCautions(current).map((c) => c.message) : [], figures: figuresByAsset[a.id] ?? [] };
        }),
        claims: allClaims,
        logo: verified.logo ? { available: Boolean(logoBytes), fileName: logoFileName(verified), sha256: logoBytes ? sha256(logoBytes) : (logoSnapshot?.sha256 ?? null), needsDarkPlate: !verified.logo.verification.legibleOnLight } : null,
        brand: { name: brandName || null, ctaLabel, url: urlText, accent },
        narrationChanges: project.plan?.narrationChanges ?? [],
        cautions,
      });
      const transcriptKey = `video/${projectId}/transcript-${stamp}.txt`;
      const planJsonKey = `video/${projectId}/placement-plan-${stamp}.json`;
      const planTextKey = `video/${projectId}/placement-plan-${stamp}.txt`;
      await storage.put(transcriptKey, transcriptText({ title, seconds: info.seconds, speech, aligned, windows, timedFromAudio: transcriptTimed }), "text/plain; charset=utf-8");
      await storage.put(planJsonKey, JSON.stringify(plan, null, 2), "application/json");
      await storage.put(planTextKey, editPlanText(plan, title), "text/plain; charset=utf-8");
      deliverables = { transcriptKey, planJsonKey, planTextKey, overlays: plan.textOverlays.length };
    }

    const bytes = await readFile(finalFile);
    const key = `video/${projectId}/final-${stamp}.mp4`;
    const brandUse = { name: brandName || null, logo: !clean && Boolean(logoPng), textOnly: !clean && !logoPng && verified.allowTextOnlyBrand };
    // What is IN the file. A clean video includes none of these, whatever was asked for.
    const includesBase = {
      captions: captionOverlays.length > 0,
      logo: overlays.some((o) => o.start === 0 && o.end === joinedSeconds),
      endCard: endCardSeconds > 0,
      stats: statCount,
      images: imageCount,
      captionTiming: (!cues.length ? "none" : transcriptTimed ? "transcript" : "estimated") as "transcript" | "estimated" | "none",
    };
    const base = {
      stage: null,
      startedAt: current.startedAt,
      seconds: Math.round(info.seconds * 10) / 10,
      width: info.width,
      height: info.height,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
      qa: checks,
      includes: includesBase,
      report: merged,
      subtitles,
      deliverables,
      brand: brandUse,
      speech: speechUse,
      mode: finishing.mode,
    };

    if (blocked) {
      // A failed critical check blocks delivery: the file is kept only for the operator to look at, never as the finished video, until they say to use it.
      await storage.put(key, bytes, "video/mp4");
      if (project.final?.reviewKey) await storage.delete(project.final.reviewKey).catch(() => undefined);
      current = { ...base, state: "blocked", error: `Not approved for delivery: ${blocking.slice(0, 4).map((f) => f.message).join(" ") || merged.limitations.join(" ") || "the inspection could not approve it."}`, key: null, reviewKey: key };
      await updateProject(projectId, { final: current, status: "clips_ready", error: null });
      return;
    }

    await storage.put(key, bytes, "video/mp4");
    if (project.final?.key) await storage.delete(project.final.key).catch(() => undefined);
    if (project.final?.reviewKey) await storage.delete(project.final.reviewKey).catch(() => undefined);
    current = { ...base, state: "done", error: null, key, reviewKey: null };
    // The script keeps what was measured, next to what it estimated.
    await updateProject(projectId, { final: current, status: "done", error: null, ...(script.speech ? { chosen_script: { ...script, speech: { ...script.speech, measuredSeconds: measuredSpeech } } } : {}) });
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

/** A file name for the logo as handed over: the uploaded name, else one made from the brand name and the file's type. */
export function logoFileName(manifest: Pick<BrandManifest, "logo" | "name">): string | null {
  const logo = manifest.logo;
  if (!logo) return null;
  const ext = logo.storageKey.split(".").pop() || "png";
  if (logo.origin === "upload" && logo.sourceUrl && !/^https?:/i.test(logo.sourceUrl)) return logo.sourceUrl;
  const base = (manifest.name.value ?? "logo").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "logo";
  return `${base}-logo.${ext}`;
}

export type { VideoProject };
