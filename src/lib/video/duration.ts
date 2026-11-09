/**
 * How much a script can say in the length that was asked for, and an honest estimate of how long
 * a script takes to say.
 *
 * The old rule was a flat words-per-second. Real narration is shorter than that: the opening
 * needs a beat, an argument needs pauses to land, a demonstration is silent, and the closing
 * call to action takes its own time. So the budget reserves those first and only the rest is
 * narration. When a script runs long the answer is to edit it, never to speed up the narrator:
 * the pace is clamped to a believable human range on purpose.
 *
 * Pure and deterministic, so the editor, the server and the tests agree. The existing scene
 * timing in timing.ts is unchanged; this module is for the whole script.
 */
import type { ScriptSpeech } from "./script-types";

/** A relaxed, clear ad read. Slower than a conversation, faster than a documentary. */
export const DEFAULT_WORDS_PER_SECOND = 2.5;
const MIN_WPS = 1.8;
const MAX_WPS = 3.2;

/** The end card is not part of the requested length; the closing line is. */
const CTA_TAIL_PAUSE = 0.3;
/** One silent beat (a shot that holds, a demonstration step). */
const SILENT_BEAT_SECONDS = 2.5;
/** Used when the caller does not know how long the closing line is. */
const DEFAULT_CTA_WORDS = 6;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Clamp to a believable spoken range (1.8-3.2) and read the VIDEO_WORDS_PER_SECOND env override when no value is given. */
export function resolveWordsPerSecond(input?: number | null): number {
  let value = typeof input === "number" && Number.isFinite(input) && input > 0 ? input : null;
  if (value === null && typeof process !== "undefined" && process.env) {
    const fromEnv = Number(process.env.VIDEO_WORDS_PER_SECOND);
    if (Number.isFinite(fromEnv) && fromEnv > 0) value = fromEnv;
  }
  return clamp(value ?? DEFAULT_WORDS_PER_SECOND, MIN_WPS, MAX_WPS);
}

export type SpeechBudget = {
  totalSeconds: number;
  wordsPerSecond: number;
  reservedSeconds: number;
  speechSeconds: number;
  min: number;
  target: number;
  max: number;
  notes: string[];
};

/**
 * Words available for narration (before the closing line) in a requested length.
 *
 * Reserved: an opening beat, pauses for the argument to land (proportionally less in a short ad,
 * which should carry one idea), silent visual beats or demonstration time, and the closing CTA.
 */
export function speechBudget(input: { seconds: number; wordsPerSecond?: number | null; ctaWords?: number; visualBeats?: number; demonstration?: boolean }): SpeechBudget {
  const wps = resolveWordsPerSecond(input.wordsPerSecond);
  const total = Math.max(5, Number.isFinite(input.seconds) ? input.seconds : 30);
  const short = total <= 20;
  const ctaWords = Math.max(0, Math.round(input.ctaWords ?? DEFAULT_CTA_WORDS));
  const beats = Math.max(0, Math.round(input.visualBeats ?? 0));

  const openingBeat = short ? 0.4 : 0.8;
  const pauses = total * (short ? 0.06 : 0.1);
  const ctaSeconds = ctaWords > 0 ? ctaWords / wps + CTA_TAIL_PAUSE : 0;
  const silent = beats * SILENT_BEAT_SECONDS + (input.demonstration ? total * 0.1 : 0);

  const reserved = round1(Math.min(openingBeat + pauses + ctaSeconds + silent, total * 0.6));
  const speechSeconds = round1(total - reserved);
  const target = Math.max(8, Math.round(speechSeconds * wps));
  const min = Math.max(6, Math.round(target * 0.85));
  const max = Math.max(min + 1, Math.round(target * 1.05));

  const notes: string[] = [];
  const shown = Math.round(total);
  notes.push(`A ${shown}s ad: about ${Math.round(reserved)}s reserved for pauses and the CTA, so about ${target} words of narration${ctaWords > 0 ? " before the closing line" : ""}.`);
  if (ctaWords > 0) notes.push(`The closing line (${ctaWords} words) comes out of the budget; the end card is not part of the requested length.`);
  if (short) notes.push(`Short ad (${shown}s): carry one idea, with room for the opening to land.`);
  else notes.push("Longer ad: leave pauses for the argument to land between the points.");
  if (beats > 0) notes.push(`${beats} silent ${beats === 1 ? "beat" : "beats"} (about ${round1(beats * SILENT_BEAT_SECONDS)}s) held back from narration.`);
  if (input.demonstration) notes.push("A demonstration is silent, so about a tenth of the length is held back for it.");

  return { totalSeconds: total, wordsPerSecond: wps, reservedSeconds: reserved, speechSeconds, min, target, max, notes };
}

