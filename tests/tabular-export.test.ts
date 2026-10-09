import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { neutraliseFormula, toCsv, toXlsx, type TabularColumn } from "@/lib/reports/tabular";

type Row = { who: string; summary: string; spend: number };
const columns: TabularColumn<Row>[] = [
  { header: "Actor", value: (r) => r.who },
  { header: "Summary", value: (r) => r.summary },
  { header: "Spend", value: (r) => r.spend },
];
const rows: Row[] = [
  { who: "ops@agency.com", summary: 'Budget ₹500 → ₹750, "approved"', spend: 750 },
  { who: "=cmd|' /C calc'!A0", summary: "Line one\nline two", spend: -12.5 },
];

describe("toCsv", () => {
  it("adds a BOM, quotes safely and uses CRLF", () => {
    const csv = toCsv(columns, rows);
    expect(csv.startsWith("﻿Actor,Summary,Spend\r\n")).toBe(true);
    expect(csv).toContain('"Budget ₹500 → ₹750, ""approved"""');
    expect(csv).toContain('"Line one\nline two"');
    expect(csv).toContain(",-12.5\r\n");
  });

  it("neutralises formula injection but keeps signed numbers", () => {
    expect(toCsv(columns, rows)).toContain("'=cmd|' /C calc'!A0");
    expect(neutraliseFormula("+61 400 000 000")).toBe("'+61 400 000 000");
    expect(neutraliseFormula("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(neutraliseFormula("-12.5")).toBe("-12.5");
    expect(neutraliseFormula("plain")).toBe("plain");
  });
});

describe("toXlsx", () => {
  it("writes a sheet with numeric cells and safe text", () => {
    const wb = XLSX.read(toXlsx("Audit log", columns, rows), { type: "array" });
    const ws = wb.Sheets["Audit log"];
    expect(ws.A1.v).toBe("Actor");
    expect(ws.C2).toMatchObject({ t: "n", v: 750 });
    expect(String(ws.A3.v).startsWith("'=")).toBe(true);
  });
});
