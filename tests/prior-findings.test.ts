import { describe, expect, it } from "vitest";
import { priorFindings } from "@/lib/analysis/prior-findings";
import { COMPARISON_FRAMEWORK } from "@/lib/agent/comparison-framework";
import { META_AUDIT_FRAMEWORK } from "@/lib/agent/meta-audit-framework";
import type { AgentHistoryMessage } from "@/lib/agent/history";

const audit = (period: string, extra = "") =>
  `# Meta Ads Account Audit — Bethel\n\n**Period:** ${period} · **Scope:** ${extra || "Entire ad account"}\n\n## 7. Risks & Issues\n2 Critical · 1 High\n\n` +
  `### AUD-001 · 🔴 Critical — Pixel not firing on checkout\n- **Evidence:** [Observed] 0 purchases from 412 clicks, $1,200 spend.\n- **Fix:** repair the pixel.\n- **Spend at stake:** $1,200\n\n` +
  `### AUD-002 · 🟠 High — Frequency 4.1 on prospecting\n- **Evidence:** [Likely] link CTR 0.5% with frequency 4.1: creative fatigue.\n- **Fix:** new creative.\n\n## 8. Recommended Meta Structure\nx`;

const comparison = (current: string, scope = "") =>
  `# Meta Ads Comparison Report — Bethel\n\n## 0. Report header and data integrity\n- **Windows**: current and previous\n- Current: ${current} (15 days)\n- Previous: 2026-09-16 to 2026-09-30 (15 days)\n${scope}\n\n## 1. Executive summary\nx\n\n` +
  `## 12. Findings and implications\n| ID | Finding | Evidence | Confidence | Impact | Next-step bucket |\n| --- | --- | --- | --- | --- | --- |\n` +
  `| CMP-001 | CPM up 22% | CPM $12 vs $9.8 | High | Cost per result +$6 | Investigate |\n| CMP-002 | CTR down | link CTR 1.1% vs 1.6% | Medium | Results -8% | Creative |\n\n**CMP-001 CPM up**\n\n## 13. Appendix\nx`;

const a = (content: string): AgentHistoryMessage => ({ role: "assistant", content });
const period = { dateStart: "2026-10-05", dateStop: "2026-10-20" };

