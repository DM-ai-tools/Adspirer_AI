import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { generateObject } from "ai";
import { z } from "zod";
import { modelCandidates, withModelFallback } from "@/lib/video/model-fallback";
import { logger } from "@/lib/observability/logger";
import { runFfmpeg, probe } from "@/lib/video/ffmpeg";
import { transcribeWords } from "@/lib/video/asr";
import type { AsrWord } from "@/lib/video/captions";
import type { QaCategory, QaCheckResult, QaFinding, QaReport, QaSeverity, QaVerdict, SceneBrief, SpeechLine } from "@/lib/video/pipeline-types";

/**
 * Quality gates for one generated clip. Two kinds of evidence:
 *  - deterministic, measured by ffmpeg over the whole clip (frozen footage, black frames, silence,
 *    loudness, cuts inside a single shot, A/V length mismatch);
 *  - a multimodal reviewer that looks at frames spread across the clip against a precise rubric.
 * Findings are recorded with times and a targeted correction, and `decideClip` (pure) turns them into
 * pass / retry / redesign / unresolved. A critical finding is never a pass.
 */

// ------------------------------------------------------------------ small helpers

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtT = (t: number) => `${round2(t)}s`;
const toSeconds = (h: string, m: string, s: string) => Number(h) * 3600 + Number(m) * 60 + Number(s);

/** Lower-case letters and digits only, for comparing text regardless of case, spacing and punctuation. */
export function normaliseText(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
}

