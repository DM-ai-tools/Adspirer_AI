/**
 * Keeping an uploaded script word for word.
 *
 * A model asked to split a script into scenes will, now and then, "tidy" it: fix a word, drop a
 * clause, smooth a sentence. For an operator's own script that is not acceptable, so the spoken
 * lines are checked against the original text, and any line that has drifted is replaced by the
 * exact words from the original. Pure: no model, no network.
 */

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/** How far past the previous word a match may be found inside a line: a note or label can sit between lines, never inside one. */
const INSIDE_LINE_SKIP = 3;
/** How far a line's first word may be from the end of the previous line. */
const BETWEEN_LINES_SKIP = 80;

export type Span = { start: number; end: number };

/** Align one line's words to the original starting at `from`. Returns the span in the original and how many words matched. */
function alignFrom(original: string[], line: string[], from: number): { span: Span; matched: number } | null {
  let first = -1;
  for (let k = from; k < Math.min(original.length, from + BETWEEN_LINES_SKIP); k += 1) {
    if (original[k] === line[0]) {
      first = k;
      break;
    }
  }
  if (first < 0) return null;
  let ptr = first + 1;
  let matched = 1;
  let end = first;
  for (let t = 1; t < line.length; t += 1) {
    let found = -1;
    for (let k = ptr; k < Math.min(original.length, ptr + INSIDE_LINE_SKIP + 1); k += 1) {
      if (original[k] === line[t]) {
        found = k;
        break;
      }
    }
    if (found >= 0) {
      matched += 1;
      end = found;
      ptr = found + 1;
    }
  }
  return { span: { start: first, end }, matched };
}

export type VerbatimResult = {
  /** True when every line is exactly the original's words, in order. */
  ok: boolean;
  /** For each line, where its words sit in the original (or null when they could not be found). */
  spans: Array<Span | null>;
  /** Lines whose words are not all in the original, in order. */
  altered: number[];
};

/** Check each line against the original text, in order. */
export function verbatimCheck(original: string, lines: string[]): VerbatimResult {
  const orig = words(original).map(norm);
  const spans: Array<Span | null> = [];
  const altered: number[] = [];
  let ptr = 0;
  lines.forEach((line, index) => {
    const toks = words(line).map(norm).filter(Boolean);
    if (!toks.length) {
      spans.push(null);
      return;
    }
    const aligned = alignFrom(orig, toks, ptr);
    // Exact when every word was found, and the span is as long as the line (no word swallowed or added).
    const exact = aligned && aligned.matched === toks.length && aligned.span.end - aligned.span.start + 1 === toks.length;
    if (aligned && exact) {
      spans.push(aligned.span);
      ptr = aligned.span.end + 1;
    } else {
      spans.push(aligned ? aligned.span : null);
      altered.push(index);
      if (aligned) ptr = aligned.span.end + 1;
    }
  });
  return { ok: altered.length === 0, spans, altered };
}

/**
 * Put the original's exact words back into the lines that drifted. Each altered line is aligned to
 * its best place in the original (after the previous line) and replaced by those words, with their
 * original spelling and punctuation.
 */
export function restoreVerbatim(original: string, lines: string[]): { lines: string[]; restored: number[]; spans: Array<Span | null> } {
  const rawWords = words(original);
  const orig = rawWords.map(norm);
  const out = [...lines];
  const restored: number[] = [];
  const spans: Array<Span | null> = [];
  let ptr = 0;
  lines.forEach((line, index) => {
    const toks = words(line).map(norm).filter(Boolean);
    if (!toks.length) {
      spans.push(null);
      return;
    }
    const exact = (() => {
      const a = alignFrom(orig, toks, ptr);
      return a && a.matched === toks.length && a.span.end - a.span.start + 1 === toks.length ? a : null;
    })();
    if (exact) {
      spans.push(exact.span);
      ptr = exact.span.end + 1;
      return;
    }
    // Find the best start: the place after the previous line where most of this line's words line up.
    let best: { span: Span; matched: number } | null = null;
    for (let s = ptr; s < Math.min(orig.length, ptr + BETWEEN_LINES_SKIP); s += 1) {
      for (const lead of [0, 1, 2]) {
        const first = toks[lead];
        if (first === undefined || orig[s] !== first) continue;
        const a = alignFrom(orig, toks.slice(lead), s);
        if (a && (!best || a.matched > best.matched)) best = a;
      }
    }
    if (best && best.matched >= Math.max(2, Math.ceil(toks.length * 0.5))) {
      out[index] = rawWords.slice(best.span.start, best.span.end + 1).join(" ");
      restored.push(index);
      spans.push(best.span);
      ptr = best.span.end + 1;
    } else {
      spans.push(null);
    }
  });
  return { lines: out, restored, spans };
}

/** Stretches of the original that no line used (directions, notes, labels), so the operator can see what was treated that way. */
export function unusedText(original: string, spans: Array<Span | null>, minWords = 4): string[] {
  const raw = words(original);
  const used = new Array<boolean>(raw.length).fill(false);
  for (const s of spans) if (s) for (let i = s.start; i <= s.end; i += 1) used[i] = true;
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length >= minWords) blocks.push(current.join(" "));
    current = [];
  };
  raw.forEach((w, i) => {
    if (used[i]) flush();
    else current.push(w);
  });
  flush();
  return blocks;
}

/** The words of a text, normalised, for comparing two versions. */
export function normalisedWords(text: string): string[] {
  return words(text).map(norm).filter(Boolean);
}
