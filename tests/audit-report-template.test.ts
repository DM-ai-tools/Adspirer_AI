import { describe, expect, it } from "vitest";
import { parseAuditReport } from "@/lib/report/schema";
import { renderAuditReportMarkdown } from "@/lib/report/md/AuditReportMd";
import { renderAuditReportDocxHtml } from "@/lib/report/docx/AuditReportDocx";
import { renderAuditReportPdf } from "@/lib/report/pdf/render";
import { exportReportPayload } from "@/lib/reports/export";

const sample = parseAuditReport({
  meta: {
    reportType: "Meta Ads Account Audit",
    subtitle: "Operator review of live delivery, risk and next actions",
    accountName: "TR Internal Marketing",
    accountId: "act_3946886575540648",
    platform: "meta",
    period: "Last 30 days",
    generatedAt: "2026-09-03T10:00:00.000Z",
    currency: "AUD",
    timezone: "Australia/Sydney",
  },
  healthScore: 72,
  healthLabel: "Needs attention",
  bottomLine:
    "Account is delivering with thin spend visibility. Biggest exposure is missing period CPA. First action: confirm pixel events then re-check TR AUDIT FINAL.",
  kpis: [
    { label: "Active campaigns", value: "2", note: "of 57 total", flag: false },
    { label: "Paused", value: "55", flag: false },
    { label: "Period spend", value: "No data", flag: true },
    { label: "Health", value: "72", note: "/100", flag: false },
  ],
  snapshot: [
    { label: "Account", value: "TR Internal Marketing" },
    { label: "Account ID", value: "act_3946886575540648", mono: true },
    { label: "Currency", value: "AUD" },
    { label: "Timezone", value: "Australia/Sydney" },
  ],
  dataNotes: ["Insights API returned no itemised spend for the selected window."],
  campaigns: [
    {
      name: "TR AUDIT FINAL",
      id: "120249137049080685",
      status: "ACTIVE",
      objective: "Outcome · Leads",
      spendSharePct: null,
      deliverySignals: [
        { lead: "Campaign active", body: "Status ACTIVE in live inventory." },
      ],
      risks: [
        {
          lead: "No spend figure",
          body: "Cannot judge efficiency without period insights.",
          severity: "medium",
        },
      ],
      checkedAgainst: ["Inventory", "Objective"],
    },
  ],
  risks: [
    {
      title: "Missing spend data",
      severity: "medium",
      detail: "Period spend could not be itemised from the API response.",
    },
  ],
  recommendations: [
    {
      title: "Pull dated insights",
      detail: "Re-run audit with an explicit last-30-days window and confirm pixel firing.",
      impact: "high",
      effort: "5 min",
      tags: ["measurement"],
    },
  ],
  methodology:
    "Structured report generated from workspace Meta diagnose evidence and operator chat.",
});

describe("structured audit report template", () => {
  it("emits markdown with required sections", () => {
    const md = renderAuditReportMarkdown(sample);
    expect(md).toContain("# Meta Ads Account Audit — TR Internal Marketing");
    expect(md).toContain("**Bottom line.**");
    expect(md).toContain("## Risk register");
    expect(md).toContain("## Prioritised recommendations");
  });

  it("emits branded Word HTML without markdown hashes as headings", () => {
    const html = renderAuditReportDocxHtml(sample);
    expect(html).toContain("ADSPIRER AI");
    expect(html).toContain("Bottom line");
    expect(html).toContain("TR AUDIT FINAL");
    expect(html).not.toMatch(/## Account snapshot/);
  });

  it("renders a React-PDF binary with Inter metadata", async () => {
    const pdfBytes = await renderAuditReportPdf(sample);
    const text = new TextDecoder().decode(pdfBytes);
    expect(text.startsWith("%PDF")).toBe(true);
    expect(Buffer.byteLength(pdfBytes)).toBeGreaterThan(2000);
  }, 30_000);

  it("export payload downloads full chat content (not structured template)", async () => {
    const auditBody = `Here's your full audit.

Meta Ads Account Audit — TR Internal Marketing

Account: TR Internal Marketing (act_3946886575540648)
Currency: USD · Timezone: Australia/Sydney
Period: Last 30 days (5 Aug → 3 Sep 2026)

1. Account Snapshot

| Metric | Value |
|---|---|
| Total campaigns | 57 |
| Active campaigns | 2 |
| Paused campaigns | 55 |
| Total spend (30 days) | $27.18 |

2. Active Campaigns

TR AUDIT FINAL (Echelonn) — 120249137049080685

Objective: OUTCOME_LEADS

| Metric | Value |
|---|---|
| Spend (30 days) | $27.18 |
| CTR | 1.98% |

5. Risks & Issues

| # | Risk | Severity | Detail |
|---|---|---|---|
| 1 | No conversion tracking | Critical | CPL unknown |

7. Prioritised Recommendations

| # | Action | Impact | Effort |
|---|---|---|---|
| 1 | Approve budget increase | High | Immediate |
`;

    const out = await exportReportPayload({
      format: "docx",
      title: "Adspirer report",
      content: auditBody,
      report: sample,
    });
    expect(out.contentType).toContain("msword");
    expect(out.filename.toLowerCase()).toContain("tr-internal-marketing");
    const html = String(out.body);
    expect(html).toContain("Active campaigns");
    expect(html).toContain(">2<");
    expect(html).toContain("Paused campaigns");
    expect(html).toContain(">55<");
    expect(html).toContain("$27.18");
    expect(html).toContain("TR AUDIT FINAL");
    expect(html).toContain("No conversion tracking");
    expect(html).toContain("Approve budget increase");
    // Must not be the empty structured stub path
    expect(html).not.toContain("No campaigns in evidence");
  }, 30_000);
});
