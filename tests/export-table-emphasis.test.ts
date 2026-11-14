import { describe, expect, it } from "vitest";
import { ensureMarkdownEmphasisSpacing, parseMarkdownToBlocks } from "@/lib/reports/parse-markdown";
import { prepareExportMarkdown } from "@/lib/reports/prepare-export";

/**
 * A performance table as an audit writes it (14 Nov 2026 PDF): "*" footnote marks in the header
 * ("Reported purchases*"), then an italic "*Read: …*" line under the table. The emphasis tidy-up
 * paired the header's "*" with the Read line's, across lines, and its trim deleted the line breaks:
 * the Read line and the next heading glued onto the row, every value shifted one column left.
 */
const report = [
  "# Meta Ads Account Audit — Shop",
  "",
  "### Campaigns by type",
  "",
  "| Campaign | Type | Spend (AUD) | Reported purchases* | Purchase value* (AUD) | ROAS* | Conversations |",
  "|---|---|---|---|---|---|---|",
  "| TR\\| Sales Prospecting - May 2026 | Prospecting (interest) | 1,412 | 230 | 55,056 | 39.00 | 4 |",
  "",
  "*Read: Prospecting (interest) takes 100.0% of spend.*",
  "",
  "### Offer vs no offer",
  "",
].join("\n");

describe("export keeps a footnoted table intact", () => {
  it("keeps the table, its Read line and the next heading on their own lines", () => {
    const md = prepareExportMarkdown(report, "x");
    expect(md).toContain("| 4 |\n\n*Read: Prospecting (interest) takes 100.0% of spend.*\n\n### Offer vs no offer");
    expect(md).toContain("| Reported purchases* | Purchase value* (AUD) | ROAS* |");
  });

  it("parses the row into exactly the header's columns, in order", () => {
    const table = parseMarkdownToBlocks(prepareExportMarkdown(report, "x")).find((b) => b.type === "table");
    expect(table && table.type === "table" && table.rows[0]).toEqual([
      "TR| Sales Prospecting - May 2026",
      "Prospecting (interest)",
      "1,412",
      "230",
      "55,056",
      "39.00",
      "4",
    ]);
  });

  it("never pairs emphasis across lines, but still tidies it within one", () => {
    expect(ensureMarkdownEmphasisSpacing("a*\n\n*b*")).toBe("a*\n\n*b*");
    expect(ensureMarkdownEmphasisSpacing("see*this*now")).toBe("see *this* now");
  });
});
