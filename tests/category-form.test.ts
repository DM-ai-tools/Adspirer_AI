import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  categoryPatchFromEdit,
  importOutcome,
  marginPctFromNumber,
  filterScanCandidates,
  scanUnavailableMessage,
} from "@/lib/clients/category-form";
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

describe("scanUnavailableMessage", () => {
  it("tells the operator to add the website when the client has none", () => {
    expect(scanUnavailableMessage("no_website", "categories")).toBe(
      "Add the client's website in Settings, then scan again. Or add categories by hand or import a sheet.",
    );
  });

  it("only blames the crawler when the crawler really isn't configured", () => {
    expect(scanUnavailableMessage("not_configured", "services")).toBe(
      "Website scan isn't set up (FIRECRAWL_API_KEY is missing). Add services by hand or import a sheet.",
    );
  });

  it("says the scan failed when the crawl errored", () => {
    expect(scanUnavailableMessage("scan_failed", "categories")).toBe(
      "The website scan didn't work this time. Try again in a minute, or add categories by hand or import a sheet.",
    );
  });

  it("falls back to a neutral line for an unknown reason", () => {
    expect(scanUnavailableMessage(undefined, "categories")).toBe(
      "Website scan is unavailable. Add categories by hand or import a sheet.",
    );
  });
});

describe("filterScanCandidates", () => {
  const c = (name: string, alreadyAdded = false) => ({ name, landing_page_url: null, alreadyAdded });
  const all = [c("Adjustable Bar Stools"), c("Bar Stools", true), c("Counter Stools"), c("3 Seater Outdoor Sofa"), c("Sofa Beds")];

  it("matches every typed word, in any order, ignoring case", () => {
    expect(filterScanCandidates(all, "stools bar").shown.map((x) => x.name)).toEqual(["Adjustable Bar Stools", "Bar Stools"]);
    expect(filterScanCandidates(all, "SOFA").shown.map((x) => x.name)).toEqual(["3 Seater Outdoor Sofa", "Sofa Beds"]);
  });

  it("shows everything for an empty search", () => {
    expect(filterScanCandidates(all, "  ").shown).toHaveLength(5);
    expect(filterScanCandidates(all, "").matched).toBe(5);
  });

  it("renders at most the limit but reports how many matched", () => {
    const many = Array.from({ length: 450 }, (_, i) => c(`Cat ${i}`));
    const out = filterScanCandidates(many, "cat", 300);
    expect(out.shown).toHaveLength(300);
    expect(out.matched).toBe(450);
  });

  it("lists the names 'select all shown' would add, skipping ones already added", () => {
    expect(filterScanCandidates(all, "stools").selectable).toEqual(["Adjustable Bar Stools", "Counter Stools"]);
  });
});
