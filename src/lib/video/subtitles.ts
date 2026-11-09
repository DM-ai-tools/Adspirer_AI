/**
 * Subtitles aligned to the audio, word by word, through an explicit spoken-to-display mapping.
 *
 * What is SPOKEN ("twelve million dollars", "roh ass") is matched against what the transcript HEARD,
 * then each segment's spoken-token timings are collapsed back onto the DISPLAY words, so "$12M+" spans
 * from the start of "twelve" to the end of "dollars". The display text is never altered. Cues are built
 * from those words with readable phrasing, and checked against reading-speed, length and timing rules.
 * A transcript that matches the script is evidence of timing, not proof of correct pronunciation.
 * Pure: no files, no network.
 */
import { fillGaps, type AsrWord, type TimedWord } from "@/lib/video/captions";
import { numberToWords } from "@/lib/video/pronunciation";
import type { QaCheckResult, QaFinding, SpeechLine } from "@/lib/video/pipeline-types";

// ------------------------------------------------------------------ tokens

/**
 * Words as compared for matching: lowercase, no punctuation or currency symbols, numbers as words
 * ("12" and "twelve" meet), hyphenated words split ("roh-ass" is "roh", "ass").
 */
export function spokenTokens(text: string): string[] {
  const s = text
    .toLowerCase()
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/%/g, " percent ")
    .replace(/[$€£¥₹]/g, " ");
  const out: string[] = [];
  for (const piece of s.split(/[\s\-–—]+/)) {
    const clean = piece.replace(/[^a-z0-9.]/g, "").replace(/^\.+|\.+$/g, "");
    if (!clean) continue;
    if (/^\d+(?:\.\d+)?$/.test(clean)) out.push(...numberToWords(Number(clean)).split(/[\s-]+/));
    else {
      const flat = clean.replace(/\./g, "");
      if (flat) out.push(flat);
    }
  }
  return out;
}

/** A rough sound key: "roh", "row" and "roas" agree; "ass" and "as" agree. Used only to compare near-homophones. */
function soundKey(w: string): string {
  let s = w
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/wh/g, "w")
    .replace(/^kn/, "n")
    .replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/q/g, "k")
    .replace(/z/g, "s");
  s = s.replace(/([aeiouy])[hw]/g, "$1").replace(/[hw]$/g, "");
  s = s.replace(/[aeiouy]+/g, "a").replace(/([^a])\1+/g, "$1");
  return s;
}

function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** How well two strings agree as one word (concatenations of several words included), or 0. */
function similarity(a: string, b: string, groupSize: number): number {
  if (!a || !b) return 0;
  const bonus = groupSize > 1 ? -0.4 : 0;
  if (a === b) return 3 + bonus;
  const ka = soundKey(a);
  const kb = soundKey(b);
  if (ka === kb && ka.length >= (groupSize > 1 ? 3 : 2)) return 2.4 + bonus;
  const shortest = Math.min(a.length, b.length);
  if (shortest >= 4 && editDistance(a, b, 1) <= 1) return 1.8 + bonus;
  if (shortest >= 7 && editDistance(a, b, 2) <= 2) return 1.5 + bonus;
  if (ka.length >= 4 && Math.min(ka.length, kb.length) >= 4 && editDistance(ka, kb, 1) <= 1) return 1.4 + bonus;
  return 0;
}

type Heard = { norm: string; start: number; end: number };
type Match = { start: number; end: number } | null;

const SKIP_EXPECTED = 0.6;
const SKIP_HEARD = 0.25;
const SHAPES: Array<[number, number]> = [[1, 1], [1, 2], [2, 1], [2, 2], [1, 3], [3, 1]];

/**
 * Monotonic alignment of the expected spoken tokens to the heard tokens (a Needleman-Wunsch style
 * search). One expected word may match one, two or three heard words joined together ("roh ass" heard
 * as "roas"), and the reverse. Returns a timing for each expected token, or null where nothing matched,
 * plus the heard tokens nothing was matched to.
 */
