import { afterEach, describe, expect, it } from "vitest";
import { gatherDiagnoseEvidence } from "@/lib/agent/adspirer-agent";
import { loadConversationHistory, loadLatestReports, truncatePastReply, type AgentHistoryMessage } from "@/lib/agent/history";
import { priorFindings } from "@/lib/analysis/prior-findings";
import { evaluateCheckpoints } from "@/lib/audit/checkpoints";
import { demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { resolveGoals } from "@/lib/clients/goals";
import { getDemoStore, resetDemoStore } from "@/lib/demo/store";
import { NO_PRIOR_REPORT_NOTICE, renderStrategyInputsEvidence } from "@/lib/strategy/strategy-inputs";
import type { Message } from "@/types";

const period = { dateStart: "2026-10-01", dateStop: "2026-10-15" };

/** A full audit: the AUD cards sit in section 7, well past the 6,000-character history cut. */
const longAudit = [
  "# Meta Ads Account Audit — Bethel",
  "",
  "**Period:** 2026-10-01 → 2026-10-15 · **Scope:** whole account",
  "",
  "## 1. Account Snapshot",
  ...Array.from({ length: 120 }, (_, i) => `- Line ${i + 1}: spend, results and cost per result for campaign ${i + 1} were read from Meta.`),
  "",
  "## 7. Risks & Issues",
  "### AUD-001 · 🔴 Critical — Pixel not firing on checkout",
  "- **Evidence:** [Observed] 0 purchases from 412 clicks.",
  "",
  "### AUD-002 · 🟠 High — Frequency 4.1 on prospecting",
  "- **Evidence:** [Likely] link CTR 0.5% with frequency 4.1.",
  "",
  "## 8. Recommended Meta Structure",
  "x",
].join("\n");

const longComparison = [
  "# Meta Ads Comparison Report — Bethel",
  "",
  "## 0. Report header and data integrity",
  "- **Current:** 2026-10-01 → 2026-10-15 (15 days)",
  "- **Previous:** 2026-09-16 → 2026-09-30 (15 days)",
  "- **Scope:** whole account",
  "",
  ...Array.from({ length: 120 }, (_, i) => `- Note ${i + 1}: a long stretch of report text that pushes the findings table far down.`),
  "",
  "## 12. Findings and implications",
  "| ID | Finding | Evidence | Confidence | Impact | Next-step bucket |",
  "| --- | --- | --- | --- | --- | --- |",
  "| **CMP-001** | CPM rose 22% | CPM $12 vs $9.8 | High | Cost per result +$6 | Audience |",
  "",
  "## 13. Appendix",
  "x",
].join("\n");

const goals = resolveGoals({ goals_profile: {} });
const snapshot = demoMetaAuditSnapshot("act_1", "Demo", 30);
const scorecard = evaluateCheckpoints(snapshot, { goals });

describe("the truncated history loses the findings", () => {
  it("cuts a long audit before its AUD cards", () => {
    expect(longAudit.length).toBeGreaterThan(6_000);
    const cut = truncatePastReply(longAudit, 6_000);
    expect(cut).not.toContain("AUD-001");
    const r = priorFindings([{ role: "assistant", content: cut }], period, {});
    expect(r.findings).toEqual([]);
  });

  it("a report that qualifies but has no readable IDs is ignored, never used", () => {
    const cut = truncatePastReply(longAudit, 6_000);
    const r = priorFindings([{ role: "assistant", content: cut }], period, {});
    expect(r.used).toEqual([]);
    expect(r.ignored).toEqual(["audit of 2026-10-01 → 2026-10-15 not used: no finding IDs could be read"]);
    const out = renderStrategyInputsEvidence({ snapshot, goals, scorecard, request: "strategy", history: [{ role: "assistant", content: cut }], period });
    expect(out).not.toContain("audit of 2026-10-01 → 2026-10-15 used");
    expect(out).toContain(NO_PRIOR_REPORT_NOTICE);
  });

  it("reads a bolded ID cell in the comparison table", () => {
    const r = priorFindings([{ role: "assistant", content: longComparison }], period, {});
    expect(r.findings.map((f) => f.id)).toEqual(["CMP-001"]);
    expect(r.findings[0].title).toBe("CPM rose 22%");
  });
});

describe("loadLatestReports", () => {
  afterEach(() => resetDemoStore());

  let clock = Date.parse("2026-10-20T09:00:00Z");
  const say = (conversationId: string, role: Message["role"], content: string, id = `msg_${Math.random().toString(36).slice(2, 10)}`) => {
    getDemoStore().messages.push({
      id,
      conversation_id: conversationId,
      role,
      content,
      tool_call_id: null,
      metadata: null,
      created_at: new Date((clock += 1000)).toISOString(),
    } as Message);
    return id;
  };

  it("returns the latest audit and comparison untruncated, oldest first", async () => {
    const conv = "conv_reports_1";
    say(conv, "assistant", longAudit.replace("Pixel not firing", "Older audit"));
    say(conv, "user", "audit");
    say(conv, "assistant", longAudit);
    say(conv, "user", "compare");
    say(conv, "assistant", longComparison);
    say(conv, "user", "thanks");
    say(conv, "assistant", "You're welcome.");
    const reports = await loadLatestReports(conv);
    expect(reports).toHaveLength(2);
    expect(reports[0].content).toContain("AUD-001 · 🔴 Critical — Pixel not firing on checkout");
    expect(reports[1].content).toContain("CMP-001");
    expect(reports.every((m) => m.role === "assistant")).toBe(true);

    // The truncated history has neither the audit's cards nor the comparison table.
    const history = await loadConversationHistory(conv);
    expect(history.map((m) => m.content).join("\n")).not.toContain("AUD-001");
    expect(history.map((m) => m.content).join("\n")).not.toContain("CMP-001");

    const out = renderStrategyInputsEvidence({ snapshot, goals, scorecard, request: "strategy", history, reports, period });
    expect(out).toContain("- audit of 2026-10-01 → 2026-10-15 used");
    expect(out).toContain("- comparison of 2026-10-01 → 2026-10-15 used");
    expect(out).toContain("AUD-001 — Pixel not firing on checkout");
    expect(out).toContain("AUD-002 — Frequency 4.1 on prospecting");
    expect(out).toContain("CMP-001 — CPM rose 22%");
    expect(out).not.toContain(NO_PRIOR_REPORT_NOTICE);
  });

  it("skips an excluded message and returns nothing without a conversation", async () => {
    const conv = "conv_reports_2";
    const id = say(conv, "assistant", longAudit);
    expect(await loadLatestReports(conv, { excludeMessageId: id })).toEqual([]);
    expect(await loadLatestReports(null)).toEqual([]);
  });

  it("the strategy evidence reads findings from reportHistory, not the truncated history", async () => {
    // strategyPeriod reads "<date> to <date>" on the Period line, so the strategy plans on the audit's period.
    const audit = longAudit.replace("2026-10-01 → 2026-10-15", "2026-10-01 to 2026-10-15");
    const history: AgentHistoryMessage[] = [
      { role: "user", content: "audit last month" },
      { role: "assistant", content: truncatePastReply(audit, 6_000) },
    ];
    const gathered = await gatherDiagnoseEvidence({
      clientId: "client_trafficradius",
      request: "Build me a strategy based on this audit",
      intent: "strategy",
      history,
      reportHistory: [{ role: "assistant", content: audit }],
    });
    expect(gathered.evidence).toContain("AUD-001 — Pixel not firing on checkout");
    expect(gathered.evidence).not.toContain(NO_PRIOR_REPORT_NOTICE);

    const without = await gatherDiagnoseEvidence({
      clientId: "client_trafficradius",
      request: "Build me a strategy based on this audit",
      intent: "strategy",
      history,
    });
    expect(without.evidence).toContain("not used: no finding IDs could be read");
    expect(without.evidence).toContain(NO_PRIOR_REPORT_NOTICE);
  });
});
