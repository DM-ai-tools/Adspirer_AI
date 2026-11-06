import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

/** Run ffmpeg with the bundled binary. Resolves with its stderr (where it reports), rejects with the tail of it on failure. */
export function runFfmpeg(args: string[], options: { timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg is not available on this server."));
      return;
    }
    const child = spawn(ffmpegPath, ["-hide_banner", "-nostdin", "-y", ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 400_000) stderr = stderr.slice(-200_000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ffmpeg took too long and was stopped."));
    }, options.timeoutMs ?? 240_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`ffmpeg failed (${code}): ${stderr.split("\n").slice(-12).join("\n")}`));
    });
  });
}

export type MediaInfo = { seconds: number; width: number | null; height: number | null; fps: number | null; hasAudio: boolean };

/** Read a file's length, size and streams from ffmpeg's own report (no separate ffprobe needed). */
export function parseMediaInfo(report: string): MediaInfo {
  const dur = report.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const seconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const videoLine = report.split("\n").find((l) => /Stream #\d+:\d+[^\n]*Video:/.test(l)) ?? "";
  const size = videoLine.match(/,\s*(\d{2,5})x(\d{2,5})/);
  const rate = videoLine.match(/([\d.]+)\s*fps/);
  return {
    seconds,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: rate ? Number(rate[1]) : null,
    hasAudio: /Stream #\d+:\d+[^\n]*Audio:/.test(report),
  };
}

export async function probe(file: string): Promise<MediaInfo> {
  // `-i` alone exits with an error code after printing the report; that report is what is wanted.
  const report = await runFfmpeg(["-i", file]).catch((e: Error) => e.message);
  return parseMediaInfo(report);
}

export type QaReport = { blackSeconds: number; silentStretches: number; meanVolumeDb: number | null };

/** Black frames, long silences and the loudness, measured by running the file through ffmpeg's detectors. */
export async function measure(file: string, untilSeconds?: number): Promise<QaReport> {
  // `until` leaves out a closing card, whose silence is deliberate.
  const report = await runFfmpeg(["-i", file, ...(untilSeconds ? ["-t", String(untilSeconds)] : []), "-vf", "blackdetect=d=0.4:pix_th=0.08", "-af", "silencedetect=n=-45dB:d=1.5,volumedetect", "-f", "null", "-"]);
  const black = [...report.matchAll(/black_duration:([\d.]+)/g)].reduce((t, m) => t + Number(m[1]), 0);
  const silent = [...report.matchAll(/silence_end:/g)].length;
  const mean = report.match(/mean_volume:\s*(-?[\d.]+) dB/);
  return { blackSeconds: Math.round(black * 100) / 100, silentStretches: silent, meanVolumeDb: mean ? Number(mean[1]) : null };
}