export function tokenise(s: string): string[] {
  return (s.toLowerCase().replace(/['’]/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
}

// ------------------------------------------------------------------ parsers (ffmpeg's report)

/** Frozen stretches from `freezedetect`. A freeze still running at the end of the file has no closing line, so `totalSeconds` closes it. */
export function parseFreezeDetect(report: string, totalSeconds?: number): Array<{ start: number; end: number; duration: number }> {
  const out: Array<{ start: number; end: number; duration: number }> = [];
  let pending: { start: number; duration: number | null; end: number | null } | null = null;
  const close = (end: number | null) => {
    if (!pending) return;
    const e = end ?? pending.end;
    if (e !== null && e >= pending.start) out.push({ start: pending.start, end: e, duration: round2(pending.duration ?? e - pending.start) });
    pending = null;
  };
  for (const line of report.split(/\r?\n|\r/)) {
    const s = line.match(/freeze_start:\s*(-?[\d.]+)/);
    const d = line.match(/freeze_duration:\s*([\d.]+)/);
    const e = line.match(/freeze_end:\s*(-?[\d.]+)/);
    if (s) {
      close(totalSeconds ?? null);
      pending = { start: Number(s[1]), duration: null, end: null };
    }
    if (d && pending) pending.duration = Number(d[1]);
    if (e && pending) close(Number(e[1]));
  }
  if (pending && totalSeconds !== undefined) close(totalSeconds);
  return out;
}

/**
 * Scene-change scores with their times, from `select='gt(scene,X)',metadata=print` (the score only
 * appears in the metadata line; `showinfo` lines carry the time). Both are understood.
 */
export function parseSceneScores(report: string): Array<{ time: number; score: number }> {
  const out: Array<{ time: number; score: number }> = [];
  let time: number | null = null;
  for (const line of report.split(/\r?\n|\r/)) {
    const t = line.match(/pts_time:\s*(-?[\d.]+)/);
    if (t) time = Number(t[1]);
    const s = line.match(/lavfi\.scene_score[=:]\s*([\d.]+)/) ?? line.match(/\bscene:\s*([\d.]+)/);
    if (s && time !== null) out.push({ time: round2(time), score: Number(s[1]) });
  }
  return out;
}

/**
 * Length of the container, the video stream and the audio stream. The container comes from the `-i`
 * report. Each stream comes from a stream-copy pass written under a `[stream:video]` or
 * `[stream:audio]` marker line (the last `time=` ffmpeg printed); a stream-level DURATION tag is used
 * when the format writes one. A stream that cannot be measured is null.
 */
export function parseStreamDurations(report: string): { video: number | null; audio: number | null; container: number } {
  const dur = report.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const container = dur ? toSeconds(dur[1]!, dur[2]!, dur[3]!) : 0;
  const result: { video: number | null; audio: number | null; container: number } = { video: null, audio: null, container };

  const sections = report.split(/^\[stream:(video|audio)\]\s*$/m);
  // split with a capture group: [before, kind, body, kind, body, ...]
  for (let i = 1; i < sections.length; i += 2) {
    const kind = sections[i] as "video" | "audio";
    const times = [...(sections[i + 1] ?? "").matchAll(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const last = times[times.length - 1];
    if (last) result[kind] = round2(toSeconds(last[1]!, last[2]!, last[3]!));
  }

  const lines = report.split(/\r?\n/);
  let current: "video" | "audio" | null = null;
  for (const line of lines) {
    if (/Stream #\d+:\d+[^\n]*Video:/.test(line)) current = "video";
    else if (/Stream #\d+:\d+[^\n]*Audio:/.test(line)) current = "audio";
    const tag = line.match(/^\s*DURATION\s*:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (tag && current && result[current] === null) result[current] = round2(toSeconds(tag[1]!, tag[2]!, tag[3]!));
  }
  return result;
}

type Span = { start: number; end: number; duration: number };

function parseSilence(report: string, totalSeconds: number): Span[] {
  const out: Span[] = [];
  let start: number | null = null;
  for (const line of report.split(/\r?\n|\r/)) {
    const s = line.match(/silence_start:\s*(-?[\d.]+)/);
    const e = line.match(/silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (s) start = Math.max(Number(s[1]), 0);
    if (e) {
      const end = Number(e[1]);
      const duration = Number(e[2]);
      out.push({ start: start ?? Math.max(end - duration, 0), end, duration: round2(duration) });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: totalSeconds, duration: round2(Math.max(totalSeconds - start, 0)) });
  return out;
}

function parseBlack(report: string): Span[] {
  return [...report.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) }));
}

function lastNumber(report: string, re: RegExp): number | null {
  const all = [...report.matchAll(re)];
  const last = all[all.length - 1];
  return last ? Number(last[1]) : null;
}

// ------------------------------------------------------------------ temporal and technical checks

export type TemporalOptions = {
  expectedSeconds: number;
  expectsSpeech: boolean;
  /** Seconds of A/V length difference tolerated (default 0.5). */
  tolerance?: number;
  /**
   * Cuts the plan allows inside this file. When given, more detected hard cuts than this is a finding
   * (a single-shot clip that jumps to another shot). Omit to skip the check.
   */
  expectedCuts?: number;
  /** Scene-score above which a frame change counts as a hard cut (default 0.45). */
  cutThreshold?: number;
  /** Seconds at the end that are a deliberate still (an end card): left out of the freeze, black and silence detectors. */
  tailSeconds?: number;
};

export type TemporalResult = { checks: QaCheckResult[]; findings: QaFinding[]; seconds: number; hasAudio: boolean };

const FREEZE_MIN = 1.0;
const BLACK_MIN = 0.25;
const SILENCE_MIN_SPEECH = 2.0;

async function safeRun(args: string[], timeoutMs = 90_000): Promise<string> {
  // A failed run still prints the report that is wanted (e.g. `-i` alone exits non-zero).
  return runFfmpeg(args, { timeoutMs }).catch((e: Error) => e.message);
}

export async function temporalChecks(file: string, opts: TemporalOptions): Promise<TemporalResult> {
  const tolerance = opts.tolerance ?? 0.5;
  const info = await probe(file);
  const seconds = info.seconds;
  const hasAudio = info.hasAudio;
  const checks: QaCheckResult[] = [];
  const findings: QaFinding[] = [];
  if (seconds <= 0) {
    findings.push({ code: "unreadable_file", severity: "critical", category: "technical", message: "The clip could not be read.", evidence: "ffmpeg reported no duration.", correction: "Regenerate the clip.", source: "ffmpeg" });
    checks.push({ name: "File readable", ok: false, detail: "no duration", severity: "critical" });
    return { checks, findings, seconds: 0, hasAudio };
  }
  const head = opts.tailSeconds && opts.tailSeconds > 0 ? Math.max(seconds - opts.tailSeconds - 0.1, 0.5) : seconds;
  const headArgs = head < seconds ? ["-t", String(round2(head))] : [];
  const cutThreshold = opts.cutThreshold ?? 0.45;

  const wantScenes = opts.expectedCuts !== undefined;
  const [detect, scene, decimated, vReport, aReport] = await Promise.all([
    safeRun([...headArgs, "-i", file, "-vf", "freezedetect=n=-55dB:d=1,blackdetect=d=0.2:pix_th=0.1", ...(hasAudio ? ["-af", "silencedetect=n=-40dB:d=1.2,volumedetect"] : ["-an"]), "-fps_mode", "passthrough", "-f", "null", "-"]),
    wantScenes ? safeRun([...headArgs, "-i", file, "-an", "-vf", "select='gt(scene,0.25)',metadata=print", "-fps_mode", "passthrough", "-f", "null", "-"]) : Promise.resolve(""),
    safeRun([...headArgs, "-i", file, "-an", "-vf", "mpdecimate", "-fps_mode", "passthrough", "-f", "null", "-"]),
    safeRun(["-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"], 60_000),
    hasAudio ? safeRun(["-i", file, "-map", "0:a:0", "-c", "copy", "-f", "null", "-"], 60_000) : Promise.resolve(""),
  ]);

  // --- length
  const far = Math.max(1.5, opts.expectedSeconds * 0.2);
  const lengthOk = Math.abs(seconds - opts.expectedSeconds) <= far;
  checks.push({ name: "Length", ok: lengthOk, detail: `${seconds.toFixed(1)}s (expected about ${opts.expectedSeconds.toFixed(1)}s)`, severity: lengthOk ? undefined : "major" });
  if (!lengthOk) {
    findings.push({
      code: "duration_off",
      severity: "major",
      category: "technical",
      message: `The clip is ${seconds.toFixed(1)}s long but the plan calls for about ${opts.expectedSeconds.toFixed(1)}s.`,
      evidence: `Measured ${seconds.toFixed(2)}s against ${opts.expectedSeconds.toFixed(2)}s planned.`,
      correction: `Fill the full ${Math.round(opts.expectedSeconds)} seconds with one continuous, unbroken action that starts at the first frame and ends on the last.`,
      source: "ffmpeg",
    });
  }

  // --- frozen footage
  const frozen = parseFreezeDetect(detect, head).filter((f) => f.duration >= FREEZE_MIN);
  const frozenTotal = frozen.reduce((t, f) => t + f.duration, 0);
  checks.push({ name: "No frozen footage", ok: frozen.length === 0, detail: frozen.length ? `${round2(frozenTotal)}s frozen in ${frozen.length} stretch(es)` : "none", severity: frozen.length ? (frozenTotal / head >= 0.5 ? "critical" : "major") : undefined });
  for (const f of frozen.slice(0, 3)) {
    const mostly = f.duration / head >= 0.5;
    findings.push({
      code: "frozen_footage",
      severity: mostly ? "critical" : "major",
      category: "temporal",
      message: mostly ? "Most of the clip is a frozen image." : `The picture freezes for ${f.duration.toFixed(1)}s.`,
      evidence: `Identical frames from ${fmtT(f.start)} to ${fmtT(f.end)} (${f.duration.toFixed(1)}s).`,
      atSeconds: f.start,
      correction: "Keep the subject and the camera moving gently through every second of the shot, with visible, continuous motion from the first frame to the last.",
      source: "ffmpeg",
    });
  }

  // --- duplicate frames (slideshow-like motion), only when nothing is frozen outright
  const totalFrames = lastNumber(detect, /frame=\s*(\d+)/g);
  const keptFrames = lastNumber(decimated, /frame=\s*(\d+)/g);
  if (totalFrames && keptFrames !== null && totalFrames >= 12 && !frozen.length) {
    const dup = round2(1 - keptFrames / totalFrames);
    const bad = dup >= 0.75;
    const warn = dup >= 0.5;
    checks.push({ name: "Continuous motion", ok: !warn, detail: `${Math.round(dup * 100)}% repeated frames`, severity: bad ? "major" : warn ? "minor" : undefined });
    if (warn) {
      findings.push({
        code: "duplicate_frames",
        severity: bad ? "major" : "minor",
        category: "temporal",
        message: bad ? "The clip is almost a still image with barely any motion." : "The clip has a lot of repeated frames, so the motion looks stuttery.",
        evidence: `${Math.round(dup * 100)}% of the frames repeat the previous frame (${keptFrames} distinct of ${totalFrames}).`,
        correction: "Give the subject a clear, continuous movement (a turn, a step, a gesture) so the motion reads smooth in every second.",
        source: "ffmpeg",
      });
    }
  }

  // --- black frames
  const black = parseBlack(detect).filter((b) => b.duration >= BLACK_MIN);
  const blackTotal = black.reduce((t, b) => t + b.duration, 0);
  checks.push({ name: "No black frames", ok: black.length === 0, detail: black.length ? `${round2(blackTotal)}s of black` : "none", severity: black.length ? (blackTotal / head >= 0.5 ? "critical" : "major") : undefined });
  for (const b of black.slice(0, 3)) {
    findings.push({
      code: "black_frames",
      severity: b.duration / head >= 0.5 ? "critical" : "major",
      category: "technical",
      message: `The picture goes black for ${b.duration.toFixed(1)}s.`,
      evidence: `Black frames from ${fmtT(b.start)} to ${fmtT(b.end)}.`,
      atSeconds: b.start,
      correction: "Keep a well-lit, fully visible scene on screen for the entire shot, with the subject lit from the first frame to the last.",
      source: "ffmpeg",
    });
  }

  // --- hard cuts inside the shot
  if (wantScenes) {
    const cuts = parseSceneScores(scene).filter((c) => c.score >= cutThreshold);
    const allowed = opts.expectedCuts ?? 0;
    const unplanned = cuts.length > allowed;
    checks.push({ name: "No unplanned cuts", ok: !unplanned, detail: cuts.length ? `${cuts.length} hard cut(s) at ${cuts.map((c) => fmtT(c.time)).join(", ")} (plan allows ${allowed})` : "none", severity: unplanned ? "major" : undefined });
    if (unplanned) {
      const c = [...cuts].sort((a, b) => b.score - a.score)[0]!;
      findings.push({
        code: "unplanned_cut",
        severity: "major",
        category: "temporal",
        message: `The shot suddenly jumps to a different picture at ${fmtT(c.time)}.`,
        evidence: `Scene-change score ${c.score.toFixed(2)} at ${fmtT(c.time)}; ${cuts.length} hard cut(s) found where the plan allows ${allowed}.`,
        atSeconds: c.time,
        correction: "Film this as one continuous take from a single camera position, with the same person, room and lighting from the first frame to the last.",
        source: "ffmpeg",
      });
    }
  }

  // --- audio
  if (!hasAudio) {
    if (opts.expectsSpeech) {
      checks.push({ name: "Sound present", ok: false, detail: "no audio track", severity: "critical" });
      findings.push({ code: "audio_missing", severity: "critical", category: "audio", message: "The clip has no audio, but this shot is meant to be spoken.", evidence: "No audio stream in the file.", correction: "Have the presenter speak the line aloud on camera, with a clear voice recorded in the clip.", source: "ffmpeg" });
    } else {
      checks.push({ name: "Sound present", ok: true, detail: "no audio track (not needed here)" });
    }
  } else {
    const silences = parseSilence(detect, head);
    const mean = lastNumber(detect, /mean_volume:\s*(-?[\d.]+) dB/g);
    const max = lastNumber(detect, /max_volume:\s*(-?[\d.]+) dB/g);
    const samples = lastNumber(detect, /n_samples:\s*(\d+)/g);
    const at0 = lastNumber(detect, /histogram_0db:\s*(\d+)/g);

    if (opts.expectsSpeech) {
      const long = silences.filter((s) => s.duration >= SILENCE_MIN_SPEECH);
      const silentTotal = long.reduce((t, s) => t + s.duration, 0);
      const mostly = silentTotal / head >= 0.8;
      checks.push({ name: "Speech without long silences", ok: long.length === 0, detail: long.length ? `silent for ${round2(silentTotal)}s: ${long.map((s) => `${fmtT(s.start)}-${fmtT(s.end)}`).join(", ")}` : "none", severity: long.length ? (mostly ? "critical" : "major") : undefined });
      for (const s of long.slice(0, 2)) {
        findings.push({
          code: "speech_silence",
          severity: mostly ? "critical" : "major",
          category: "speech",
          message: mostly ? "The speaking clip is almost entirely silent." : `A speaking clip goes silent for ${s.duration.toFixed(1)}s.`,
          evidence: `Silence below -40 dB from ${fmtT(s.start)} to ${fmtT(s.end)}.`,
          atSeconds: s.start,
          correction: "The presenter speaks the line in one steady flow starting within the first half second, with the voice audible through to the end of the shot.",
          source: "ffmpeg",
        });
      }
      if (mean !== null && !mostly) {
        const quiet = mean < -38;
        const lowish = mean < -30;
        checks.push({ name: "Loud enough", ok: !lowish, detail: `${mean} dB average`, severity: quiet ? "major" : lowish ? "minor" : undefined });
        if (lowish) {
          findings.push({ code: "audio_too_quiet", severity: quiet ? "major" : "minor", category: "audio", message: "The voice is very quiet.", evidence: `Mean volume ${mean} dB.`, correction: "The presenter speaks in a clear, confident, close-miked voice at normal conversational volume.", source: "ffmpeg" });
        }
      }
    }
    if (max !== null && samples && at0 !== null && max >= -0.1) {
      const share = at0 / samples;
      const clipped = share >= 0.002;
      checks.push({ name: "Audio not clipped", ok: !clipped, detail: `${(share * 100).toFixed(2)}% of samples at full scale`, severity: clipped ? (share >= 0.01 ? "major" : "minor") : undefined });
      if (clipped) {
        findings.push({ code: "audio_clipped", severity: share >= 0.01 ? "major" : "minor", category: "audio", message: "The audio distorts at its loudest points.", evidence: `${(share * 100).toFixed(2)}% of samples reach 0 dB (peak ${max} dB).`, correction: "The voice is spoken at an even, moderate level, with no shouting or sudden loud sounds.", source: "ffmpeg" });
      }
    }
  }

  // --- A/V length
  if (hasAudio) {
    const d = parseStreamDurations(`Duration: ${toHms(seconds)}\n[stream:video]\n${vReport}\n[stream:audio]\n${aReport}`);
    if (d.video !== null && d.audio !== null) {
      const diff = round2(Math.abs(d.video - d.audio));
      const ok = diff <= tolerance;
      checks.push({ name: "Picture and sound the same length", ok, detail: `video ${d.video}s, audio ${d.audio}s`, severity: ok ? undefined : "major" });
      if (!ok) {
        findings.push({
          code: "av_duration_mismatch",
          severity: "major",
          category: "technical",
          message: `The picture and the sound are different lengths (${d.video}s of video, ${d.audio}s of audio).`,
          evidence: `Stream lengths differ by ${diff}s.`,
          correction: "Produce the shot with the voice running for exactly the length of the picture, starting and finishing with it.",
          source: "ffmpeg",
        });
      }
    }
  }

  return { checks, findings, seconds, hasAudio };
}

function toHms(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

// ------------------------------------------------------------------ frames

/** Times for `count` evenly spaced frames across a clip, the first frame and the last included. */
export function frameTimes(seconds: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (!(seconds > 0) || n === 1) return [0];
  const last = Math.max(seconds - 0.12, 0);
  return Array.from({ length: n }, (_, i) => round2((i * last) / (n - 1)));
}

/** Extract one JPEG per requested time. A time that yields no frame is left out. */
export async function extractFramesAt(file: string, times: number[], dir: string, opts: { width?: number } = {}): Promise<Array<{ at: number; path: string; bytes: Buffer }>> {
  await mkdir(dir, { recursive: true });
  const width = opts.width ?? 720;
  type Frame = { at: number; path: string; bytes: Buffer };
  const results: Array<Frame | null> = await Promise.all(
    times.map(async (at, i): Promise<Frame | null> => {
      const out = path.join(dir, `frame-${String(i).padStart(2, "0")}-${Math.round(at * 100)}.jpg`);
      try {
        await runFfmpeg(["-ss", String(at), "-i", file, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", out], { timeoutMs: 45_000 });
        return { at, path: out, bytes: await readFile(out) };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is Frame => r !== null && r.bytes.length > 0);
}

/** `count` evenly spaced frames across the clip, first and last included, as JPEGs scaled to a width a vision model can read text at. */
export async function sampleFrames(file: string, count: number, dir: string, opts: { width?: number } = {}): Promise<Array<{ at: number; path: string; bytes: Buffer }>> {
  const info = await probe(file);
  return extractFramesAt(file, frameTimes(info.seconds, count), dir, opts);
}

// ------------------------------------------------------------------ vision review

export type VisionObservation = { category: QaCategory; severity: QaSeverity; atSeconds: number | null; message: string; evidence: string; correction: string };

export type VisionResult = {
  observations: VisionObservation[];
  textSeen: Array<{ text: string; atSeconds: number | null; kind: "word" | "logo_like" | "ui" | "number" | "gibberish" }>;
  faceConsistent: boolean | null;
  summary: string;
};

export type VisionReviewer = (input: { frames: Array<{ at: number; bytes: Buffer }>; reference: Buffer | null; rubric: string }) => Promise<VisionResult>;

export function visionRubric(ctx: { scenes: SceneBrief[]; characterDescription: string | null; expectsSpeech: boolean; allowedText: string[] }): string {
  const scenes = ctx.scenes.length
    ? ctx.scenes
        .map((s) => [`Scene ${s.number}: ${s.purpose}`, `  subject: ${s.subject}; setting: ${s.setting}; action: ${s.action}; framing: ${s.framing}`, s.acceptance.length ? `  acceptance checks: ${s.acceptance.join(" | ")}` : null].filter(Boolean).join("\n"))
        .join("\n")
    : "(no scene brief given)";
  return [
    "You are a strict quality inspector for AI-generated video-ad footage. You are given frames sampled in time order across ONE clip (each labelled with its time in seconds), and possibly a REFERENCE IMAGE of the approved presenter. Judge only what is visible. Inspect each frame in detail and compare frames with each other. Cite the time of every problem. A pleasant first impression proves nothing: look at faces, hands, edges, backgrounds and corners one by one. Do not invent problems: if a frame is fine, report nothing for it. An empty list is a good result. Never guess at text you cannot read.",
    "",
    "WHAT THE CLIP SHOULD SHOW",
    scenes,
    ctx.characterDescription ? `Presenter (must stay the same person throughout and match the reference image): ${ctx.characterDescription}` : "No recurring presenter is specified.",
    ctx.expectsSpeech ? "This is a speaking clip: a person talks to camera." : "This clip has no spoken line on camera.",
    "",
    "CHECK EACH OF THESE AND REPORT EVERY REAL FAILURE AS AN OBSERVATION (category, severity, time, what you see, what the frame should show instead):",
    "1. IDENTITY (category face): compare the presenter with the reference image and across frames: facial structure, hair, skin tone, clothing, apparent age. Set faceConsistent=false if the person changes or does not match the reference; true if consistent; null if there is no face or no reference.",
    "2. FACE ARTIFACTS (category face): morphing or melting features, waxy or plastic skin, warped or misaligned mouth or teeth, uneven eyes, glowing, neon or bright cyan marks or patches on the skin, stray dots or lines on the face. A prominent artifact on the face is critical.",
    "3. HANDS (category hands): extra or missing fingers, fused or bending-the-wrong-way fingers, overlapping or merging hands, hands not touching the object they hold, objects that slide, float or warp in the hand.",
    "4. BODY AND OBJECTS (category anatomy): impossible limbs, objects that bend, melt, duplicate or change shape between frames, incoherent reflections or shadows.",
    "5. FLICKER AND CONSISTENCY (category temporal): flicker, popping details, a background that changes, unexplained wardrobe or hair changes between frames.",
    "6. STRAY GRAPHICS (category composition): lines, bars, borders, glows or overlays that cut or split the frame, watermarks, floating panels or dashboards hanging in the air.",
    "7. TEXT OF ANY KIND (category text or branding): words, letters, numbers, wordmarks, logo-like marks, buttons, labels, signs, legible gibberish, dashboards or interface screens. Real text is added later by the video editor, never by the footage, so any of it is a defect. List EVERY piece in textSeen, verbatim when you can read it (kind: word, number, logo_like, ui or gibberish) with the time. For a logo-like mark you cannot read, put a short description as its text. Fabricated branding or a product name drawn in the footage is critical.",
    "8. RELEVANCE (category relevance): does the footage show each scene's subject, setting and action, and satisfy its acceptance checks? Report what is missing or wrong.",
    ctx.expectsSpeech ? "9. SPEECH (category lipsync): do the mouth movements look plausible for talking: opening and closing in rhythm, lips matching a person speaking, no frozen or rubbery mouth? Report a mouth that moves without speech or stays still while speaking." : "9. Skip speech checks.",
    "",
    ctx.allowedText.length ? `Text that is allowed to appear in the footage itself: ${ctx.allowedText.map((t) => `"${t}"`).join(", ")}. Still list it in textSeen.` : "No text at all is allowed in the footage itself.",
    "",
    "SEVERITY: critical = unusable as an ad (identity change, prominent face artifact, any readable text or logo or UI in the footage, a frame-splitting line, wrong subject). major = clearly noticeable defect a viewer would see (finger errors, warping object, flicker, wrong action). minor = small imperfection. In each observation's evidence say exactly what you see and where. In correction say, in positive terms, what the frame should show instead.",
    "Fill summary with two sentences on the clip's overall state.",
  ].join("\n");
}

const visionSchema = z.object({
  observations: z
    .array(
      z.object({
        category: z.enum(["face", "hands", "anatomy", "temporal", "text", "branding", "relevance", "speech", "lipsync", "audio", "technical", "composition", "claims", "subtitles"]),
        severity: z.enum(["critical", "major", "minor"]),
        atSeconds: z.number().nullable().describe("Time in seconds of the frame where it is visible, or null if throughout"),
        message: z.string(),
        evidence: z.string().describe("Exactly what is visible and where in the frame"),
        correction: z.string().describe("What the frame should show instead, phrased positively"),
      }),
    )
    .max(24),
  textSeen: z
    .array(z.object({ text: z.string(), atSeconds: z.number().nullable(), kind: z.enum(["word", "logo_like", "ui", "number", "gibberish"]) }))
    .max(40)
    .describe("Every piece of text, number, logo-like mark or interface visible, verbatim when readable"),
  faceConsistent: z.boolean().nullable(),
  summary: z.string(),
});

/** The multimodal reviewer, or null when no model is configured. */
export function createVisionReviewer(): VisionReviewer | null {
  const candidates = modelCandidates();
  if (!candidates.length) return null;
  return async ({ frames, reference, rubric }) => {
    const content: Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mediaType: string }> = [{ type: "text", text: rubric }];
    if (reference) {
      content.push({ type: "text", text: "REFERENCE IMAGE: the approved presenter. Compare every frame's person with this image." });
      content.push({ type: "image", image: new Uint8Array(reference), mediaType: "image/jpeg" });
    }
    for (const f of frames) {
      content.push({ type: "text", text: `Frame at ${round2(f.at)}s:` });
      content.push({ type: "image", image: new Uint8Array(f.bytes), mediaType: "image/jpeg" });
    }
    return withModelFallback(async (model) => (await generateObject({ model, schema: visionSchema, temperature: 0, messages: [{ role: "user", content }] })).object, candidates);
  };
}

// ------------------------------------------------------------------ mapping vision output to findings

function isAllowedText(text: string, allowed: string[]): boolean {
  const n = normaliseText(text);
  if (!n) return false;
  return allowed.some((a) => {
    const an = normaliseText(a);
    return an.length > 0 && (an === n || (n.length >= 2 && an.includes(n)));
  });
}

const PROMINENT_FACE = /glow|neon|cyan|morph|melt|warp|distort|deform|mark|patch|blotch|extra|missing|wax|plastic|swap|different person/i;

function observationCode(o: VisionObservation): string {
  const t = `${o.message} ${o.evidence}`.toLowerCase();
  switch (o.category) {
    case "face":
      return /glow|neon|cyan|mark|patch|dot|line/.test(t) ? "face_glow_marks" : /morph|melt|warp|distort|deform|swap/.test(t) ? "face_morphing" : "face_artifact";
    case "hands":
      return "hand_anomaly";
    case "anatomy":
      return "anatomy_defect";
    case "temporal":
      return /flicker/.test(t) ? "flicker" : /cloth|wardrobe|hair/.test(t) ? "wardrobe_change" : "temporal_instability";
    case "composition":
      return /line|bar|split|border|overlay|panel|dashboard|float/.test(t) ? "stray_overlay" : "composition_issue";
    case "relevance":
      return "scene_mismatch";
    case "lipsync":
      return "lipsync_off";
    case "text":
      return "fabricated_text";
    case "branding":
      return "invented_branding";
    default:
      return `${o.category}_issue`;
  }
}

const GENERIC_CORRECTION: Partial<Record<QaCategory, string>> = {
  face: "Show the presenter's face with natural, even skin, stable features and a relaxed, clear expression in every frame.",
  hands: "Show the hands with five natural fingers each, resting clearly on or holding the object, with the object staying steady in the grip.",
  anatomy: "Keep the body and every object solid and the same shape from frame to frame, with realistic proportions.",
  temporal: "Keep the lighting, wardrobe, hair and background identical from the first frame to the last.",
  composition: "Keep the frame a single, clean, full picture with nothing drawn across it.",
  relevance: "Show exactly the subject, setting and action in the scene brief, clearly and in the foreground.",
  lipsync: "Show the presenter's mouth forming the words naturally in rhythm with the voice.",
};

export function visionToFindings(result: VisionResult, allowedText: string[]): QaFinding[] {
  const findings: QaFinding[] = [];

  const seen = new Set<string>();
  for (const t of result.textSeen) {
    const key = `${t.kind}:${normaliseText(t.text) || t.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (t.kind !== "logo_like" && isAllowedText(t.text, allowedText)) continue;
    const shown = t.text.trim() ? `"${t.text.trim()}"` : "an unreadable mark";
    const at = t.atSeconds ?? undefined;
    if (t.kind === "logo_like") {
      findings.push({
        code: "invented_branding",
        severity: "critical",
        category: "branding",
        message: `A logo-like mark or wordmark (${shown}) appears inside the footage.`,
        evidence: `Logo-like mark seen${at !== undefined ? ` at ${fmtT(at)}` : ""}: ${shown}. The footage must not contain brand marks; the editor adds the real logo.`,
        atSeconds: at,
        correction: "Dress the presenter and the set in plain, solid-coloured clothing and unmarked props, leaving every brand mark to the closing card.",
        source: "vision",
      });
    } else {
      const what = t.kind === "ui" ? "an interface element or screen" : t.kind === "gibberish" ? "garbled lettering" : t.kind === "number" ? "a number" : "text";
      findings.push({
        code: "fabricated_text",
        severity: "critical",
        category: "text",
        message: `${what[0]!.toUpperCase()}${what.slice(1)} (${shown}) appears inside the footage.`,
        evidence: `Readable ${t.kind} ${shown}${at !== undefined ? ` at ${fmtT(at)}` : ""}, not part of the allowed text. Text is added by the editor, never drawn by the video model.`,
        atSeconds: at,
        correction:
          t.kind === "ui"
            ? "Frame the shot so any device or monitor shows only its back or a dark, blank face, keeping the presenter and the hands as the focus."
            : "Keep every surface in frame plain: clothing, walls, props and packaging show solid colours and natural texture.",
        source: "vision",
      });
    }
  }

  for (const o of result.observations) {
    let severity = o.severity;
    // A prominent artifact on the face is never a small thing.
    if (o.category === "face" && severity === "major" && PROMINENT_FACE.test(`${o.message} ${o.evidence}`)) severity = "critical";
    const code = observationCode(o);
    findings.push({
      code,
      severity,
      category: o.category,
      message: o.message,
      evidence: o.evidence,
      atSeconds: o.atSeconds ?? undefined,
      correction: o.correction.trim() || GENERIC_CORRECTION[o.category] || "Reshoot the scene so it matches the brief cleanly.",
      source: "vision",
    });
  }

  if (result.faceConsistent === false) {
    findings.push({
      code: "identity_drift",
      severity: "critical",
      category: "face",
      message: "The presenter does not look like the same person as the reference, or changes between frames.",
      evidence: result.summary ? `Reviewer summary: ${result.summary}` : "The face differs from the reference image or between frames.",
      correction: "Show the same presenter as the reference image in every frame: identical face shape, hair, skin tone, clothing and apparent age.",
      source: "vision",
    });
  }
  return findings;
}

// ------------------------------------------------------------------ speech against the plan (ASR)

function speechFindings(speech: SpeechLine[], asr: AsrWord[]): { findings: QaFinding[]; check: QaCheckResult } {
  const expectedDisplay = speech.flatMap((l) => tokenise(l.display));
  const expectedSpoken = speech.flatMap((l) => tokenise(l.spoken));
  const heard = asr.flatMap((w) => tokenise(w.word));
  const heardSet = new Set(heard);
  const expectedSet = new Set([...expectedDisplay, ...expectedSpoken]);
  const text = speech.map((l) => l.display).join(" ");
  if (!heard.length) {
    return {
      check: { name: "Spoken words match the script", ok: false, detail: "no speech detected", severity: "major" },
      findings: [{ code: "speech_not_detected", severity: "major", category: "speech", message: "No spoken words were detected in the clip.", evidence: "Transcription of the clip's audio came back empty.", correction: `The presenter says clearly, from the first second: "${text}"`, source: "asr" }],
    };
  }
  const base = expectedSpoken.length ? expectedSpoken : expectedDisplay;
  const recall = base.length ? base.filter((w) => heardSet.has(w)).length / base.length : 1;
  const precision = heard.filter((w) => expectedSet.has(w)).length / heard.length;
  const findings: QaFinding[] = [];
  if (base.length >= 3 && recall < 0.6) {
    findings.push({
      code: "speech_mismatch",
      severity: "major",
      category: "speech",
      message: "The spoken words do not match the script.",
      evidence: `Heard: "${heard.join(" ").slice(0, 160)}". Expected: "${text.slice(0, 160)}". Only ${Math.round(recall * 100)}% of the scripted words were heard.`,
      correction: `The presenter says exactly these words in order, each one fully pronounced: "${text.slice(0, 220)}"`,
      source: "asr",
    });
  } else if (heard.length >= 4 && precision < 0.5) {
    findings.push({
      code: "speech_extra",
      severity: "major",
      category: "speech",
      message: "The clip contains spoken words that are not in the script.",
      evidence: `Heard: "${heard.join(" ").slice(0, 160)}". Only ${Math.round(precision * 100)}% of what was said is scripted.`,
      correction: `The presenter says only this line, then stays quiet and still: "${text.slice(0, 220)}"`,
      source: "asr",
    });
  }
  return { findings, check: { name: "Spoken words match the script", ok: findings.length === 0, detail: `${Math.round(recall * 100)}% of scripted words heard, ${Math.round(precision * 100)}% of heard words scripted`, severity: findings.length ? "major" : undefined } };
}

// ------------------------------------------------------------------ decision and corrections (pure)

export type ClipDecisionContext = {
  attempt: number;
  maxAttempts: number;
  spentUsd: number;
  budgetUsd: number;
  nextAttemptUsd: number;
  visionAvailable: boolean;
  requireVision: boolean;
  /** Finding codes from the previous attempt: a code that comes back means the model cannot do this shot. */
  previousCodes?: string[];
  /** Redesigns already made for this clip and how many are allowed (default 1). */
  redesignsUsed?: number;
  maxRedesigns?: number;
};

export function decideClip(findings: QaFinding[], ctx: ClipDecisionContext): { verdict: QaVerdict; reason: string } {
  const open = findings.filter((f) => f.severity === "critical" || f.severity === "major");
  const minors = findings.length - open.length;
  if (!open.length) {
    if (ctx.requireVision && !ctx.visionAvailable) return { verdict: "unresolved", reason: "No visual review could be done, so the clip cannot be called good." };
    return { verdict: "pass", reason: minors ? `No blocking problems (${minors} minor note${minors === 1 ? "" : "s"} recorded).` : "No problems found." };
  }
  const codes = [...new Set(open.map((f) => f.code))];
  const canAfford = ctx.spentUsd + ctx.nextAttemptUsd <= ctx.budgetUsd;
  const redesignsLeft = (ctx.redesignsUsed ?? 0) < (ctx.maxRedesigns ?? 1);
  const repeated = codes.filter((c) => ctx.previousCodes?.includes(c));
  if (repeated.length) {
    if (canAfford && redesignsLeft) return { verdict: "redesign", reason: `The same problem came back (${repeated.join(", ")}), so the shot is redesigned instead of repeated.` };
    return { verdict: "unresolved", reason: `The same problem came back (${repeated.join(", ")}) and there is no budget or redesign left.` };
  }
  if (ctx.attempt < ctx.maxAttempts) {
    if (canAfford) return { verdict: "retry", reason: `Retrying with targeted corrections for: ${codes.join(", ")}.` };
    return { verdict: "unresolved", reason: `Problems found (${codes.join(", ")}) but the cost cap does not allow another attempt.` };
  }
  if (canAfford && redesignsLeft) return { verdict: "redesign", reason: `Retries are used up (${codes.join(", ")}); the shot is redesigned.` };
  return { verdict: "unresolved", reason: `Retries are used up and open problems remain: ${codes.join(", ")}.` };
}

const SEVERITY_ORDER: Record<QaSeverity, number> = { critical: 0, major: 1, minor: 2 };
const TEXT_FAMILY = new Set(["fabricated_text", "invented_branding"]);
const NEGATIVE_TEXT = /\b(no|without|never|avoid|free of|remove)\b[^.]{0,30}\b(text|lettering|letters|logos?|writing|words|marks?|brand)/i;

/** Deduped, targeted, positive corrections for the next attempt's prompt (at most 6). */
export function correctionLines(findings: QaFinding[]): string[] {
  const open = findings.filter((f) => f.severity !== "minor").sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const lines: string[] = [];
  const seen = new Set<string>();
  let negativeTextUsed = false;
  for (const f of open) {
    const line = f.correction.trim().replace(/\s+/g, " ");
    if (!line) continue;
    const key = normaliseText(line);
    if (seen.has(key)) continue;
    if (TEXT_FAMILY.has(f.code) || f.category === "text" || f.category === "branding") {
      if (NEGATIVE_TEXT.test(line)) {
        if (negativeTextUsed) continue;
        negativeTextUsed = true;
      }
    }
    seen.add(key);
    lines.push(line);
    if (lines.length >= 6) break;
  }
  return lines;
}

/** Plain strings the scene planner receives to redesign the shot. */
export function redesignReasons(findings: QaFinding[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
    if (f.severity === "minor" || seen.has(f.code)) continue;
    seen.add(f.code);
    out.push(`${f.message}${f.atSeconds !== undefined ? ` (at ${fmtT(f.atSeconds)})` : ""} Evidence: ${f.evidence}`.trim());
    if (out.length >= 8) break;
  }
  return out;
}

export function summariseQa(report: QaReport): string {
  const count = (s: QaSeverity) => report.findings.filter((f) => f.severity === s).length;
  const who = report.subject.kind === "clip" ? `Clip ${report.subject.clip}` : "Final video";
  const top = report.findings
    .filter((f) => f.severity !== "minor")
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, 3)
    .map((f) => `${f.message}${f.atSeconds !== undefined ? ` (${fmtT(f.atSeconds)})` : ""}`);
  const parts = [`${who}, attempt ${report.attempt}: ${report.verdict}.`, `${count("critical")} critical, ${count("major")} major, ${count("minor")} minor; ${report.framesInspected} frame${report.framesInspected === 1 ? "" : "s"} inspected.`];
  if (top.length) parts.push(`Main problems: ${top.join("; ")}.`);
  if (report.limitations.length) parts.push(`Not checked: ${report.limitations.join("; ")}.`);
  return parts.join(" ");
}

// ------------------------------------------------------------------ orchestrator

export type ReviewClipInput = {
  file: string;
  clip: number;
  attempt: number;
  scenes: SceneBrief[];
  characterDescription: string | null;
  referenceImage: Buffer | null;
  expectedSeconds: number;
  expectsSpeech: boolean;
  speech: SpeechLine[];
  asr: AsrWord[] | null;
  allowedText?: string[];
  requireVision?: boolean;
  frameCount?: number;
  workDir: string;
  /** Hard cuts the plan allows inside this clip (default: one fewer than the scenes it holds). */
  expectedCuts?: number;
  /** Overrides for the decision policy (attempt limits, budget). */
  policy?: Partial<ClipDecisionContext>;
};

export type ReviewClipDeps = {
  reviewer?: VisionReviewer | null;
  transcribe?: (file: string) => Promise<AsrWord[] | null>;
};

async function defaultTranscribe(file: string, workDir: string): Promise<AsrWord[] | null> {
  try {
    await mkdir(workDir, { recursive: true });
    const wav = path.join(workDir, `qa-voice-${Date.now()}.wav`);
    await runFfmpeg(["-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { timeoutMs: 60_000 });
    return await transcribeWords(await readFile(wav));
  } catch {
    return null;
  }
}

export async function reviewClip(input: ReviewClipInput, deps: ReviewClipDeps = {}): Promise<QaReport> {
  const requireVision = input.requireVision ?? true;
  const allowedText = input.allowedText ?? [];
  const limitations: string[] = [];
  const findings: QaFinding[] = [];
  const checks: QaCheckResult[] = [];
  let framesInspected = 0;

  // 1. Measured by ffmpeg.
  let seconds = 0;
  try {
    const t = await temporalChecks(input.file, { expectedSeconds: input.expectedSeconds, expectsSpeech: input.expectsSpeech, expectedCuts: input.expectedCuts ?? Math.max(input.scenes.length - 1, 0) });
    checks.push(...t.checks);
    findings.push(...t.findings);
    seconds = t.seconds;
  } catch (error) {
    limitations.push(`technical checks could not run: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. What was said, against the script.
  if (input.expectsSpeech && input.speech.length) {
    let asr = input.asr;
    if (!asr) {
      try {
        asr = deps.transcribe ? await deps.transcribe(input.file) : await defaultTranscribe(input.file, input.workDir);
      } catch {
        asr = null;
      }
    }
    if (asr) {
      const s = speechFindings(input.speech, asr);
      checks.push(s.check);
      findings.push(...s.findings);
    } else {
      limitations.push("speech was not transcribed, so the spoken words were not compared with the script");
    }
  }

  // 3. What the frames show.
  const reviewer = deps.reviewer === undefined ? createVisionReviewer() : deps.reviewer;
  let visionAvailable = false;
  if (!reviewer) {
    limitations.push("visual review not performed (no vision model is configured)");
  } else {
    try {
      const frames = await sampleFrames(input.file, input.frameCount ?? 8, path.join(input.workDir, `clip-${input.clip}-a${input.attempt}`));
      if (!frames.length) throw new Error("no frames could be extracted from the clip");
      const rubric = visionRubric({ scenes: input.scenes, characterDescription: input.characterDescription, expectsSpeech: input.expectsSpeech, allowedText });
      const result = await reviewer({ frames: frames.map((f) => ({ at: f.at, bytes: f.bytes })), reference: input.referenceImage, rubric });
      visionAvailable = true;
      framesInspected = frames.length;
      const v = visionToFindings(result, allowedText);
      findings.push(...v);
      checks.push({ name: "Visual review", ok: !v.some((f) => f.severity !== "minor"), detail: result.summary || `${frames.length} frames inspected`, severity: v.some((f) => f.severity === "critical") ? "critical" : v.some((f) => f.severity === "major") ? "major" : undefined });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Visual review of a clip failed", { clip: input.clip, error: message });
      limitations.push(`visual review failed: ${message}`);
    }
  }
  if (seconds > 0) checks.push({ name: "Frames inspected", ok: framesInspected > 0, detail: `${framesInspected} of ${seconds.toFixed(1)}s` });

  // 4. Decide.
  const decision = decideClip(findings, {
    attempt: input.attempt,
    maxAttempts: 3,
    spentUsd: 0,
    budgetUsd: Number.POSITIVE_INFINITY,
    nextAttemptUsd: 0,
    requireVision,
    previousCodes: [],
    ...input.policy,
    visionAvailable,
  });
  checks.push({ name: "Decision", ok: decision.verdict === "pass", detail: decision.reason });

  return { subject: { kind: "clip", clip: input.clip }, attempt: input.attempt, checkedAt: new Date().toISOString(), verdict: decision.verdict, findings, checks, framesInspected, limitations };
}
