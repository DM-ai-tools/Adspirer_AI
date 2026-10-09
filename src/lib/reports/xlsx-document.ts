import * as XLSX from "xlsx";
import type { InlineSpan, ReportBlock } from "@/lib/reports/parse-markdown";
import { parseMarkdownToBlocks, sanitizeReportText } from "@/lib/reports/parse-markdown";
import { padRows } from "@/lib/reports/layout";

/**
 * Excel export of a report: a "Report" sheet with the readable text, and one
 * sheet per table with real numbers (money, percentages) so they can be
 * summed, sorted and charted instead of being text that looks like numbers.
 */

const CURRENCY_FORMAT: Record<string, string> = {
  $: '"$"#,##0.00',
  "₹": '"₹"#,##0.00',
  "€": '"€"#,##0.00',
  "£": '"£"#,##0.00',
  "¥": '"¥"#,##0',
};

/** "$1,234.50" → number + currency format; "12.5%" → 0.125 + percent format. */
export function toExcelCell(raw: string): XLSX.CellObject {
  const value = raw.trim();
  const money = value.match(/^([+-]?)\s?([$₹€£¥])\s?([+-]?)([\d,]+(?:\.\d+)?)$/);
  if (money) {
    const sign = money[1] === "-" || money[3] === "-" ? -1 : 1;
    return {
      t: "n",
      v: sign * Number(money[4].replace(/,/g, "")),
      z: CURRENCY_FORMAT[money[2]] ?? "#,##0.00",
    };
  }
  const percent = value.match(/^([+-]?[\d,]*\.?\d+)\s?%$/);
  if (percent) {
    const n = Number(percent[1].replace(/,/g, "")) / 100;
    return { t: "n", v: n, z: Number.isInteger(n * 100) ? "0%" : "0.00%" };
  }
  if (/^[+-]?\d[\d,]*(\.\d+)?$/.test(value) && !/^0\d/.test(value)) {
    const n = Number(value.replace(/,/g, ""));
    return { t: "n", v: n, z: value.includes(".") ? "#,##0.00" : "#,##0" };
  }
  // Text: neutralise formula-looking values ("=…", "+…", "@…") — Excel
  // would otherwise evaluate them when the file is opened.
  const safe = /^[=+@\-]/.test(value) && !/^[-+]?\d/.test(value) ? `'${value}` : value;
  return { t: "s", v: safe };
}

function plain(spans: InlineSpan[]): string {
  return spans.map((s) => s.text).join("");
}

function sheetName(base: string, used: Set<string>): string {
  // Excel: max 31 chars, no []:*?/\ characters, unique.
  const clean = base.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim() || "Table";
  let name = clean.slice(0, 31);
  for (let i = 2; used.has(name.toLowerCase()); i += 1) {
    const suffix = ` (${i})`;
    name = `${clean.slice(0, 31 - suffix.length)}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

function tableSheet(block: Extract<ReportBlock, { type: "table" }>): XLSX.WorkSheet {
  const { headers, rows, columns } = padRows(block.headers, block.rows);
  const ws: XLSX.WorkSheet = {};
  headers.forEach((h, c) => {
    ws[XLSX.utils.encode_cell({ r: 0, c })] = { t: "s", v: h };
  });
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (!value) return;
      ws[XLSX.utils.encode_cell({ r: r + 1, c })] = toExcelCell(value);
    });
  });
  const lastRow = rows.length;
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: columns - 1 } });
  ws["!autofilter"] = { ref: ws["!ref"] };
  ws["!cols"] = headers.map((h, c) => ({
    wch: Math.min(60, Math.max(10, h.length + 2, ...rows.map((row) => (row[c] ?? "").length + 2))),
  }));
  return ws;
}

export function renderReportXlsx(input: {
  title: string;
  markdown: string;
  generatedAt?: Date;
}): Uint8Array {
  const title = sanitizeReportText(input.title);
  let blocks = parseMarkdownToBlocks(input.markdown);
  const first = blocks[0];
  if (first?.type === "heading" && first.level === 1 && first.text.toLowerCase() === title.toLowerCase()) {
    blocks = blocks.slice(1);
  }
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();

  // "Report" sheet — the narrative in reading order.
  const lines: string[][] = [
    [title],
    [`Generated ${(input.generatedAt ?? new Date()).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })} · Spendsmith`],
    [],
  ];
  let lastHeading = "";
  const tables: Array<{ name: string; block: Extract<ReportBlock, { type: "table" }> }> = [];
  for (const block of blocks) {
    if (block.type === "heading") {
      lastHeading = block.text;
      lines.push([], [block.text.toUpperCase()]);
    } else if (block.type === "paragraph") {
      lines.push([plain(block.spans)]);
    } else if (block.type === "list") {
      block.items.forEach((item, i) =>
        lines.push([`${block.ordered ? `${i + 1}.` : "•"} ${plain(item)}`]),
      );
    } else if (block.type === "table") {
      const name = sheetName(lastHeading.replace(/^\d+\.\s*/, "") || `Table ${tables.length + 1}`, used);
      tables.push({ name, block });
      lines.push([`→ See sheet "${name}" (${block.rows.length} rows)`]);
    }
  }
  const report = XLSX.utils.aoa_to_sheet(lines);
  report["!cols"] = [{ wch: 110 }];
  used.add("report");
  XLSX.utils.book_append_sheet(wb, report, "Report");
  for (const { name, block } of tables) {
    XLSX.utils.book_append_sheet(wb, tableSheet(block), name);
  }

  const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
  return new Uint8Array(out);
}
