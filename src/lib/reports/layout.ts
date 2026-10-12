/**
 * Shared layout decisions for exported tables (PDF, Word, Excel), so every
 * format sizes columns and aligns numbers the same way.
 */

const EMPTY_CELL = /^(|—|–|-|n\/a|na|none|unknown)$/i;

/** "$1,234.50", "₹500", "12.5%", "3.2x", "1.4×", "-4", "1.2k" … */
const NUMERIC_CELL =
  /^[+-]?\s?[$€£¥₹]?\s?[+-]?\d[\d,]*(\.\d+)?\s?(%|x|×|k|m|bn)?(\s?\/\s?(day|mo|month|wk|week))?$/i;

export function isNumericCell(value: string): boolean {
  return NUMERIC_CELL.test(value.trim());
}

/**
 * Right-align a column when most of its filled cells are numbers — money and
 * percentages line up on the decimal side the way finance readers expect.
 */
export function columnAlignments(rows: string[][], columns: number): Array<"left" | "right"> {
  return Array.from({ length: columns }, (_, c) => {
    let filled = 0;
    let numeric = 0;
    for (const row of rows) {
      const cell = (row[c] ?? "").trim();
      if (EMPTY_CELL.test(cell)) continue;
      filled += 1;
      if (isNumericCell(cell)) numeric += 1;
    }
    return filled > 0 && numeric / filled >= 0.6 && c > 0 ? "right" : "left";
  });
}

/**
 * Relative column widths (fractions summing to 1) from content length: wide
 * text columns get room, short numeric columns stay compact. Uses a high
 * percentile instead of the max so one long cell doesn't starve the others.
 */
export function columnWeights(
  headers: string[],
  rows: string[][],
  options: { min?: number; max?: number } = {},
): number[] {
  const columns = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const min = options.min ?? 4;
  const max = options.max ?? 42;
  const align = columnAlignments(rows, columns);
  const raw = Array.from({ length: columns }, (_, c) => {
    const lengths = rows
      .map((row) => (row[c] ?? "").trim().length)
      .sort((a, b) => a - b);
    // Numbers must never wrap ("$120.0 / 0"), so numeric columns fit their
    // longest value; text columns use a percentile and wrap the outliers.
    const p85 = !lengths.length
      ? 0
      : align[c] === "right"
        ? lengths[lengths.length - 1]
        : lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.85))];
    // Headers may wrap, but never mid-word: reserve room for the longest word.
    const headerText = (headers[c] ?? "").trim();
    const longestWord = Math.max(0, ...headerText.split(/\s+/).map((w) => w.length));
    const header = Math.max(longestWord + 1, Math.ceil(headerText.length * 0.55));
    // Cells wrap between words, never inside one ("Pause / d").
    const longestCellWord = Math.max(
      0,
      ...rows.flatMap((row) => (row[c] ?? "").split(/\s+/).map((w) => w.length)),
    );
    // Breathing room for cell padding; numeric columns get more because
    // digits are wider than average text and must stay on one line.
    return (
      Math.min(max, Math.max(min, p85, header, longestCellWord)) +
      (align[c] === "right" ? 3.5 : 3)
    );
  });
  const total = raw.reduce((sum, w) => sum + w, 0);
  return raw.map((w) => w / total);
}

/** Type sizes tried, largest first, until the table's words fit the page. */
const DENSITIES = [
  { fontSize: 8.5, paddingX: 6 },
  { fontSize: 7.5, paddingX: 4 },
  { fontSize: 6.8, paddingX: 3 },
  { fontSize: 6.2, paddingX: 2.5 },
] as const;

/** Widest average glyph we plan for, in em — Inter digits and capitals run ~0.6. */
const CHAR_EM = 0.62;
/** Semi-bold header text is a little wider. */
const HEADER_CHAR_EM = 0.66;
/** Cell border. */
const BORDER = 0.5;

export type TableFit = {
  fontSize: number;
  paddingX: number;
  /** Column widths in points, summing to the available width. */
  widths: number[];
  /** Characters that fit on one line of each column. */
  maxWordChars: number[];
  /** Columns whose longest word still doesn't fit and must break mid-word. */
  breakWords: boolean[];
};

const longestWordIn = (cells: string[]) =>
  Math.max(0, ...cells.flatMap((cell) => cell.trim().split(/\s+/).map((w) => w.length)));

/**
 * Absolute column widths for a fixed-width page. react-pdf wraps only at
 * spaces, so a word wider than its column (an 18-digit ID, an event name)
 * prints over the next cell. Pick the largest type size at which every
 * column holds its longest word, then share the spare width the way
 * `columnWeights` would. Only when nothing fits do columns break words.
 */
export function fitTableColumns(
  headers: string[],
  rows: string[][],
  options: { availableWidth: number },
): TableFit {
  const columns = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const available = options.availableWidth;
  const preferred = columnWeights(headers, rows).map((w) => w * available);
  const cellWords = Array.from({ length: columns }, (_, c) => longestWordIn(rows.map((r) => r[c] ?? "")));
  const headerWords = Array.from({ length: columns }, (_, c) => longestWordIn([headers[c] ?? ""]));

  const needFor = (fontSize: number, paddingX: number) =>
    Array.from(
      { length: columns },
      (_, c) =>
        Math.max(cellWords[c]! * CHAR_EM, headerWords[c]! * HEADER_CHAR_EM) * fontSize + paddingX * 2 + BORDER,
    );

  const density = DENSITIES.find((d) => needFor(d.fontSize, d.paddingX).reduce((a, b) => a + b, 0) <= available);
  const { fontSize, paddingX } = density ?? DENSITIES[DENSITIES.length - 1]!;
  const need = needFor(fontSize, paddingX);
  const needTotal = need.reduce((a, b) => a + b, 0);

  let widths: number[];
  if (needTotal <= available) {
    // Every column gets its minimum; the spare goes to columns that want more.
    const spare = available - needTotal;
    const wants = need.map((n, c) => Math.max(0, preferred[c]! - n));
    const wantTotal = wants.reduce((a, b) => a + b, 0);
    widths = need.map((n, c) => n + spare * (wantTotal > 0 ? wants[c]! / wantTotal : n / needTotal));
  } else {
    widths = need.map((n) => (n / needTotal) * available);
  }

  const maxWordChars = widths.map((w) => Math.max(1, Math.floor((w - paddingX * 2 - BORDER) / (CHAR_EM * fontSize))));
  return {
    fontSize,
    paddingX,
    widths,
    maxWordChars,
    breakWords: maxWordChars.map((chars, c) => Math.max(cellWords[c]!, headerWords[c]!) > chars),
  };
}

/** Split a word into pieces no longer than `size` (for hyphenation callbacks). */
export function chunkWord(word: string, size: number): string[] {
  if (word.length <= size || size < 1) return [word];
  return word.match(new RegExp(`.{1,${Math.floor(size)}}`, "gu")) ?? [word];
}

/** Normalise every row to the same number of cells. */
export function padRows(headers: string[], rows: string[][]): {
  headers: string[];
  rows: string[][];
  columns: number;
} {
  const columns = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const pad = (cells: string[]) =>
    Array.from({ length: columns }, (_, i) => (cells[i] ?? "").trim());
  return { headers: pad(headers), rows: rows.map(pad), columns };
}