// ------------------------------------------------------------------ estimating speech

const SENTENCE_PAUSE = 0.35;
const SOFT_PAUSE = 0.15;
const LINE_BREAK_PAUSE = 0.2;

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 1;
  const groups = w.match(/[aeiouy]+/g)?.length ?? 1;
  const silentE = /[^aeiouy]e$/.test(w) && !/le$/.test(w) ? 1 : 0;
  return Math.max(1, groups - silentE);
}

/** How many words a three digit group takes to say ("five hundred twenty" is 3). */
function groupWords(group: string): number {
  const v = parseInt(group, 10);
  if (!v) return 0;
  const small = (n: number) => (n === 0 ? 0 : n <= 20 || n % 10 === 0 ? 1 : 2);
  return v >= 100 ? 1 + small(v % 100) : small(v);
}

/** Spoken length of a whole number written in digits: "1,500" is "one thousand five hundred" (4). */
function integerWords(digits: string, yearLike: boolean): number {
  const clean = digits.replace(/^0+(?=\d)/, "");
  if (yearLike && /^(19|20)\d\d$/.test(clean)) return 2;
  const groups: string[] = [];
  for (let end = clean.length; end > 0; end -= 3) groups.unshift(clean.slice(Math.max(0, end - 3), end));
  let words = 0;
  groups.forEach((g, i) => {
    const w = groupWords(g);
    words += w;
    if (w > 0 && i < groups.length - 1) words += 1; // thousand, million, billion
  });
  return Math.max(1, words);
}

/**
 * Weight of one hyphen-free part of a token, in "spoken words": numerals, currencies, percentages,
 * magnitudes and acronyms take longer to say than they take to read. One small expansion rule, no
 * table of acronyms.
 */