function alignTokens(expected: string[], heard: Heard[]): { matches: Match[]; extraHeard: Heard[] } {
  const m = expected.length;
  const n = heard.length;
  const NEG = -1e9;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(NEG));
  const back: Array<Array<[number, number] | null>> = Array.from({ length: m + 1 }, () => new Array<[number, number] | null>(n + 1).fill(null));
  dp[0]![0] = 0;
  for (let i = 0; i <= m; i += 1) {
    for (let j = 0; j <= n; j += 1) {
      const here = dp[i]![j]!;
      if (here === NEG) continue;
      const relax = (ni: number, nj: number, score: number) => {
        if (ni > m || nj > n) return;
        if (here + score > dp[ni]![nj]!) {
          dp[ni]![nj] = here + score;
          back[ni]![nj] = [i, j];
        }
      };
      relax(i + 1, j, -SKIP_EXPECTED);
      relax(i, j + 1, -SKIP_HEARD);
      for (const [a, b] of SHAPES) {
        if (i + a > m || j + b > n) continue;
        const sim = similarity(expected.slice(i, i + a).join(""), heard.slice(j, j + b).map((h) => h.norm).join(""), Math.max(a, b));
        if (sim > 0) relax(i + a, j + b, sim);
      }
    }
  }
  const matches: Match[] = new Array<Match>(m).fill(null);
  const used = new Array<boolean>(n).fill(false);
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const prev = back[i]![j];
    if (!prev) break;
    const [pi, pj] = prev;
    const a = i - pi;
    const b = j - pj;
    if (a > 0 && b > 0) {
      const t0 = heard[pj]!.start;
      const t1 = heard[j - 1]!.end;
      const weights = expected.slice(pi, i).map((w) => Math.max(1, w.length));
      const total = weights.reduce((x, y) => x + y, 0);
      let acc = 0;
      for (let k = 0; k < a; k += 1) {
        matches[pi + k] = { start: t0 + ((t1 - t0) * acc) / total, end: t0 + ((t1 - t0) * (acc + weights[k]!)) / total };
        acc += weights[k]!;
      }
      for (let k = pj; k < j; k += 1) used[k] = true;
    }
    i = pi;
    j = pj;
  }
  return { matches, extraHeard: heard.filter((_, k) => !used[k]) };
}

/** Transcript words that fall in a window (by their midpoint), as comparable tokens with times. */
function heardIn(asr: AsrWord[], from: number, to: number): Heard[] {
  const out: Heard[] = [];
  for (const w of asr) {
    const mid = (w.start + w.end) / 2;
    if (mid < from || mid > to) continue;
    const toks = spokenTokens(w.word);
    toks.forEach((norm, k) => out.push({ norm, start: w.start + ((w.end - w.start) * k) / toks.length, end: w.start + ((w.end - w.start) * (k + 1)) / toks.length }));
  }
  return out;
}

// ------------------------------------------------------------------ aligning a line

export type AlignedLine = {
  sceneNumber: number;
  /** One per display word (the line's own words with their punctuation), with the time each is said. */
  words: TimedWord[];
  fromAudio: boolean;
  /** Share of the spoken words the transcript confirmed, 0-1. */
  matchedShare: number;
  /** bind[i] is true when word i belongs to the same multi-word term as word i-1 (e.g. "2 million"), so it is never split from it. */
  bind?: boolean[];
};

/** Below this share of matched spoken words the transcript is not trusted for timing and words are spaced evenly. */
export const MIN_MATCHED_SHARE = 0.6;

type SpokenTok = { norm: string; from: number; to: number; group: number | null };

/**
 * Time every display word of a line from the audio. Matching is done on the SPOKEN tokens (so
 * "twelve million dollars" and "row as" are found where the script says "$12M+" and "ROAS"); the
 * timings are then collapsed onto the display words. `fromAudio` is true only when at least
 * MIN_MATCHED_SHARE (60%) of the spoken words were matched; otherwise the words are spaced evenly
 * across the window. Nothing is placed outside the window or backwards.
 */
