import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { extractText, getDocumentProxy } from "unpdf";
import {
  fitRowToHeader,
  parseMarkdownToBlocks,
  sanitizeReportText,
} from "@/lib/reports/parse-markdown";
import { chunkWord, columnAlignments, columnWeights, fitTableColumns } from "@/lib/reports/layout";
import { toExcelCell } from "@/lib/reports/xlsx-document";
import {
  buildReportFilename,
  exportDocx,
  exportMarkdown,
  exportPdf,
  exportReportPayload,
  exportWordHtml,
  exportXlsx,
} from "@/lib/reports/export";
import {
  deglueReportProse,
  polishReportForExport,
  splitGluedToken,
  verifyReportQuality,
} from "@/lib/reports/quality";

const SAMPLE = `# Campaign publish report

## Account Overview

| Field | Value |
| --- | --- |
| Account Name | TR Internal Marketing |
| Account ID | act_3946886575540648 |
| Account Health | Healthy |

---

## Campaign Created This Session

### TR AUDIT FINAL (Echelonn)

| Field | Value |
| --- | --- |
| Campaign ID | 120249137049080685 |
| Objective | OUTCOME_LEADS |
| Daily Budget | $5.00 AUD/day |
| Status | **PAUSED** |
| Landing Page | https://googleaudit.trafficradius.com.au/landing-page |

### Targeting Setup

- Locations: Australia (AU)
- Pixel event: LEAD

## Next steps

1. Review the paused campaign in Ads Manager
2. Approve remaining creatives
`;

describe("sanitizeReportText", () => {
  it("strips mojibake and curly quotes", () => {
    expect(sanitizeReportText("Health â€” Healthy")).toContain("Healthy");
    expect(sanitizeReportText("“quoted”")).toBe('"quoted"');
  });

  it("converts unicode spaces instead of deleting them (keeps words readable)", () => {
    const thin = "above\u2009Meta benchmark\u202Ffor lead gen";
    const cleaned = sanitizeReportText(thin);
    expect(cleaned).toContain("above Meta");
    expect(cleaned).toContain("benchmark for");
    expect(cleaned).not.toContain("aboveMeta");
    expect(cleaned).not.toContain("benchmarkfor");
  });

  it("removes leaked undefined tokens and repairs glued placeholders", () => {
    const cleaned = sanitizeReportText(
      "The campaign namedundefined - 08/14 indicates a broken flow",
    );
    expect(cleaned.toLowerCase()).not.toContain("undefined");
    expect(cleaned).toMatch(/campaign named/i);
  });

  it("spaces glued markdown bold markers", () => {
    const cleaned = sanitizeReportText(
      "CTR at 1.98% - above**Meta** benchmark**for** lead gen",
    );
    expect(cleaned).toContain("above **Meta**");
    expect(cleaned).toContain("benchmark **for**");
    const plain = parseMarkdownToBlocks(`- ${cleaned}`)
      .filter((b) => b.type === "list")
      .flatMap((b) => (b.type === "list" ? b.items : []))
      .map((spans) => spans.map((s) => s.text).join(""))
      .join(" ");
    expect(plain).toContain("above Meta");
    expect(plain).toContain("benchmark for");
    expect(plain).not.toMatch(/aboveMeta|benchmarkfor/);
  });

  it("repairs already-stuck lowercase particles from bad source text", () => {
    const cleaned = sanitizeReportText(
      "aboveMeta benchmarkfor lead; roomto scale; nodisapprovals; campaignnamingis disciplined anditeration-dated",
    );
    expect(cleaned).toContain("above Meta");
    expect(cleaned).toContain("benchmark for");
    expect(cleaned).toContain("room to");
    expect(cleaned).toContain("no disapprovals");
    expect(cleaned).toContain("campaign naming is");
    expect(cleaned).toContain("and iteration");
  });
});

