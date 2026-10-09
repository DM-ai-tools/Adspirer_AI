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
