/**
 * Captions and on-screen timing, worked out from the script and from when the words are actually
 * spoken. The text on screen is always the script's own words (never what a transcriber heard), so
 * spelling and numbers are exact; the transcript is used only to know WHEN each word is said.
 * Pure: no files, no network.
 */

export type AsrWord = { word: string; start: number; end: number };
export type TimedWord = { text: string; start: number; end: number; matched: boolean };

const norm = (w: string) =>
  w
    .toLowerCase()
    .replace(/[%$]/g, (c) => (c === "%" ? " percent " : ""))
    .replace(/[^a-z0-9\s]/g, "")
    .trim();

/** Words as written in the script (kept with their punctuation for display). */
export function splitWords(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

function close(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  // one slip is fine ("tracked" / "track")
  if (Math.abs(a.length - b.length) > 1) return false;
  let diff = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length; i += 1, j += 1) {
    if (a[i] !== b[j]) {
      diff += 1;
      if (diff > 1) return false;
    }
  }
  return true;
}

/**
 * Give every script word a time. Each is matched to the next transcript word that sounds like it;
 * words with no match are spread between their neighbours. Everything stays inside the scene's window.
 */
export function alignWords(words: string[], asr: AsrWord[], window: { start: number; end: number }): TimedWord[] {
  const inside = asr.filter((a) => a.end >= window.start - 0.8 && a.start <= window.end + 0.8);
  const out: TimedWord[] = words.map((text) => ({ text, start: NaN, end: NaN, matched: false }));
  let cursor = 0;
  for (const w of out) {
    const target = norm(w.text).split(/\s+/)[0] ?? "";
    if (!target) continue;
    for (let k = cursor; k < Math.min(cursor + 6, inside.length); k += 1) {
      const heard = norm(inside[k]!.word).split(/\s+/)[0] ?? "";
      if (close(target, heard)) {
        w.start = inside[k]!.start;
        w.end = inside[k]!.end;
        w.matched = true;
        cursor = k + 1;
        break;
      }
    }
  }
  return fillGaps(out, window);
}

/** Spread unmatched words evenly between the matched ones (or across the window when none matched). */
export function fillGaps(words: TimedWord[], window: { start: number; end: number }): TimedWord[] {
  if (!words.length) return words;
  const lo = window.start + 0.15;
  const hi = Math.max(lo + 0.3, window.end - 0.3);
  let i = 0;
  while (i < words.length) {
    if (words[i]!.matched) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < words.length && !words[j]!.matched) j += 1;
    const before = i > 0 ? words[i - 1]!.end : lo;
    const after = j < words.length ? words[j]!.start : hi;
    const span = Math.max(after - before, 0.1 * (j - i));
    for (let k = i; k < j; k += 1) {
      words[k]!.start = before + (span * (k - i)) / (j - i);
      words[k]!.end = before + (span * (k - i + 1)) / (j - i);
    }
    i = j;
  }
  // never outside the scene, never backwards
  let last = window.start;
  for (const w of words) {
    w.start = Math.min(Math.max(w.start, last, window.start), window.end);
    w.end = Math.min(Math.max(w.end, w.start + 0.12), window.end + 0.4);
    last = w.start;
  }
  return words;
}

/** How much of the script the transcript confirmed. Below this the transcript is not trusted for timing. */
export function matchedShare(words: TimedWord[]): number {
  return words.length ? words.filter((w) => w.matched).length / words.length : 0;
}

export type Phrase = { words: TimedWord[]; start: number; end: number };

/** Break a scene's words into short on-screen phrases of at most `max` words, at punctuation where there is some. */
export function toPhrases(words: TimedWord[], max = 4): Phrase[] {
  const phrases: Phrase[] = [];
  let current: TimedWord[] = [];
  const flush = () => {
    if (current.length) phrases.push({ words: current, start: current[0]!.start, end: current[current.length - 1]!.end });
    current = [];
  };
  for (const w of words) {
    current.push(w);
    if (current.length >= max || /[.!?,;:]$/.test(w.text)) flush();
  }
  flush();
  // Each phrase stays up until the next begins (a short gap is fine), and just past the last word at the end.
  for (let i = 0; i < phrases.length; i += 1) {
    const next = phrases[i + 1];
    phrases[i]!.end = next ? Math.max(phrases[i]!.end, Math.min(next.start - 0.02, phrases[i]!.end + 0.5)) : phrases[i]!.end + 0.3;
  }
  return phrases;
}

/** Pango markup for a phrase: the highlighted words in the accent colour, everything escaped. */
export function phraseMarkup(phrase: Phrase, keywords: string[], accent: string, base = "#FFFFFF"): string {
  const keyTokens = new Set(keywords.flatMap((k) => k.split(/\s+/)).map((t) => norm(t).split(/\s+/)[0] ?? "").filter(Boolean));
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return phrase.words
    .map((w) => {
      const hit = keyTokens.has(norm(w.text).split(/\s+/)[0] ?? "");
      return `<span foreground="${hit ? accent : base}">${esc(w.text)}</span>`;
    })
    .join(" ");
}

export type SceneWindow = { number: number; start: number; end: number };

/**
 * Where each scene falls in the finished video. A clip can come back a little longer or shorter than
 * planned, so scenes are stretched to fit the clip they are in.
 */
export function sceneWindows(
  scenes: Array<{ number: number; start: number; end: number }>,
  clips: Array<{ sceneNumbers: number[]; plannedSeconds: number; actualSeconds: number }>,
): SceneWindow[] {
  const out: SceneWindow[] = [];
  let offset = 0;
  for (const clip of clips) {
    const members = scenes.filter((s) => clip.sceneNumbers.includes(s.number));
    if (!members.length) {
      offset += clip.actualSeconds;
      continue;
    }
    const planStart = members[0]!.start;
    const factor = clip.plannedSeconds > 0 ? clip.actualSeconds / clip.plannedSeconds : 1;
    for (const s of members) out.push({ number: s.number, start: offset + (s.start - planStart) * factor, end: offset + (s.end - planStart) * factor });
    offset += clip.actualSeconds;
  }
  return out;
}

/** "255% avg client ROI" becomes a big value and a small label. */
export function splitStat(stat: string): { value: string; label: string } {
  const m = stat.trim().match(/^([$€£]?\s?[\d][\d.,]*\s?(?:%|x|X|k|K|m|M|b|B|hr|hrs|min)?\+?)\s*(.*)$/);
  return m ? { value: m[1]!.trim(), label: m[2]!.trim() } : { value: stat.trim(), label: "" };
}

/** When a stat shows: from when it is said (or just after the scene starts) for a few seconds, never past the scene. */
export function statWindow(window: SceneWindow, spoken: TimedWord[], stat: string): { start: number; end: number } {
  const target = norm(splitStat(stat).value).split(/\s+/)[0] ?? "";
  const hit = target ? spoken.find((w) => (norm(w.text).split(/\s+/)[0] ?? "") === target) : undefined;
  const start = Math.min(Math.max(hit ? hit.start - 0.1 : window.start + 0.3, window.start + 0.1), window.end - 1.2);
  const end = Math.min(window.end, Math.max(start + 2.5, window.start + (window.end - window.start)));
  return { start: Math.max(window.start, start), end };
}
