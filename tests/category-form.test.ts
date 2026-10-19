import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { categoryPatchFromEdit, importOutcome, marginPctFromNumber } from "@/lib/clients/category-form";
import { parseCategorySheet } from "@/lib/clients/category-import";

describe("categoryPatchFromEdit", () => {
  it("parses a margin percent", () => {
    expect(categoryPatchFromEdit("gross_margin_pct", "55")).toEqual({ ok: true, patch: { gross_margin_pct: 55 } });
    expect(categoryPatchFromEdit("gross_margin_pct", "35%")).toEqual({ ok: true, patch: { gross_margin_pct: 35 } });
  });
  it("reads a margin of 1 or less as a fraction, the same rule the import uses", () => {
    expect(categoryPatchFromEdit("gross_margin_pct", "0.35")).toEqual({ ok: true, patch: { gross_margin_pct: 35 } });
    expect(categoryPatchFromEdit("gross_margin_pct", "0.5%")).toEqual({ ok: true, patch: { gross_margin_pct: 0.5 } });
    expect(marginPctFromNumber(0.35, false)).toBe(35);
    expect(marginPctFromNumber(35, false)).toBe(35);
    expect(marginPctFromNumber(0.35, true)).toBe(0.35);
    const sheet = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(sheet, XLSX.utils.aoa_to_sheet([["Category", "Margin"], ["A", 0.35], ["B", "0.35"]]), "S");
    const bytes = XLSX.write(sheet, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    expect(parseCategorySheet(bytes, "c.xlsx").rows.map((r) => r.gross_margin_pct)).toEqual([35, 35]);
  });
  it("rejects a margin outside 0-100", () => {
    const r = categoryPatchFromEdit("gross_margin_pct", "140");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/0.100/);
  });
  it("turns a blank margin into null", () => {
    expect(categoryPatchFromEdit("gross_margin_pct", "")).toEqual({ ok: true, patch: { gross_margin_pct: null } });
  });
  it("converts AOV to integer cents", () => {
    expect(categoryPatchFromEdit("average_order_value", "189.50")).toEqual({ ok: true, patch: { average_order_value_cents: 18950 } });
    expect(categoryPatchFromEdit("average_order_value", "$1,200")).toEqual({ ok: true, patch: { average_order_value_cents: 120000 } });
    expect(categoryPatchFromEdit("average_order_value", " ")).toEqual({ ok: true, patch: { average_order_value_cents: null } });
    expect(categoryPatchFromEdit("average_order_value", "abc").ok).toBe(false);
    expect(categoryPatchFromEdit("average_order_value", "-5").ok).toBe(false);
  });
  it("validates landing page urls", () => {
    expect(categoryPatchFromEdit("landing_page_url", "not a url").ok).toBe(false);
    expect(categoryPatchFromEdit("landing_page_url", "ftp://x.com").ok).toBe(false);
    expect(categoryPatchFromEdit("landing_page_url", "https://x.com/a")).toEqual({ ok: true, patch: { landing_page_url: "https://x.com/a" } });
    expect(categoryPatchFromEdit("landing_page_url", "")).toEqual({ ok: true, patch: { landing_page_url: null } });
  });
  it("requires a name", () => {
    expect(categoryPatchFromEdit("name", "  ").ok).toBe(false);
    expect(categoryPatchFromEdit("name", " Sofas ")).toEqual({ ok: true, patch: { name: "Sofas" } });
  });
  it("accepts integer priority >= 0 only", () => {
    expect(categoryPatchFromEdit("priority", "3")).toEqual({ ok: true, patch: { priority: 3 } });
    expect(categoryPatchFromEdit("priority", "-1").ok).toBe(false);
    expect(categoryPatchFromEdit("priority", "1.5").ok).toBe(false);
    expect(categoryPatchFromEdit("priority", "").ok).toBe(false);
  });
});

describe("importOutcome", () => {
  it("summarises a good reply", () => {
    expect(importOutcome(true, { ok: true, data: { created: 2, updated: 1, errors: [{}] } })).toEqual({
      ok: true,
      created: 2,
      updated: 1,
      errors: 1,
    });
  });
  it("turns an HTML or error body into a message", () => {
    expect(importOutcome(false, null)).toEqual({ ok: false, error: "Import failed" });
    expect(importOutcome(false, { ok: false, error: { message: "Too big" } })).toEqual({ ok: false, error: "Too big" });
    expect(importOutcome(true, { ok: false })).toEqual({ ok: false, error: "Import failed" });
  });
});
