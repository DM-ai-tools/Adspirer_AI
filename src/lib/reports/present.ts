import type { ReportBlock } from "@/lib/reports/parse-markdown";

/**
 * Presentation pass for printed exports (PDF, Word, HTML).
 *
 * A table whose cells hold sentences (a risk register with Evidence and Fix
 * columns) can't be read once squeezed onto a page: every column wraps to a few
 * words a line. Those tables are turned into cards — a heading per row and one
 * labelled bullet per column. Tables of numbers, dates and short labels stay
 * tables.
 */

type Table = Extract<ReportBlock, { type: "table" }>;

/** A cell that reads as a sentence, not a value. */
const LONG_CELL = 48;
/** A leading cell this short is a tag (severity, #, status) and joins the title. */
const TAG_CELL = 14;

const clean = (cell: string) => cell.replace(/\s+/g, " ").trim();

/** Wide tables with prose in at least two columns, or very long prose in one. */
export function isTextHeavyTable(block: Table): boolean {
  const columns = Math.max(block.headers.length, ...block.rows.map((r) => r.length));
  if (columns < 3 || block.rows.length === 0) return false;
  const longColumns = Array.from({ length: columns }, (_, c) => {
    const cells = block.rows.map((r) => clean(r[c] ?? "")).filter(Boolean);
    if (!cells.length) return false;
    const long = cells.filter((cell) => cell.length > LONG_CELL).length;
    return long / cells.length >= 0.5;
  }).filter(Boolean).length;
  const longest = Math.max(...block.rows.flatMap((r) => r.map((cell) => clean(cell).length)));
  return longColumns >= 2 || (longColumns >= 1 && longest > 140);
}

function tableToCards(block: Table): ReportBlock[] {
  const headers = block.headers.map(clean);
  const out: ReportBlock[] = [];
  for (const raw of block.rows) {
    const cells = headers.map((_, c) => clean(raw[c] ?? ""));
    // Title: leading tag cells (severity, number) plus the first sentence-length cell.
    let titleEnd = 0;
    while (titleEnd < cells.length - 1 && cells[titleEnd]!.length <= TAG_CELL) titleEnd += 1;
    const titleCells = cells.slice(0, titleEnd + 1).filter(Boolean);
    const title = titleCells.join(" · ") || "—";
    out.push({ type: "heading", level: 3, text: title });
    const items = cells
      .map((cell, c) => ({ cell, c }))
      .filter(({ cell, c }) => c > titleEnd && cell && !/^(—|–|-|n\/a)$/i.test(cell))
      .map(({ cell, c }) => [
        { type: "bold" as const, text: `${headers[c] || `Column ${c + 1}`}:` },
        { type: "text" as const, text: ` ${cell}` },
      ]);
    if (items.length) out.push({ type: "list", ordered: false, items });
  }
  return out;
}

export function presentBlocks(blocks: ReportBlock[]): ReportBlock[] {
  return blocks.flatMap((block) => (block.type === "table" && isTextHeavyTable(block) ? tableToCards(block) : [block]));
}
