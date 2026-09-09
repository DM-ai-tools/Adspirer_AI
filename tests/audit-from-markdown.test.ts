import { describe, expect, it } from "vitest";
import {
  auditReportFromMarkdown,
  isThinHeuristicReport,
  looksLikeFullAuditMarkdown,
} from "@/lib/report/from-markdown";
import { resolveExportAuditReport } from "@/lib/reports/export";
import { parseAuditReport } from "@/lib/report/schema";

const SAMPLE_AUDIT = `Here's your full audit report for TR Internal Marketing — pulled from live Meta evidence and this session's analysis.

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
| Reach | 234 |
| Frequency | 1.29 |
| CPL | Unknown — no conversion tracking data |

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
| CPC | $4.53 |
| Reach | 234 |
| Frequency | 1.29 |
| CPL | Unknown |

Live ads:

Video Ad 1 — 120249137051760685 🟢 Active
Video Ad 2 — 120249141479650685 🟢 Active
Key observations:

Only campaign generating spend in the account
Effective daily spend ~$0.92/day — severely under-funded for a lead gen objective
CTR of 1.98% is above Meta average (~0.9–1.2%) — creative is resonating
Frequency at 1.29 — healthy, no fatigue risk yet

---

🟢 TR Meta 1 - 08/17 — 120248865344280685

Objective: OUTCOME_TRAFFIC | Spend: $0.00

Active status but zero spend, zero impressions, zero clicks in the last 30 days
Likely cause: budget not set, ad not approved, or audience too narrow to serve
Risk: A dead active campaign wastes auction participation — needs investigation or pause

---

5. Risks & Issues

| # | Risk | Severity | Detail |
|---|---|---|---|
| 1 | No conversion tracking | Critical | CPL is completely unknown. |
| 2 | Under-funded campaign | Critical | ~$0.92/day effective spend is far too low. |
| 3 | TR Meta 1 spending $0 | High | Active campaign with zero delivery. |
| 4 | No retargeting layer | Medium | Only 234 unique people reached. |
| 5 | Creative fatigue risk | Medium | Replacement creative should be prepared. |
| 6 | Single campaign concentration | Medium | 100% of spend is on one campaign. |
| 7 | 55 paused campaigns | Low | Consider archiving older campaigns. |
| 8 | Broken campaign name | Low | undefined campaign indicates failed creation. |

---

7. Prioritised Recommendations

| # | Action | Impact | Effort |
|---|---|---|---|
| 1 | Approve budget increase to $20/day on TR AUDIT FINAL | High | Immediate |
| 2 | Confirm lead tracking | High | Low |
| 3 | Investigate TR Meta 1 | High | Low |
| 4 | Pull per-ad breakdown | Medium | Low |
| 5 | Prepare creative refresh | Medium | Medium |
| 6 | Add retargeting ad set | Medium | Medium |
| 7 | Archive old PS-series campaigns | Low | Low |
| 8 | Clean up broken campaign | Low | Low |

---

*Report compiled from live Meta Graph API evidence via Facebook OAuth — TR Internal Marketing (act_3946886575540648).*
`;

describe("audit markdown → structured report", () => {
  it("detects a full audit body", () => {
    expect(looksLikeFullAuditMarkdown(SAMPLE_AUDIT)).toBe(true);
  });

  it("extracts spend, campaigns, risks, and recommendations", () => {
    const report = auditReportFromMarkdown(SAMPLE_AUDIT);
    expect(report).toBeTruthy();
    expect(report!.meta.accountName).toBe("TR Internal Marketing");
    expect(report!.meta.accountId).toBe("act_3946886575540648");
    expect(report!.meta.currency).toBe("USD");
    expect(report!.meta.period).toMatch(/Last 30 days/i);
    expect(report!.meta.period).not.toMatch(/\*\*/);
    expect(report!.kpis.find((k) => k.label === "Active")?.value).toBe("2");
    expect(report!.kpis.find((k) => k.label === "Paused")?.value).toBe("55");
    expect(report!.kpis.some((k) => k.value.includes("27.18"))).toBe(true);
    expect(report!.campaigns.length).toBeGreaterThanOrEqual(2);
    expect(report!.campaigns[0].name).toMatch(/TR AUDIT FINAL/i);
    expect(report!.campaigns[0].metrics?.length ?? 0).toBeGreaterThan(3);
    expect(report!.risks.length).toBeGreaterThanOrEqual(6);
    expect(report!.recommendations.length).toBeGreaterThanOrEqual(6);
    expect(report!.bottomLine).not.toMatch(/\*\*/);
  });

  it("prefers chat markdown over thin heuristic reportData on export", () => {
    const thin = parseAuditReport({
      meta: {
        reportType: "Meta Ads Account Audit",
        subtitle: "x",
        accountName: "TR Internal Marketing",
        accountId: "act_3946886575540648",
        platform: "meta",
        period: "Session window",
        generatedAt: "2026-09-03T00:00:00.000Z",
        currency: "USD",
        timezone: "Australia/Sydney",
      },
      healthScore: null,
      healthLabel: "Needs attention",
      bottomLine:
        "Structured OpenAI generation was unavailable, so this is a heuristic draft from live evidence.",
      kpis: [
        { label: "Total campaigns", value: "57", flag: false },
        { label: "Active", value: "2", flag: false },
        { label: "Paused", value: "55", flag: false },
        { label: "Period spend", value: "No data", flag: true },
      ],
      snapshot: [{ label: "Account", value: "TR Internal Marketing" }],
      dataNotes: ["heuristic provisional"],
      campaigns: [],
      risks: [
        {
          title: "Incomplete spend visibility",
          severity: "medium",
          detail: "x",
        },
      ],
      recommendations: [
        {
          title: "Re-run dated audit",
          detail: "x",
          impact: "high",
          tags: [],
        },
      ],
      methodology: "heuristic",
    });

    expect(isThinHeuristicReport(thin)).toBe(true);

    const resolved = resolveExportAuditReport({
      title: "Meta Ads Account Audit",
      content: SAMPLE_AUDIT,
      report: thin,
    });
    expect(resolved?.meta.period).toMatch(/Last 30 days/i);
    expect(resolved?.kpis.some((k) => /27\.18/.test(k.value))).toBe(true);
    expect((resolved?.risks.length ?? 0) >= 6).toBe(true);
  });
});