export function alignSpeechLine(line: SpeechLine, asr: AsrWord[] | null, window: { start: number; end: number }): AlignedLine {
  const display = line.display;
  const wordRanges = [...display.matchAll(/\S+/g)].map((m) => ({ text: m[0], from: m.index!, to: m.index! + m[0].length }));
  if (!wordRanges.length) return { sceneNumber: line.sceneNumber, words: [], fromAudio: false, matchedShare: 0 };

  // Spoken tokens, each remembering which stretch of the display text it stands for.
  const tokens: SpokenTok[] = [];
  const groups: Array<{ from: number; to: number; isTerm: boolean }> = [];
  let pos = 0;
  for (const seg of line.segments) {
    const from = pos;
    const to = pos + seg.display.length;
    pos = to;
    if (seg.term === undefined && seg.spoken === seg.display) {
      for (const piece of seg.display.matchAll(/\S+/g)) {
        for (const norm of spokenTokens(piece[0])) tokens.push({ norm, from: from + piece.index!, to: from + piece.index! + piece[0].length, group: null });
      }
    } else {
      const toks = spokenTokens(seg.spoken);
      if (!toks.length) continue;
      groups.push({ from, to, isTerm: seg.term !== undefined });
      for (const norm of toks) tokens.push({ norm, from, to, group: groups.length - 1 });
    }
  }

  const expected = tokens.map((t) => t.norm);
  const heard = asr && asr.length ? heardIn(asr, window.start - 0.25, window.end + 0.25) : [];
  const { matches } = expected.length && heard.length ? alignTokens(expected, heard) : { matches: new Array<Match>(expected.length).fill(null) };
  const matchedCount = matches.filter(Boolean).length;
  const share = expected.length ? matchedCount / expected.length : 0;
  const fromAudio = share >= MIN_MATCHED_SHARE;

  const timed: TimedWord[] = expected.map((text, k) => {
    const hit = fromAudio ? matches[k] : null;
    return { text, start: hit ? hit.start : NaN, end: hit ? hit.end : NaN, matched: Boolean(hit) };
  });
  fillGaps(timed, window);
  let lastStart = window.start;
  for (const w of timed) {
    w.start = Math.min(Math.max(w.start, lastStart, window.start), Math.max(window.start, window.end - 0.02));
    w.end = Math.min(Math.max(w.end, w.start), window.end);
    lastStart = w.start;
  }

  // Collapse the token timings onto the display words.
  type Span = { start: number; end: number; matched: boolean };
  const spans: Array<Span | null> = wordRanges.map(() => null);
  const add = (idx: number, start: number, end: number, matched: boolean) => {
    const cur = spans[idx];
    spans[idx] = cur ? { start: Math.min(cur.start, start), end: Math.max(cur.end, end), matched: cur.matched && matched } : { start, end, matched };
  };
  const groupSpan = groups.map((_, gi) => {
    const idx = tokens.map((t, k) => (t.group === gi ? k : -1)).filter((k) => k >= 0);
    return { start: Math.min(...idx.map((k) => timed[k]!.start)), end: Math.max(...idx.map((k) => timed[k]!.end)), matched: idx.every((k) => timed[k]!.matched) };
  });
  tokens.forEach((t, k) => {
    if (t.group !== null) return;
    wordRanges.forEach((w, wi) => {
      if (t.from < w.to && t.to > w.from) add(wi, timed[k]!.start, timed[k]!.end, timed[k]!.matched);
    });
  });
  const bind = wordRanges.map(() => false);
  groups.forEach((g, gi) => {
    const covered = wordRanges.map((w, wi) => ({ w, wi })).filter(({ w }) => g.from < w.to && g.to > w.from);
    const span = groupSpan[gi]!;
    if (covered.length === 1) {
      add(covered[0]!.wi, span.start, span.end, span.matched);
      return;
    }
    const length = Math.max(1, g.to - g.from);
    covered.forEach(({ w, wi }, k) => {
      const f0 = (Math.max(g.from, w.from) - g.from) / length;
      const f1 = (Math.min(g.to, w.to) - g.from) / length;
      add(wi, span.start + (span.end - span.start) * f0, span.start + (span.end - span.start) * f1, span.matched);
      if (g.isTerm && k > 0) bind[wi] = true;
    });
  });

  // Words with no spoken token of their own (a dash, a symbol) take the time their neighbour ends.
  const words: TimedWord[] = [];
  let prevStart = window.start;
  let prevEnd = window.start;
  wordRanges.forEach((w, wi) => {
    const span = spans[wi];
    const start = Math.max(span ? span.start : prevEnd, prevStart);
    const end = Math.max(span ? span.end : start, start);
    words.push({ text: w.text, start, end, matched: span ? span.matched : false });
    prevStart = start;
    prevEnd = Math.max(prevEnd, end);
  });
  return { sceneNumber: line.sceneNumber, words, fromAudio, matchedShare: share, bind };
}