describe("priorFindings", () => {
  it("returns AUD findings of an overlapping audit and names it in used", () => {
    const r = priorFindings([a(audit("2026-10-01 → 2026-10-15"))], period, {});
    expect(r.findings.map((f) => f.id)).toEqual(["AUD-001", "AUD-002"]);
    expect(r.findings[0]).toEqual({
      id: "AUD-001",
      title: "Pixel not firing on checkout",
      evidence: "[Observed] 0 purchases from 412 clicks, $1,200 spend.",
      source: "audit",
    });
    expect(r.used).toEqual(["audit of 2026-10-01 → 2026-10-15 used"]);
    expect(r.ignored).toEqual([]);
  });

  it("ignores an audit for a non-overlapping period", () => {
    const r = priorFindings([a(audit("2026-09-01 → 2026-09-15"))], period, {});
    expect(r.findings).toEqual([]);
    expect(r.ignored).toEqual(["audit of 2026-09-01 → 2026-09-15 not used: different period"]);
  });

  it("reads natural-date audit periods", () => {
    const r = priorFindings([a(audit("1 Oct 2026 – 15 Oct 2026 (15 days)"))], period, {});
    expect(r.findings).toHaveLength(2);
  });

  it("returns both audit and comparison findings", () => {
    const r = priorFindings([a(audit("2026-10-01 → 2026-10-15")), a(comparison("2026-10-01 to 2026-10-15"))], period, {});
    expect(r.findings.map((f) => f.id)).toEqual(["AUD-001", "AUD-002", "CMP-001", "CMP-002"]);
    expect(r.findings[2]).toEqual({ id: "CMP-001", title: "CPM up 22%", evidence: "CPM $12 vs $9.8", source: "comparison" });
    expect(r.used).toHaveLength(2);
    expect(r.used[1]).toBe("comparison of 2026-10-01 → 2026-10-15 used");
  });

  it("uses only the latest report of each kind", () => {
    const r = priorFindings(
      [a(audit("2026-09-01 → 2026-09-15")), a(audit("2026-10-01 → 2026-10-15")), { role: "user", content: "ok" }],
      period,
      {},
    );
    expect(r.used).toEqual(["audit of 2026-10-01 → 2026-10-15 used"]);
  });

  it("ignores a campaign-scoped audit for a whole-account strategy", () => {
    const scoped = audit("2026-10-01 → 2026-10-15", "Selected campaigns — Spring Sale");
    const whole = priorFindings([a(scoped)], period, {});
    expect(whole.findings).toEqual([]);
    expect(whole.ignored[0]).toMatch(/not used: .*specific campaigns/);
    const sub = priorFindings([a(scoped)], period, { campaignIds: ["123"] });
    expect(sub.findings).toHaveLength(2);
  });

  it("ignores a campaign-scoped comparison for a whole-account strategy", () => {
    const scoped = comparison("2026-10-01 to 2026-10-15", "- **Scope**: selected campaigns only; section 7 covers the whole account, not only the selected campaigns.");
    expect(priorFindings([a(scoped)], period, {}).findings).toEqual([]);
    expect(priorFindings([a(scoped)], period, { campaignIds: ["1"] }).findings).toHaveLength(2);
  });

  it("ignores a report with no readable period", () => {
    const r = priorFindings([a("# Meta Ads Account Audit — X\n\n### AUD-001 · 🔴 Critical — t\n- **Evidence:** [Observed] e")], period, {});
    expect(r.ignored).toEqual(["audit not used: period not stated"]);
  });

  it("ignores an old audit with R# numbering", () => {
    const old = "# Meta Ads Account Audit — X\n\n**Period:** 2026-10-01 → 2026-10-15\n\n### R1 · 🔴 Critical — Old\n- **Evidence:** e";
    const r = priorFindings([a(old)], period, {});
    expect(r.findings).toEqual([]);
    expect(r.ignored).toEqual(["audit of 2026-10-01 → 2026-10-15 not used: uses the old R# numbering"]);
  });

  it("never throws on malformed text and skips unparseable cards", () => {
    const bad = "# Meta Ads Account Audit — X\n\n**Period:** 2026-10-01 → 2026-10-15\n\n### AUD-00x · nope\n### AUD-003 · 🟡 Medium\n- no title\n### AUD-004 · 🟡 Medium — Thin creative testing\n- no evidence line\n";
    const r = priorFindings([a(bad), a("# Meta Ads Comparison Report — X\n\n## 0. x\n- Current: ???")], period, {});
    expect(r.findings.map((f) => f.id)).toEqual(["AUD-004"]);
    expect(r.findings[0].evidence).toBeNull();
    expect(priorFindings([], period, {})).toEqual({ findings: [], used: [], ignored: [] });
  });
});

const cmpWith = (section0: string) =>
  `# Meta Ads Comparison Report — Bethel\n\n## 0. Report header and data integrity\n${section0}\n\n## 12. Findings and implications\n| ID | Finding | Evidence | Confidence | Impact | Next-step bucket |\n| --- | --- | --- | --- | --- | --- |\n| CMP-001 | CPM up 22% | CPM $12 vs $9.8 | High | x | Investigate |\n\n## 13. Appendix\nx`;

