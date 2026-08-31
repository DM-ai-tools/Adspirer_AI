import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseCompetitorWorkbook } from "@/lib/competitors/import-service";

describe("parseCompetitorWorkbook", () => {
  it("reads common competitor columns from an xlsx file", () => {
    const sheet = XLSX.utils.json_to_sheet([
      {
        name: "Acme Dental",
        competitor: "",
        website: "https://acme.example/dentist",
        domain: "",
        notes: "Strong offers",
      },
      {
        name: "Bright Smile",
        competitor: "",
        website: "",
        domain: "brightsmile.com",
        notes: "",
      },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Sheet1");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const rows = parseCompetitorWorkbook(buf);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Acme Dental",
      domain: "acme.example",
    });
    expect(rows[1]).toMatchObject({
      name: "Bright Smile",
      domain: "brightsmile.com",
    });
  });
});

