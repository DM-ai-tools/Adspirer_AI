/**
 * Split a markdown table row into cells. Honours `\|` escapes — models escape
 * pipes inside Meta campaign names ("TR \| Lead Gen \| Sep 2026"), and
 * splitting on every "|" broke cells apart in chat and in PDF/Word exports.
 */
export function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** Escape text for use inside a markdown table cell. */
export function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}
