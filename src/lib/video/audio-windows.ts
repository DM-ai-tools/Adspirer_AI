import type { SceneWindow, TimedWord } from "@/lib/video/captions";

/**
 * Scene boundaries from the measured audio.
 *
 * Narration is generated together with the picture, so a scene's planned window is only an estimate
 * (scaled to the clip's real length). When the speech of a scene has been located in the audio, the
 * window follows the speech instead: it starts just before the first word and ends just after the
 * last, so a stat, an image or a caption tied to the line lands when the line is actually said.
 * Scenes with no located speech keep their planned window. Windows never overlap and never leave the
 * video. Pure.
 */
export function refineWindows(
  planned: SceneWindow[],
  aligned: Array<{ sceneNumber: number; words: TimedWord[]; fromAudio: boolean }>,
  totalSeconds: number,
  opts: { lead?: number; tail?: number } = {},
): SceneWindow[] {
  const lead = opts.lead ?? 0.2;
  const tail = opts.tail ?? 0.35;
  const byScene = new Map(aligned.map((a) => [a.sceneNumber, a]));
  const out = planned.map((w) => {
    const a = byScene.get(w.number);
    if (!a || !a.fromAudio || !a.words.length) return { ...w };
    const first = Math.min(...a.words.map((x) => x.start));
    const last = Math.max(...a.words.map((x) => x.end));
    return { number: w.number, start: Math.max(0, first - lead), end: Math.min(totalSeconds, last + tail) };
  });
  out.sort((x, y) => x.start - y.start);
  // No window may start before the previous one has ended.
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1]!;
    const cur = out[i]!;
    if (cur.start < prev.end) {
      const mid = (cur.start + prev.end) / 2;
      prev.end = Math.max(prev.start + 0.2, Math.min(prev.end, mid));
      cur.start = Math.max(cur.start, prev.end);
    }
    if (cur.end < cur.start + 0.2) cur.end = Math.min(totalSeconds, cur.start + 0.2);
  }
  return out;
}
