import { describe, expect, it } from "vitest";
import { parseMarkdownToBlocks, sanitizeReportText } from "@/lib/reports/parse-markdown";
import {
  exportMarkdown,
  exportSimplePdf,
  exportWordHtml,
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
    expect(html).toContain("Adspirer AI");
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

describe("exportSimplePdf", () => {
  it("produces a multipage-capable PDF without 60-line truncation", () => {
    const pdf = exportSimplePdf("Campaign publish report", SAMPLE);
    const text = new TextDecoder().decode(pdf);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("Helvetica-Bold");
    expect(text).toContain("ADSPIRER AI");
    expect(text).toContain("TR Internal Marketing");
    // Should not dump raw markdown hashes as the only formatting
    expect(Buffer.byteLength(pdf)).toBeGreaterThan(800);
  });
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