describe("parseMarkdownToBlocks", () => {
  it("parses headings, tables, lists", () => {
    const blocks = parseMarkdownToBlocks(SAMPLE);
    expect(blocks.some((b) => b.type === "heading" && b.level === 2)).toBe(
      true,
    );
    expect(blocks.some((b) => b.type === "table")).toBe(true);
    expect(blocks.some((b) => b.type === "list" && !b.ordered)).toBe(true);
    expect(blocks.some((b) => b.type === "list" && b.ordered)).toBe(true);
  });
});

describe("exportWordHtml", () => {
  it("renders branded HTML without raw markdown markers in body tables", () => {
    const html = exportWordHtml("Campaign publish report", SAMPLE);
    expect(html).toContain("CampaignForge");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("TR Internal Marketing");
    expect(html).not.toMatch(/## Account Overview/);
  });

  it("keeps prose words separated and left-aligned for stakeholders", () => {
    const body = `## 4. What's Working

- **CTR** - above**Meta** benchmark\u2009for lead gen
- Note: The campaign namedundefined - 08/14 11:44AM indicates a broken flow
`;
    const html = exportWordHtml("Audit", body);
    expect(html).toContain("text-align: left");
    expect(html).toContain("above");
    expect(html).toContain("Meta");
    expect(html).not.toMatch(/aboveMeta/);
    expect(html).not.toMatch(/benchmarkfor/);
    expect(html).not.toMatch(/\bundefined\b/);
    expect(html).toMatch(/benchmark\s+for|benchmark<\/strong>\s*for|benchmark for/);
  });
});

const UNICODE_SAMPLE = `## Findings

CTR is above Meta benchmark for lead gen → scale budget from ₹500 to ₹750/day – review “weekly”.

| Campaign | Spend | CTR |
| --- | --- | --- |
| TR | Lead Gen | Sep 2026 | $1,234.50 | 2.5% |
| LeadGen Retargeting | $88.00 | 1.1% |
`;

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

describe("exportPdf", () => {
  it("typesets a real PDF with page numbers and readable text", async () => {
    const pdf = await exportPdf("Campaign publish report", SAMPLE);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    const text = await pdfText(pdf);
    // The letter-spaced wordmark extracts as "S P E N D …".
    expect(text.replace(/(?<=\b[A-Z]) (?=[A-Z]\b)/g, "")).toContain("CAMPAIGNFORGE");
    expect(text).toContain("TR Internal Marketing");
    expect(text).toMatch(/Page 1 of \d/);
    expect(text).not.toContain("## ");
  }, 30_000);

  it("keeps unicode symbols, word spacing and campaign names intact", async () => {
    const text = await pdfText(await exportPdf("Audit", UNICODE_SAMPLE));
    expect(text).toContain("benchmark for");
    expect(text).toContain("→");
    expect(text).toContain("₹500");
    expect(text).toContain("LeadGen Retargeting");
    expect(text).toContain("TR | Lead Gen | Sep 2026");
  }, 30_000);
});

describe("exportDocx", () => {
  it("builds a native .docx with tables, header row repeat and page numbers", async () => {
    const bytes = await exportDocx("Campaign publish report", SAMPLE);
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("TR Internal Marketing");
    expect(xml).toContain("<w:tblHeader");
    expect(xml).not.toContain("## ");
    const footer = Object.keys(zip.files).find((f) => /word\/footer\d*\.xml/.test(f));
    expect(footer).toBeTruthy();
    expect(await zip.file(footer!)!.async("string")).toContain("NUMPAGES");
  });
});

describe("exportXlsx", () => {
  it("puts each table on its own sheet with numeric cells", () => {
    const wb = XLSX.read(exportXlsx("Audit", UNICODE_SAMPLE), { type: "array" });
    expect(wb.SheetNames[0]).toBe("Report");
    expect(wb.SheetNames).toContain("Findings");
    const sheet = wb.Sheets.Findings;
    expect(sheet.A2.v).toBe("TR | Lead Gen | Sep 2026");
    expect(sheet.B2).toMatchObject({ t: "n", v: 1234.5 });
    expect(sheet.C2).toMatchObject({ t: "n", v: 0.025 });
  });

  it("converts money/percent and neutralises formula-looking text", () => {
    expect(toExcelCell("-$12.40")).toMatchObject({ t: "n", v: -12.4 });
    expect(toExcelCell("₹1,500")).toMatchObject({ t: "n", v: 1500 });
    expect(toExcelCell("12%")).toMatchObject({ t: "n", v: 0.12 });
    expect(toExcelCell("=HYPERLINK(\"x\")").v).toBe("'=HYPERLINK(\"x\")");
    expect(toExcelCell("act_123").v).toBe("act_123");
    expect(toExcelCell("0412 555 111")).toMatchObject({ t: "s" });
  });
});

describe("exportReportPayload", () => {
  it("returns proper filenames and content types per format", async () => {
    expect(buildReportFilename("Weekly Audit", "docx")).toBe("weekly-audit.docx");
    const xlsx = await exportReportPayload({ format: "xlsx", title: "Audit", content: SAMPLE });
    expect(xlsx.filename.endsWith(".xlsx")).toBe(true);
    expect(xlsx.contentType).toContain("spreadsheetml");
    const docx = await exportReportPayload({ format: "docx", title: "Audit", content: SAMPLE });
    expect(docx.contentType).toContain("wordprocessingml");
  });
});

describe("table layout", () => {
  it("folds '|' inside campaign names back into the first column", () => {
    expect(fitRowToHeader(["TR", "Lead Gen", "Sep", "$5", "1%"], 3)).toEqual([
      "TR | Lead Gen | Sep",
      "$5",
      "1%",
    ]);
    expect(fitRowToHeader(["a", "b"], 3)).toEqual(["a", "b"]);
  });

  it("right-aligns numeric columns and gives text columns more width", () => {
    const rows = [
      ["Prospecting broad — Sydney metro", "$1,234.50", "2.5%"],
      ["Retargeting 30d site visitors", "$88.00", "1.1%"],
    ];
    expect(columnAlignments(rows, 3)).toEqual(["left", "right", "right"]);
    const w = columnWeights(["Campaign", "Spend", "CTR"], rows);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(w[0]).toBeGreaterThan(w[1]);
  });

  // The 12-column ad set table that printed IDs and event names on top of
  // each other: every column must fit its longest word, inside the page.
  const WIDE_HEADERS = ["Ad Set", "ID", "Status", "Learning", "Budget", "Optimises For", "Spend", "Results", "Cost/Result", "CTR", "Freq (7d)", "Live Ads"];
  const WIDE_ROWS = [
    ["Broad - Job title | Google Scale", "120249718007700685", "ACTIVE", "Reset (edit 12 Oct)", "CBO $30/day", "CompleteRegistration", "$0.00", "0", "N/A", "N/A", "1.38", "3 of 3"],
    ["Broad - Job title | Google consult", "120249717677200685", "PAUSED", "N/A", "CBO", "CompleteRegistration", "$0.00", "0", "N/A", "N/A", "N/A", "0 of 0"],
    ["Broad Aud. - Job title | Google Audit", "120249373802720685", "PAUSED", "N/A", "CBO", "CompleteRegistration", "$0.00", "0", "N/A", "N/A", "N/A", "0 of 8"],
  ];
  const longestWord = (cells: string[]) => Math.max(...cells.flatMap((c) => c.split(/\s+/).map((w) => w.length)));

  it("fits a wide table on the page: smaller type, every word inside its column", () => {
    const fit = fitTableColumns(WIDE_HEADERS, WIDE_ROWS, { availableWidth: 498 });
    const total = fit.widths.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(498.01);
    expect(fit.fontSize).toBeLessThan(8.5);
    fit.widths.forEach((width, c) => {
      const words = longestWord([WIDE_HEADERS[c]!, ...WIDE_ROWS.map((r) => r[c]!)]);
      const capacity = fit.maxWordChars[c]!;
      // Either the longest word fits, or the cell is told to break it.
      expect(capacity >= words || fit.breakWords[c]).toBe(true);
      expect(width).toBeGreaterThan(0);
    });
  });

  it("keeps the normal size for a table that already fits", () => {
    const fit = fitTableColumns(["Campaign", "Spend", "CTR"], [["Prospecting broad", "$1,234.50", "2.5%"]], {
      availableWidth: 498,
    });
    expect(fit.fontSize).toBe(8.5);
    expect(fit.breakWords.every((b) => !b)).toBe(true);
    expect(fit.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(498);
  });

  it("breaks a word only when it can't fit at the smallest size", () => {
    const headers = Array.from({ length: 14 }, (_, i) => `Column ${i}`);
    const rows = [headers.map(() => "120249718007700685120249718007700685")];
    const fit = fitTableColumns(headers, rows, { availableWidth: 498 });
    expect(fit.breakWords.some(Boolean)).toBe(true);
    expect(chunkWord("120249718007700685120249718007700685", 10).join("")).toBe(
      "120249718007700685120249718007700685",
    );
    expect(chunkWord("short", 10)).toEqual(["short"]);
  });

  it("renders the wide ad set table into a PDF with all its values", async () => {
    const md = [
      "## Ad Sets in TR | Lead Gen Traffic Radius | Sep 2026",
      "",
      `| ${WIDE_HEADERS.join(" | ")} |`,
      `| ${WIDE_HEADERS.map(() => "---").join(" | ")} |`,
      ...WIDE_ROWS.map((r) => `| ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`),
    ].join("\n");
    // Names wrap inside their cell, so compare with line breaks folded.
    const text = (await pdfText(await exportPdf("Audit", md))).replace(/\s+/g, " ");
    // Whole words: nothing was broken mid-word.
    expect(text).toContain("120249718007700685");
    expect(text).toContain("CompleteRegistration");
    expect(text).toContain("Broad Aud. - Job title | Google Audit");
  }, 30_000);
});

describe("exportMarkdown", () => {
  it("keeps markdown download intact", () => {
    const md = exportMarkdown("Title", SAMPLE);
    expect(md).toContain("# Campaign publish report");
  });
});

describe("report quality gate", () => {
  it("splits common audit glued tokens without breaking real words", () => {
    expect(splitGluedToken("campaignlist")).toBe("campaign list");
    expect(splitGluedToken("campaignor")).toBe("campaign or");
    expect(splitGluedToken("anddelivering")).toBe("and delivering");
    expect(splitGluedToken("Genobjective")).toBe("Gen objective");
    expect(splitGluedToken("backupor")).toBe("backup or");
    expect(splitGluedToken("pagehave")).toBe("page have");
    expect(splitGluedToken("pageso")).toBe("page so");
    expect(splitGluedToken("campaignfatigues")).toBe("campaign fatigues");
    expect(splitGluedToken("information")).toBe("information");
    expect(splitGluedToken("OUTCOME")).toBe("OUTCOME");
  });

  it("polishes a messy audit until quality passes", () => {
    const messy = `## What needs attention

- Budget not visible in the campaignlist - confirm budget at campaignor ad set level
- Only 1 campaignin the account - no backupor split-test if this campaignfatigues
- No retargeting campaignactive - users who've engagedor visited the pagehave no path
- Pixel on confirmation pageso leads are attributed
- Campaignis live anddelivering; Lead Genobjective is alignedwith OUTCOME_LEADS
`;
    const polished = polishReportForExport(messy, "Audit");
    expect(polished.markdown).toContain("campaign list");
    expect(polished.markdown).toContain("campaign or");
    expect(polished.markdown).toContain("and delivering");
    expect(polished.markdown).toContain("Gen objective");
    expect(polished.markdown).not.toMatch(/campaignlist|anddelivering|pageso|backupor/);
    expect(verifyReportQuality(polished.markdown).ok).toBe(true);
  });

  it("deglues prose while preserving URLs", () => {
    const out = deglueReportProse(
      "See campaignlist at https://example.com/campaignlist and pageso",
    );
    expect(out).toContain("https://example.com/campaignlist");
    expect(out).toContain("campaign list");
    expect(out).toContain("page so");
  });
});