describe("priorFindings: the lines the frameworks ask for", () => {
  it("reads a Windows line written without a colon after current", () => {
    const r = priorFindings([a(cmpWith("- **Windows**: current 2026-10-01 to 2026-10-15 (15 days); previous 2026-09-16 to 2026-09-30 (15 days)"))], period, {});
    expect(r.used).toEqual(["comparison of 2026-10-01 → 2026-10-15 used"]);
  });

  it("reads natural dates after current", () => {
    const r = priorFindings([a(cmpWith("- **Windows**: current 1 Oct 2026 to 15 Oct 2026 (15 days); previous 16 Sep 2026 to 30 Sep 2026"))], period, {});
    expect(r.findings).toHaveLength(1);
  });

  it("reads the exact Current / Previous / Scope lines", () => {
    const body = "- **Current:** 2026-10-01 → 2026-10-15 (15 days)\n- **Previous:** 2026-09-16 → 2026-09-30 (15 days)\n- **Scope:** whole account";
    const r = priorFindings([a(cmpWith(body))], period, {});
    expect(r.used).toEqual(["comparison of 2026-10-01 → 2026-10-15 used"]);
  });

  it("falls back to the first ISO range in section 0", () => {
    const r = priorFindings([a(cmpWith("- Window 2026-10-01 → 2026-10-15 against the month before"))], period, {});
    expect(r.findings).toHaveLength(1);
  });

  it("ignores a comparison for a different period", () => {
    const body = "- **Current:** 2026-08-01 → 2026-08-15 (15 days)\n- **Previous:** 2026-07-16 → 2026-07-31 (15 days)";
    expect(priorFindings([a(cmpWith(body))], period, {}).ignored).toEqual(["comparison of 2026-08-01 → 2026-08-15 not used: different period"]);
  });

  it("ignores a comparison with no readable period", () => {
    expect(priorFindings([a(cmpWith("- **Windows**: both windows are in the data"))], period, {}).ignored).toEqual(["comparison not used: period not stated"]);
  });

  it("reads '**Scope:** campaigns: <names>' as campaign-scoped, even when a name contains 'all'", () => {
    const body = "- **Current:** 2026-10-01 → 2026-10-15 (15 days)\n- **Scope:** campaigns: All Products Sale";
    expect(priorFindings([a(cmpWith(body))], period, {}).findings).toEqual([]);
    const audit1 = `# Meta Ads Account Audit — X\n\n**Period:** 2026-10-01 → 2026-10-15 · **Scope:** campaigns: All Products Sale\n\n### AUD-001 · 🔴 Critical — t\n- **Evidence:** [Observed] e`;
    expect(priorFindings([a(audit1)], period, {}).findings).toEqual([]);
    expect(priorFindings([a(audit1)], period, { campaignIds: ["9"] }).findings).toHaveLength(1);
  });

  it("treats an audit with '**Scope:** whole account' as whole-account", () => {
    const au = `# Meta Ads Account Audit — X\n\n**Period:** 2026-10-01 → 2026-10-15 · **Scope:** whole account\n\n### AUD-001 · 🔴 Critical — t\n- **Evidence:** [Observed] e`;
    expect(priorFindings([a(au)], period, {}).findings).toHaveLength(1);
  });

  it("with no Scope line, an audit is whole-account unless it says 'campaign audit'", () => {
    const body = "**Period:** 2026-10-01 → 2026-10-15\n\n### AUD-001 · 🔴 Critical — t\n- **Evidence:** [Observed] e";
    expect(priorFindings([a(`# Meta Ads Account Audit — X\n\n${body}`)], period, {}).findings).toHaveLength(1);
    expect(priorFindings([a(`# Meta Ads Account Audit — X (campaign audit: Spring)\n\n${body}`)], period, {}).findings).toEqual([]);
  });
});

describe("frameworks ask for the lines the parser reads", () => {
  it("comparison framework requires exact Current, Previous and Scope lines", () => {
    expect(COMPARISON_FRAMEWORK).toContain("- **Current:** YYYY-MM-DD → YYYY-MM-DD (N days)");
    expect(COMPARISON_FRAMEWORK).toContain("- **Previous:** YYYY-MM-DD → YYYY-MM-DD (N days)");
    expect(COMPARISON_FRAMEWORK).toContain("- **Scope:** whole account");
    expect(COMPARISON_FRAMEWORK).toContain("- **Scope:** campaigns: <names>");
  });

  it("audit framework opens the snapshot with Period and Scope", () => {
    expect(META_AUDIT_FRAMEWORK).toContain("**Period:** <dates> · **Scope:** whole account");
    expect(META_AUDIT_FRAMEWORK).toContain("**Period:** <dates> · **Scope:** campaigns: <names>");
  });
});
