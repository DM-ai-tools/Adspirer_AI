import * as XLSX from "xlsx";

/**
 * Data-table downloads (audit log and other lists) as CSV or Excel.
 *
 * CSV: UTF-8 BOM so Excel shows "₹", "→" and names correctly instead of
 * mojibake, CRLF line endings, and formula-injection protection — a summary
 * like "=HYPERLINK(...)" must not execute when an admin opens the file.
 */

export type TabularFormat = "csv" | "xlsx";

export type TabularColumn<T> = {
  header: string;
  value: (row: T) => string | number | Date | null | undefined;
  /** Excel column width in characters. */
  width?: number;
};

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function neutraliseFormula(value: string): string {
  // Plain signed numbers ("-12.5") are safe; everything else that starts with
  // a formula trigger gets a leading apostrophe.
  if (FORMULA_PREFIX.test(value) && !/^[-+]?\d[\d,]*(\.\d+)?%?$/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function csvCell(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "number"
        ? String(value)
        : neutraliseFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T>(columns: TabularColumn<T>[], rows: T[]): string {
  const lines = [
    columns.map((c) => csvCell(c.header)).join(","),
    ...rows.map((row) => columns.map((c) => csvCell(c.value(row))).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function toXlsx<T>(
  sheetName: string,
  columns: TabularColumn<T>[],
  rows: T[],
): Uint8Array {
  const data = [
    columns.map((c) => c.header),
    ...rows.map((row) =>
      columns.map((c) => {
        const v = c.value(row);
        if (v === null || v === undefined) return "";
        return typeof v === "string" ? neutraliseFormula(v) : v;
      }),
    ),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data, { cellDates: true, dateNF: "yyyy-mm-dd hh:mm" });
  ws["!cols"] = columns.map((c, i) => ({
    wch:
      c.width ??
      Math.min(60, Math.max(10, ...data.slice(0, 200).map((r) => String(r[i] ?? "").length + 2))),
  }));
  if (ws["!ref"]) ws["!autofilter"] = { ref: ws["!ref"] };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer;
  return new Uint8Array(out);
}

export const TABULAR_CONTENT_TYPES: Record<TabularFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
