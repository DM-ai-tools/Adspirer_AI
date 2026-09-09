import { describe, expect, it } from "vitest";
import {
  exportMarkdown,
  exportReportPayload,
  exportWordHtml,
} from "@/lib/reports/export";
import { prepareExportMarkdown } from "@/lib/reports/prepare-export";
import { parseMarkdownToBlocks } from "@/lib/reports/parse-markdown";

const FULL_AUDIT = `Here's your full audit report for TR Internal Marketing — pulled from live Meta evidence.

---

Meta Ads Account Audit — TR Internal Marketing

Account: TR Internal Marketing (act_3946886575540648)

Currency: USD · Timezone: Australia/Sydney

Period: Last 30 days (5 Aug → 3 Sep 2026)

Generated: 3 September 2026

---

1. Account Snapshot

| Metric | Value |
|---|---|
| Total campaigns | 57 |
| Active campaigns | 2 |
| Paused campaigns | 55 |
| Total spend (30 days) | $27.18 |
| Impressions | 303 |
| Clicks | 6 |
| CTR | 1.98% |
| CPC | $4.53 |

---

2. Active Campaigns

🟢 TR AUDIT FINAL (Echelonn) — 120249137049080685

Objective: OUTCOME_LEADS | Format: Video

| Metric | Value |
|---|---|
| Spend (30 days) | $27.18 |
| Impressions | 303 |
| Clicks | 6 |
| CTR | 1.98% |

Key observations:

- Only campaign generating spend in the account
- CTR of 1.98% is above Meta average

---

🟢 TR Meta 1 - 08/17 — 120248865344280685

Objective: OUTCOME_TRAFFIC | Spend: $0.00

Active status but zero spend

---

5. Risks & Issues

| # | Risk | Severity | Detail |
|---|---|---|---|
| 1 | No conversion tracking | Critical | CPL is completely unknown. |
| 2 | Under-funded campaign | Critical | ~$0.92/day effective spend. |

---

7. Prioritised Recommendations

| # | Action | Impact | Effort |
|---|---|---|---|
| 1 | Approve budget increase to $20/day on TR AUDIT FINAL | High | Immediate |
| 2 | Confirm lead tracking | High | Low |

---

*Report compiled from live Meta Graph API evidence.*
`;

describe("faithful audit export", () => {
  it("promotes sections and campaigns to headings", () => {
    const md = prepareExportMarkdown(FULL_AUDIT);
    expect(md).toMatch(/# Meta Ads Account Audit [-—] TR Internal Marketing/);
    expect(md).toContain("## 1. Account Snapshot");
    expect(md).toContain("## 2. Active Campaigns");
    expect(md).toMatch(/### TR AUDIT FINAL \(Echelonn\)/);
    expect(md).toMatch(/### TR Meta 1 - 08\/17/);
    expect(md).toContain("| Active campaigns | 2 |");
    expect(md).toContain("| Paused campaigns | 55 |");
  });

  it("Word HTML keeps snapshot KPIs and both campaigns", () => {
    const html = exportWordHtml("Adspirer report", FULL_AUDIT);
    expect(html).toContain("TR Internal Marketing");
    expect(html).toContain("Active campaigns");
    expect(html).toContain(">2<");
    expect(html).toContain("Paused campaigns");
    expect(html).toContain(">55<");
    expect(html).toContain("$27.18");
    expect(html).toContain("TR AUDIT FINAL");
    expect(html).toContain("TR Meta 1");
    expect(html).toContain("No conversion tracking");
    expect(html).toContain("Approve budget increase");
    expect(html).not.toContain("No campaigns in evidence");
    expect(html).not.toContain("No data");
  });

  it("markdown download keeps the full body", () => {
    const md = exportMarkdown("Adspirer report", FULL_AUDIT);
    expect(md).toContain("Active campaigns | 2");
    expect(md).toContain("Paused campaigns | 55");
    expect(md).toContain("120249137049080685");
    expect(md).toContain("120248865344280685");
    expect(md).toContain("Prioritised Recommendations");
  });

  it("PDF payload is a real PDF with account slug filename", async () => {
    const out = await exportReportPayload({
      format: "pdf",
      title: "Adspirer report",
      content: FULL_AUDIT,
    });
    expect(out.contentType).toBe("application/pdf");
    expect(out.filename.toLowerCase()).toContain("tr-internal");
    const bytes = out.body as Uint8Array;
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1500);
  });

  it("parser treats numbered audit sections as headings", () => {
    const blocks = parseMarkdownToBlocks(prepareExportMarkdown(FULL_AUDIT));
    const headings = blocks
      .filter((b) => b.type === "heading")
      .map((b) => (b.type === "heading" ? b.text : ""));
    expect(headings.some((h) => /Account Snapshot/i.test(h))).toBe(true);
    expect(headings.some((h) => /Active Campaigns/i.test(h))).toBe(true);
    expect(headings.some((h) => /TR AUDIT FINAL/i.test(h))).toBe(true);
  });
});
