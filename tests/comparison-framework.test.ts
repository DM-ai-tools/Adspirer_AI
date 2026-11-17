import { describe, expect, it } from "vitest";
import { COMPARISON_FRAMEWORK, COMPARISON_TITLE } from "@/lib/agent/comparison-framework";
import { SHARED_ANALYSIS_RULES } from "@/lib/analysis/shared-rules";

const HEADINGS = [
  "## 0. Report header and data integrity",
  "## 1. Executive summary",
  "## 2. KPI scorecard",
  "## 3. Driver analysis",
  "## 4. Funnel comparison",
  "## 5. Campaign / ad set / ad contribution",
  "## 6. Creative comparison",
  "## 7. Audience, placement, geo, device and demographic shifts",
  "## 8. Delivery and cost diagnostics",
  "## 9. Changes made during the period",
  "## 10. Tracking and data quality",
  "## 11. External context",
  "## 12. Findings and implications",
  "## 13. Appendix",
];

describe("COMPARISON_FRAMEWORK", () => {
  it("has the 14 headings in order", () => {
    let from = -1;
    for (const h of HEADINGS) {
      const at = COMPARISON_FRAMEWORK.indexOf(h);
      expect(at, h).toBeGreaterThan(from);
      from = at;
    }
  });

  it("has exactly 14 numbered section headings", () => {
    expect(COMPARISON_FRAMEWORK.match(/^## \d+\. /gm)).toHaveLength(14);
  });

  it("starts the title line and includes the shared rules", () => {
    expect(COMPARISON_TITLE).toBe("Meta Ads Comparison Report");
    expect(COMPARISON_FRAMEWORK).toContain("# Meta Ads Comparison Report — <account name>");
    expect(COMPARISON_FRAMEWORK).toContain(SHARED_ANALYSIS_RULES);
  });

  it("carries the comparison rules and labels", () => {
    for (const s of ["CMP-", "MEASUREMENT BREAK", "Low volume - not a trend", "[Hypothesis]", "[Observed]", "[Likely]"]) {
      expect(COMPARISON_FRAMEWORK).toContain(s);
    }
    expect(COMPARISON_FRAMEWORK).toContain("ID | Finding | Evidence | Confidence | Impact | Next-step bucket");
  });

  it("states the bridge identities as the code computes them", () => {
    expect(COMPARISON_FRAMEWORK).toContain("purchase value = purchases × AOV");
    expect(COMPARISON_FRAMEWORK).toContain("cost per result = CPM ÷ (1000 × CTR × CVR)");
    expect(COMPARISON_FRAMEWORK).toContain("results = (spend ÷ CPM × 1000) × CTR × CVR");
    expect(COMPARISON_FRAMEWORK).not.toContain("results × average order value");
    expect(COMPARISON_FRAMEWORK).not.toContain("efficiency");
    expect(COMPARISON_FRAMEWORK).toContain("link clicks ÷ impressions");
  });

  it("is diagnostic only", () => {
    expect(COMPARISON_FRAMEWORK).not.toMatch(/action plan/i);
    expect(COMPARISON_FRAMEWORK).not.toMatch(/we recommend/i);
  });

  it("keeps Meta ids and checkpoint codes out of the report, and explains n/a shares and >100% funnel steps", () => {
    expect(COMPARISON_FRAMEWORK).toContain("Never show Meta ids");
    expect(COMPARISON_FRAMEWORK).toContain("checkpoint codes");
    expect(COMPARISON_FRAMEWORK).toContain("offset by other drivers");
    expect(COMPARISON_FRAMEWORK).toContain("Over 100%");
  });
});