// ------------------------------------------------------------------ cues

export type SubtitleCue = { start: number; end: number; words: TimedWord[]; lines: string[]; text: string };

export type CueOptions = {
  maxCharsPerLine: number;
  maxLines: number;
  /** Reading speed ceiling in characters per second. */
  maxCps: number;
  minDuration: number;
  maxDuration: number;
  maxWordsPerCue: number;
};

/** Mobile vertical video: short lines, two at most, a comfortable reading speed. */
export const DEFAULT_CUE_OPTIONS: CueOptions = { maxCharsPerLine: 30, maxLines: 2, maxCps: 17, minDuration: 0.8, maxDuration: 6, maxWordsPerCue: 8 };

const PAUSE_GAP = 0.4;
const SENTENCE_END = /[.!?…]["')\]]?$/;
const SOFT_END = /[,;:—–]["')\]]?$/;
const MAGNITUDE_NEXT = /^(?:thousand|million|billion|trillion|percent|per|dollars?|euros?|pounds?|times|a\.?m\.?|p\.?m\.?)\b/i;

type Unit = { words: TimedWord[]; text: string };

/** Words that must stay together: a word bound to the previous one, a symbol or dash, or a magnitude after a number. */
function toUnits(words: TimedWord[], bind?: boolean[]): Unit[] {
  const units: Unit[] = [];
  words.forEach((w, i) => {
    const prev = units[units.length - 1];
    const glue =
      prev !== undefined &&
      (bind?.[i] === true ||
        !/[A-Za-z0-9]/.test(w.text) ||
        (MAGNITUDE_NEXT.test(w.text) && /\d/.test(prev.words[prev.words.length - 1]!.text)));
    if (glue) {
      prev.words.push(w);
      prev.text = `${prev.text} ${w.text}`;
    } else units.push({ words: [w], text: w.text });
  });
  return units;
}

/** Balanced line breaks between units, fewest lines first; null when the units cannot fit. */
function breakLines(units: Unit[], o: CueOptions): string[] | null {
  const texts = units.map((u) => u.text);
  const total = texts.join(" ").length;
  if (total <= o.maxCharsPerLine) return [texts.join(" ")];
  for (let n = 2; n <= o.maxLines; n += 1) {
    // best[k][l]: lowest cost of putting the first k units on l lines
    const cost: number[][] = Array.from({ length: texts.length + 1 }, () => new Array<number>(n + 1).fill(Infinity));
    const from: number[][] = Array.from({ length: texts.length + 1 }, () => new Array<number>(n + 1).fill(-1));
    cost[0]![0] = 0;
    for (let k = 1; k <= texts.length; k += 1) {
      for (let l = 1; l <= n; l += 1) {
        for (let p = l - 1; p < k; p += 1) {
          if (cost[p]![l - 1] === Infinity) continue;
          const line = texts.slice(p, k).join(" ");
          if (line.length > o.maxCharsPerLine) continue;
          let c = line.length * line.length;
          if (SENTENCE_END.test(line) || SOFT_END.test(line)) c -= 60;
          if (k - p === 1 && line.length < 5 && texts.length > 1) c += 80;
          if (cost[p]![l - 1]! + c < cost[k]![l]!) {
            cost[k]![l] = cost[p]![l - 1]! + c;
            from[k]![l] = p;
          }
        }
      }
    }
    if (cost[texts.length]![n] !== Infinity) {
      const lines: string[] = [];
      let k = texts.length;
      for (let l = n; l >= 1; l -= 1) {
        const p = from[k]![l]!;
        lines.unshift(texts.slice(p, k).join(" "));
        k = p;
      }
      return lines;
    }
  }
  return units.length === 1 ? [texts[0]!] : null; // a single long token overflows rather than being split
}

const unitsEnd = (units: Unit[]) => units[units.length - 1]!.words[units[units.length - 1]!.words.length - 1]!.end;
const unitsStart = (units: Unit[]) => units[0]!.words[0]!.start;
const wordCount = (units: Unit[]) => units.reduce((n, u) => n + u.words.length, 0);

function chunkScene(words: TimedWord[], bind: boolean[] | undefined, o: CueOptions): Unit[][] {
  const units = toUnits(words, bind);
  const chunks: Unit[][] = [];
  let chunk: Unit[] = [];
  const lastText = (c: Unit[]) => c[c.length - 1]!.text;
  for (const u of units) {
    if (chunk.length) {
      const gap = u.words[0]!.start - unitsEnd(chunk);
      const sentenceBreak = SENTENCE_END.test(lastText(chunk));
      const chars = chunk.map((x) => x.text).join(" ").length;
      const softBreak = SOFT_END.test(lastText(chunk)) && (chars >= 14 || chunk.length >= 3);
      const candidate = [...chunk, u];
      const over =
        wordCount(candidate) > o.maxWordsPerCue || unitsEnd(candidate) - unitsStart(candidate) > o.maxDuration || breakLines(candidate, o) === null;
      if (sentenceBreak || softBreak || gap >= PAUSE_GAP) {
        chunks.push(chunk);
        chunk = [];
      } else if (over) {
        // prefer to cut at a comma already inside the chunk over leaving a stranded word
        let cut = -1;
        for (let k = chunk.length - 2; k >= 1; k -= 1) {
          if (SOFT_END.test(chunk[k]!.text)) {
            cut = k + 1;
            break;
          }
        }
        if (cut > 0) {
          chunks.push(chunk.slice(0, cut));
          chunk = chunk.slice(cut);
        } else {
          chunks.push(chunk);
          chunk = [];
        }
      }
    }
    chunk.push(u);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

/**
 * Group the aligned words into readable cues: breaks at sentence ends, commas and natural pauses in
 * the audio, never inside a number, currency or other bound term, balanced line breaks within the
 * line and line limits, never across scenes. A cue's end is extended into the silence that follows
 * (never past the next cue) until its reading speed fits maxCps and minDuration; cues never overlap.
 */
export function buildCues(aligned: AlignedLine[], opts?: Partial<CueOptions>): SubtitleCue[] {
  const o: CueOptions = { ...DEFAULT_CUE_OPTIONS, ...opts };
  const cues: SubtitleCue[] = [];
  for (const line of aligned) {
    for (const chunk of chunkScene(line.words, line.bind, o)) {
      const words = chunk.flatMap((u) => u.words);
      const lines = breakLines(chunk, o) ?? [chunk.map((u) => u.text).join(" ")];
      const start = words[0]!.start;
      const end = Math.max(unitsEnd(chunk), start + 0.1);
      cues.push({ start, end, words, lines, text: lines.join("\n") });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  // Reading time: hold the cue into the following silence, never past the next cue.
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const next = cues[i + 1];
    const chars = cue.lines.join(" ").length;
    const wanted = Math.max(o.minDuration, chars / o.maxCps);
    const cap = Math.min(cue.start + o.maxDuration, next ? next.start - 0.04 : Infinity);
    const target = cue.start + wanted;
    if (target > cue.end) cue.end = Math.max(cue.end, Math.min(target, cap));
  }
  // No overlaps: trim the earlier cue, or nudge the later one when they begin together.
  for (let i = 1; i < cues.length; i += 1) {
    const prev = cues[i - 1]!;
    const cur = cues[i]!;
    if (prev.end > cur.start) {
      if (cur.start - prev.start >= 0.15) prev.end = cur.start;
      else {
        cur.start = prev.end;
        if (cur.end < cur.start + 0.1) cur.end = cur.start + 0.1;
      }
    }
  }
  return cues;
}

// ------------------------------------------------------------------ checks

const fixed = (n: number) => n.toFixed(2);

/**
 * Rule checks on finished cues: reading speed (major), line length, line count, overlap (major), a cue
 * outside the video (major), empty cues, cues shorter than the minimum, and word timings that run backwards (major).
 */
export function checkCues(cues: SubtitleCue[], opts?: Partial<CueOptions> & { videoSeconds?: number }): QaFinding[] {
  const o: CueOptions = { ...DEFAULT_CUE_OPTIONS, ...opts };
  const videoSeconds = opts?.videoSeconds;
  const findings: QaFinding[] = [];
  const add = (f: Omit<QaFinding, "category" | "source">) => findings.push({ ...f, category: "subtitles", source: "rule" });
  cues.forEach((cue, i) => {
    const label = `Cue ${i + 1} (${fixed(cue.start)}s-${fixed(cue.end)}s)`;
    const flat = cue.lines.join(" ").trim();
    const duration = cue.end - cue.start;
    if (!flat) {
      add({ code: "subtitle_empty", severity: "major", message: `${label} has no text.`, evidence: "empty cue", atSeconds: cue.start, correction: "Remove the empty cue or give it the words spoken at that moment." });
      return;
    }
    if (duration > 0) {
      const cps = flat.length / duration;
      if (cps > o.maxCps + 0.01) {
        add({
          code: "subtitle_too_fast",
          severity: "major",
          message: `${label} reads too fast.`,
          evidence: `${flat.length} characters in ${fixed(duration)}s is ${cps.toFixed(1)} characters per second, over the ${o.maxCps} limit: "${flat}"`,
          atSeconds: cue.start,
          correction: `Split the cue so each part has about ${Math.max(1, Math.floor(o.maxCps * Math.max(duration, o.minDuration)))} characters or fewer, or hold it on screen for at least ${fixed(flat.length / o.maxCps)}s.`,
        });
      }
    }
    const longest = Math.max(...cue.lines.map((l) => l.length));
    if (longest > o.maxCharsPerLine) {
      add({ code: "subtitle_line_too_long", severity: "minor", message: `${label} has a line that is too long.`, evidence: `${longest} characters on one line, over the ${o.maxCharsPerLine} limit`, atSeconds: cue.start, correction: `Break the line so none is longer than ${o.maxCharsPerLine} characters.` });
    }
    if (cue.lines.length > o.maxLines) {
      add({ code: "subtitle_too_many_lines", severity: "minor", message: `${label} has too many lines.`, evidence: `${cue.lines.length} lines, over the ${o.maxLines} limit`, atSeconds: cue.start, correction: `Split the cue so it has at most ${o.maxLines} lines.` });
    }
    if (duration < o.minDuration) {
      add({ code: "subtitle_too_short", severity: "minor", message: `${label} is on screen too briefly.`, evidence: `${fixed(duration)}s, under the ${o.minDuration}s minimum`, atSeconds: cue.start, correction: `Hold the cue for at least ${o.minDuration}s (into the silence after it) or merge it with a neighbouring cue.` });
    }
    const prev = cues[i - 1];
    if (prev && cue.start < prev.end - 1e-6) {
      add({ code: "subtitle_overlap", severity: "major", message: `${label} overlaps the previous cue.`, evidence: `starts at ${fixed(cue.start)}s while the previous cue runs to ${fixed(prev.end)}s`, atSeconds: cue.start, correction: `End the previous cue by ${fixed(cue.start)}s or start this one at ${fixed(prev.end)}s.` });
    }
    if (videoSeconds !== undefined && (cue.start < -1e-6 || cue.start >= videoSeconds || cue.end > videoSeconds + 0.05)) {
      add({ code: "subtitle_outside_video", severity: "major", message: `${label} falls outside the video.`, evidence: `video is ${fixed(videoSeconds)}s long`, atSeconds: cue.start, correction: `Keep every cue between 0s and ${fixed(videoSeconds)}s: retime or drop it.` });
    }
    let backwards = cue.end < cue.start;
    for (let k = 0; k < cue.words.length; k += 1) {
      const w = cue.words[k]!;
      if (w.end < w.start - 1e-6 || (k > 0 && w.start < cue.words[k - 1]!.start - 1e-6)) backwards = true;
    }
    if (backwards) {
      add({ code: "subtitle_timing_not_monotonic", severity: "major", message: `${label} has word timings that run backwards.`, evidence: cue.words.map((w) => `${w.text}@${fixed(w.start)}`).join(" "), atSeconds: cue.start, correction: "Re-align the words to the audio so each word starts no earlier than the one before." });
    }
  });
  return findings;
}

// ------------------------------------------------------------------ export

function stamp(seconds: number, sep: "," | "."): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

const cueLines = (cue: SubtitleCue) => (cue.lines.length ? cue.lines : cue.text.split("\n")).map((l) => l.trim()).filter(Boolean);

/** SubRip: numbered blocks, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, a blank line between blocks. */
export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue, i) => {
      const body = cueLines(cue).map((l) => l.replace(/<|(?<!-)>/g, "").replace(/-->/g, "->"));
      return `${i + 1}\n${stamp(cue.start, ",")} --> ${stamp(cue.end, ",")}\n${body.join("\n")}\n`;
    })
    .join("\n");
}

/** WebVTT: `WEBVTT` header, `.` millisecond separator, text escaped so it cannot be read as a tag or a timing arrow. */
export function toVtt(cues: SubtitleCue[]): string {
  const blocks = cues.map((cue, i) => {
    const body = cueLines(cue).map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    return `${i + 1}\n${stamp(cue.start, ".")} --> ${stamp(cue.end, ".")}\n${body.join("\n")}\n`;
  });
  return `WEBVTT\n\n${blocks.join("\n")}`;
}

// ------------------------------------------------------------------ audio QA

/** Coverage below this is a finding; below CRITICAL_COVERAGE the line is effectively not what was said. */
export const LOW_COVERAGE = 0.75;
export const CRITICAL_COVERAGE = 0.35;

/**
 * Compare what each scene was MEANT to say (the spoken text) with what the transcript heard inside its
 * window: missing words, added words, a clipped first or last word. Terms whose pronunciation is a
 * guess always get a minor "pronunciation_unverified" finding, because a transcript that matches is
 * not proof of correct pronunciation. With no transcript nothing is verified and the check says so.
 */
export function compareSpokenToExpected(
  speech: SpeechLine[],
  asr: AsrWord[] | null,
  windows: Array<{ number: number; start: number; end: number }>,
): { checks: QaCheckResult[]; findings: QaFinding[]; transcript: string } {
  const checks: QaCheckResult[] = [];
  const findings: QaFinding[] = [];
  const unverified = (line: SpeechLine, source: QaFinding["source"]) => {
    for (const term of line.uncertain) {
      const said = line.segments.find((s) => s.term === term)?.spoken ?? term;
      findings.push({
        code: "pronunciation_unverified",
        severity: "minor",
        category: "speech",
        message: `Scene ${line.sceneNumber}: how "${term}" is pronounced is a guess and has not been confirmed.`,
        evidence: `The voice was asked to say "${said}". A transcript that matches the script is not proof the pronunciation was right.`,
        correction: `Listen to scene ${line.sceneNumber}. If "${term}" is wrong, set an operator pronunciation for it and regenerate the clip.`,
        source,
      });
    }
  };

  if (!asr) {
    checks.push({ name: "speech_transcription", ok: false, detail: "Transcription was unavailable, so the spoken words were not verified against the script.", severity: "minor" });
    for (const line of speech) unverified(line, "rule");
    return { checks, findings, transcript: "" };
  }

  const transcript = asr.map((w) => w.word.trim()).filter(Boolean).join(" ");
  checks.push({ name: "speech_transcription", ok: true, detail: `Transcribed ${asr.length} words.` });
  for (const line of speech) {
    const win = windows.find((w) => w.number === line.sceneNumber);
    const expected = spokenTokens(line.spoken);
    if (!win || !expected.length) {
      if (!win) checks.push({ name: `speech_scene_${line.sceneNumber}`, ok: false, detail: "The scene has no time window in the video, so its speech was not checked.", severity: "minor" });
      unverified(line, "asr");
      continue;
    }
    const heard = heardIn(asr, win.start - 0.3, win.end + 0.3);
    const { matches, extraHeard } = heard.length ? alignTokens(expected, heard) : { matches: new Array<Match>(expected.length).fill(null), extraHeard: [] as Heard[] };
    const matched = matches.filter(Boolean).length;
    const coverage = matched / expected.length;
    const inside = heard.filter((h) => (h.start + h.end) / 2 >= win.start && (h.start + h.end) / 2 <= win.end);
    const extras = extraHeard.filter((h) => (h.start + h.end) / 2 >= win.start && (h.start + h.end) / 2 <= win.end);
    const missing = expected.filter((_, k) => !matches[k]);
    const pct = `${Math.round(coverage * 100)}%`;
    const say = `Scene ${line.sceneNumber}`;
    const heardText = inside.map((h) => h.norm).join(" ") || "nothing";
    let ok = true;

    if (coverage < CRITICAL_COVERAGE) {
      ok = false;
      const different = inside.length >= 3;
      findings.push({
        code: different ? "speech_wrong_sentence" : "speech_line_missing",
        severity: "critical",
        category: "speech",
        message: different ? `${say}: a different sentence was spoken than the script's.` : `${say}: the line was not spoken.`,
        evidence: `Expected "${line.spoken}". Heard: "${heardText}". Only ${pct} of the expected words were found.`,
        atSeconds: win.start,
        correction: `${say}: the voice must say exactly "${line.spoken}" and nothing else. Put the line in quotes in the prompt, keep it to one sentence, and add no other spoken words.`,
        source: "asr",
      });
    } else if (coverage < LOW_COVERAGE) {
      ok = false;
      findings.push({
        code: "speech_words_missing",
        severity: "major",
        category: "speech",
        message: `${say}: words from the script were not spoken.`,
        evidence: `Expected "${line.spoken}". Heard: "${heardText}". Missing: ${missing.slice(0, 8).join(", ")}. Coverage ${pct}.`,
        atSeconds: win.start,
        correction: `${say}: make sure the voice says every word, especially "${missing.slice(0, 4).join(" ")}". Shorten the line if the clip is too short to say it at a natural pace.`,
        source: "asr",
      });
    }
    if (extras.length >= 3 && extras.length >= expected.length * 0.25) {
      ok = false;
      findings.push({
        code: "speech_extra_words",
        severity: extras.length >= expected.length * 0.5 ? "major" : "minor",
        category: "speech",
        message: `${say}: words were spoken that are not in the script.`,
        evidence: `Extra words heard: ${extras.slice(0, 8).map((h) => h.norm).join(" ")}.`,
        atSeconds: win.start,
        correction: `${say}: the voice must say only the quoted line. Add "no other words, no ad-libs" to the prompt.`,
        source: "asr",
      });
    }
    const firstHeard = inside[0];
    const lastHeard = inside[inside.length - 1];
    if (coverage >= CRITICAL_COVERAGE && !matches[0] && firstHeard && firstHeard.start - win.start < 0.15) {
      findings.push({
        code: "speech_clipped_start",
        severity: "minor",
        category: "speech",
        message: `${say}: the first word may be clipped.`,
        evidence: `"${expected[0]}" was not heard and speech begins ${fixed(Math.max(0, firstHeard.start - win.start))}s into the clip.`,
        atSeconds: win.start,
        correction: `${say}: start the line a beat after the clip begins ("a short pause, then speaks").`,
        source: "asr",
      });
    }
    if (coverage >= CRITICAL_COVERAGE && !matches[expected.length - 1] && lastHeard && win.end - lastHeard.end < 0.15) {
      findings.push({
        code: "speech_clipped_end",
        severity: "minor",
        category: "speech",
        message: `${say}: the last word may be clipped.`,
        evidence: `"${expected[expected.length - 1]}" was not heard and speech runs to the end of the clip.`,
        atSeconds: win.end,
        correction: `${say}: shorten the line or lengthen the clip so the last word finishes before the cut.`,
        source: "asr",
      });
    }
    checks.push({ name: `speech_scene_${line.sceneNumber}`, ok, detail: `Coverage ${pct} (${matched}/${expected.length} words), ${extras.length} extra.`, severity: ok ? undefined : coverage < CRITICAL_COVERAGE ? "critical" : "major" });
    unverified(line, "asr");
  }
  return { checks, findings, transcript };
}

// ------------------------------------------------------------------ placement

/**
 * The first candidate caption position whose box clears every band to avoid (faces, the logo, stat or
 * image cards), or null. Everything is a fraction of the frame height: a candidate is the vertical
 * CENTRE of the caption (like Layout.captionY), the box is boxHeightFraction tall, and it must also
 * stay inside the frame.
 */
export function safeCaptionY(candidates: number[], avoid: Array<{ top: number; bottom: number }>, boxHeightFraction: number): number | null {
  const half = boxHeightFraction / 2;
  for (const y of candidates) {
    const top = y - half;
    const bottom = y + half;
    if (top < -1e-9 || bottom > 1 + 1e-9) continue;
    if (!avoid.some((a) => top < a.bottom - 1e-9 && bottom > a.top + 1e-9)) return y;
  }
  return null;
}