function spokenWeight(part: string): number {
  const core = part.replace(/^[("'“‘]+|[)"'”’.,;:!?]+$/g, "");
  if (!core) return 0;
  const num = core.match(/^([$€£]?)(\d[\d,]*)(\.\d+)?(%|[kKmMbB]|x|X)?(\+)?$/);
  if (num) {
    const [, currency, whole, decimals, suffix, plus] = num;
    let words = integerWords(whole.replace(/,/g, ""), !currency && !suffix && !whole.includes(","));
    if (decimals) words += 1 + (decimals.length - 1);
    if (currency) words += 1;
    if (suffix) words += 1;
    if (plus) words += 1;
    return words;
  }
  if (/^[A-Z]{2,4}$/.test(core)) return core.length; // spelled out: C R M
  if (/^[A-Z]{2,4}s$/.test(core)) return core.length; // plural acronym: "CRMs" is C R M s
  const letters = core.replace(/[^\p{L}]/gu, "");
  if (!letters) return /\d/.test(core) ? 1 : 0;
  return 1 + Math.max(0, syllables(letters) - 3) * 0.2;
}

export function estimateSpeech(text: string, opts?: { wordsPerSecond?: number | null }): { words: number; seconds: number; pauseSeconds: number } {
  const wps = resolveWordsPerSecond(opts?.wordsPerSecond);
  const trimmed = text.trim();
  if (!trimmed) return { words: 0, seconds: 0, pauseSeconds: 0 };

  let words = 0;
  let spoken = 0;
  for (const token of trimmed.split(/\s+/)) {
    if (!/[\p{L}\p{N}]/u.test(token)) continue;
    words += 1;
    // "30-minute" and "24/7" are two spoken words; a dash between spaces is only a pause.
    const parts = token.split(/(?<=[\p{L}\p{N}])[-–—/](?=[\p{L}\p{N}])/u);
    for (const p of parts) spoken += spokenWeight(p);
  }

  // The last sentence does not need a pause after it.
  const body = trimmed.replace(/[.!?…]+["'”’)]*$/u, "");
  const sentenceEnds = (body.match(/[.!?…]+["'”’)]*(?=\s|$)/gu) ?? []).length;
  const soft = (body.match(/,(?!\d)|;|:(?!\d)|\s[-–—]+\s|[–—]/g) ?? []).length;
  const breaks = (body.match(/\n+/g) ?? []).length;
  const pauseSeconds = sentenceEnds * SENTENCE_PAUSE + soft * SOFT_PAUSE + breaks * LINE_BREAK_PAUSE;

  return { words, seconds: round2(spoken / wps + pauseSeconds), pauseSeconds: round2(pauseSeconds) };
}

// ------------------------------------------------------------------ does it fit

const FIT_UNDER = 0.88;
const FIT_OVER = 1.05;

export function speechFit(estimatedSeconds: number, requestedSeconds: number): { fit: "fits" | "long" | "short"; deltaSeconds: number; message: string } {
  const delta = round1(estimatedSeconds - requestedSeconds);
  const gap = Math.max(1, Math.round(Math.abs(delta)));
  if (estimatedSeconds > requestedSeconds * FIT_OVER) {
    return { fit: "long", deltaSeconds: delta, message: `About ${gap}s over: edit the script, do not speed up the narrator.` };
  }
  if (estimatedSeconds < requestedSeconds * FIT_UNDER) {
    return { fit: "short", deltaSeconds: delta, message: `About ${gap}s short: add something the viewer needs, or let a line breathe, do not slow the narrator down.` };
  }
  const close = Math.abs(delta) < 0.5 ? "right on" : delta > 0 ? `about ${gap}s over, within tolerance` : `about ${gap}s under, within tolerance`;
  return { fit: "fits", deltaSeconds: delta, message: `Fits the requested ${Math.round(requestedSeconds)}s (${close}).` };
}

/**
 * Everything the script carries about its own length. `lines` are every spoken line including the
 * closing line, so the word budget here is the narration budget plus `extra.ctaWords`. Silent beats
 * count toward the estimate because the viewer waits through them.
 */
export function buildScriptSpeech(
  lines: string[],
  requestedSeconds: number,
  wordsPerSecond?: number | null,
  extra?: { ctaWords?: number; visualBeats?: number; demonstration?: boolean },
): ScriptSpeech {
  const wps = resolveWordsPerSecond(wordsPerSecond);
  const spoken = lines.map((l) => l.trim()).filter(Boolean);
  const est = estimateSpeech(spoken.join("\n"), { wordsPerSecond: wps });
  const budget = speechBudget({ seconds: requestedSeconds, wordsPerSecond: wps, ctaWords: extra?.ctaWords, visualBeats: extra?.visualBeats, demonstration: extra?.demonstration });
  const cta = Math.max(0, Math.round(extra?.ctaWords ?? DEFAULT_CTA_WORDS));
  const silent = Math.max(0, Math.round(extra?.visualBeats ?? 0)) * SILENT_BEAT_SECONDS + (extra?.demonstration ? budget.totalSeconds * 0.1 : 0);
  const estimatedSeconds = round1(est.seconds + silent);
  return {
    words: est.words,
    estimatedSeconds,
    wordsPerSecond: wps,
    requestedSeconds,
    budgetWords: { min: budget.min + cta, target: budget.target + cta, max: budget.max + cta },
    fit: speechFit(estimatedSeconds, requestedSeconds).fit,
    measuredSeconds: null,
  };
}
