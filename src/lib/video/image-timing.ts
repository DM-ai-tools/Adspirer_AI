import type { SceneWindow, TimedWord } from "@/lib/video/captions";

/**
 * When an uploaded stat image is on screen. It should arrive when its figure is about to be said,
 * stay while the point is being made, and leave once the point is finished: one continuous showing
 * for consecutive scenes that use the same image (never a pop in and out per scene), long enough to
 * read, and never overlapping another image. Pure.
 */

export type ImageSpan = { assetId: string; start: number; end: number; scenes: number[] };

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9.%$]+/g, "");

/** The time a figure is first said, from the words as spoken: the word that is the figure or its start ("26.5" for "26.5M"). */
export function firstMention(words: TimedWord[], figure: string): number | null {
  const target = squash(figure);
  if (!target) return null;
  for (const w of words) {
    const t = squash(w.text);
    if (t && (t === target || (t.length >= 2 && target.startsWith(t)) || (target.length >= 2 && t.startsWith(target)))) return w.start;
  }
  return null;
}

export type ImageTimingInput = {
  scenes: Array<{ number: number; assetId: string | null; stat: string | null }>;
  windows: SceneWindow[];
  /** The spoken words of each scene, timed against the audio. */
  words: Map<number, TimedWord[]>;
  /** The figures read from each image: the image arrives before the first of them is said. */
  figuresByAsset: Record<string, string[]>;
  totalSeconds: number;
  /** How long before the figure is said the image arrives. */
  lead?: number;
  /** How long it lingers after the last scene that uses it. */
  tail?: number;
  /** The least time it stays, so it can be read. */
  minShow?: number;
};

export function imageSpansFor(input: ImageTimingInput): ImageSpan[] {
  const lead = input.lead ?? 0.45;
  const tail = input.tail ?? 0.5;
  const minShow = input.minShow ?? 2.8;
  const win = new Map(input.windows.map((w) => [w.number, w]));
  const ordered = [...input.scenes].sort((a, b) => (win.get(a.number)?.start ?? 0) - (win.get(b.number)?.start ?? 0));

  // Consecutive scenes that show the same image are one showing.
  const groups: Array<{ assetId: string; scenes: number[] }> = [];
  for (const s of ordered) {
    if (!s.assetId || !win.has(s.number)) continue;
    const last = groups[groups.length - 1];
    const previous = last && ordered[ordered.findIndex((x) => x.number === last.scenes[last.scenes.length - 1]) + 1];
    if (last && last.assetId === s.assetId && previous?.number === s.number) last.scenes.push(s.number);
    else groups.push({ assetId: s.assetId, scenes: [s.number] });
  }

  const spans: ImageSpan[] = [];
  for (const g of groups) {
    const first = win.get(g.scenes[0]!)!;
    const lastWindow = win.get(g.scenes[g.scenes.length - 1]!)!;
    const figures = [...(input.figuresByAsset[g.assetId] ?? []), ...g.scenes.map((n) => input.scenes.find((s) => s.number === n)?.stat).filter((s): s is string => Boolean(s))];
    // The image arrives just before the first of its figures is said, in the first scene that says one.
    let mention: number | null = null;
    for (const n of g.scenes) {
      const words = input.words.get(n) ?? [];
      const times = figures.map((f) => firstMention(words, f)).filter((t): t is number => t !== null);
      if (times.length) {
        mention = Math.min(...times);
        break;
      }
    }
    const start = Math.max(first.start, (mention ?? first.start + 0.4) - lead);
    let end = Math.min(input.totalSeconds, lastWindow.end + tail);
    if (end - start < minShow) end = Math.min(input.totalSeconds, start + minShow);
    spans.push({ assetId: g.assetId, start, end, scenes: g.scenes });
  }

  // Never two images at once: the later one waits for the earlier to leave.
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i += 1) {
    const prev = spans[i - 1]!;
    const cur = spans[i]!;
    if (cur.start < prev.end + 0.15) {
      const mid = (cur.start + prev.end) / 2;
      prev.end = Math.max(prev.start + 1, Math.min(prev.end, mid));
      cur.start = Math.max(cur.start, prev.end + 0.15);
    }
  }
  return spans.filter((s) => s.end - s.start >= 1);
}
