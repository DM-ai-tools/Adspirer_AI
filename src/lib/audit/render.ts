import type { AuditScorecard, Checkpoint, CheckpointStatus } from "@/lib/audit/checkpoints";
import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";

const STATUS_LABEL: Record<CheckpointStatus, string> = {
  pass: "Pass",
  warn: "Warning",
  fail: "Fail",
  info: "Note",
  not_checked: "Not checked",
};

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;

/** Table cells can't contain pipes or newlines. */
const cell = (text: string | undefined) => (text ?? "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ").trim();

function line(c: Checkpoint) {
  return [
    `- [${c.id}] ${STATUS_LABEL[c.status].toUpperCase()} · ${SEVERITY_LABEL[c.severity]} · ${c.category} · ${c.title}`,
    `  Evidence: ${c.evidence}`,
    c.fix ? `  Fix: ${c.fix}` : "",
    c.impact ? `  Impact: ${c.impact}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Evidence block for the writer. Results are authoritative: the narrative
 * may explain and prioritise them but never contradict them.
 */
export function renderScorecardEvidence(scorecard: AuditScorecard, snap: MetaAuditSnapshot): string {
  const tracked = snap.pixels.filter((p) => p.stats7d);
  return [
    `### Audit checkpoint scorecard (computed from live Meta data — authoritative)`,
    `Period: ${snap.period.since} → ${snap.period.until} (${snap.period.days} days) · Score ${scorecard.score}/100 (grade ${scorecard.grade}) · ${scorecard.counts.fail} fail, ${scorecard.counts.warn} warning, ${scorecard.counts.pass} pass`,
    `By area: ${scorecard.byCategory.map((c) => `${c.category} ${c.score}/100`).join(" · ")}`,
    tracked.length
      ? `Tracking data: ${tracked
          .map((p) => {
            const top = Object.entries(p.stats28d?.events ?? p.stats7d?.events ?? {})
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([e, n]) => `${e} ${n}`)
              .join(", ");
            return `${p.name} — 28d events: ${top || "none"}; server share ${Math.round((p.stats7d?.serverShare ?? 0) * 100)}%`;
          })
          .join(" | ")}`
      : "",
    "",
    ...scorecard.checkpoints.map(line),
    snap.warnings.length ? `\nData not available: ${snap.warnings.join("; ")}` : "",
    "",
    "How to use this scorecard:",
    "- Lead the audit with the Fail items, most severe first; quote their evidence numbers and give the fix and impact in plain business language.",
    "- Never contradict a checkpoint (e.g. don't call tracking healthy when T2/T3/T4 fail). If you have extra evidence, add it — don't overrule.",
    "- A full checklist table is appended to your reply automatically: do NOT reproduce it; reference checkpoint IDs (e.g. \"see T2\") where useful.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Markdown appended to the audit reply (and so to PDF/Word/Excel exports). */
export function renderScorecardMarkdown(scorecard: AuditScorecard, snap: MetaAuditSnapshot): string {
  const rows = [...scorecard.checkpoints].sort((a, b) => {
    const order: Record<CheckpointStatus, number> = { fail: 0, warn: 1, info: 2, pass: 3, not_checked: 4 };
    return order[a.status] - order[b.status];
  });
  return [
    "## Audit checklist",
    "",
    `Score **${scorecard.score}/100** (grade ${scorecard.grade}) across ${scorecard.checkpoints.length} checkpoints, ${snap.period.since} → ${snap.period.until}. ${scorecard.counts.fail} failed, ${scorecard.counts.warn} need attention, ${scorecard.counts.pass} passed.`,
    "",
    "| Area | Score | Pass | Warning | Fail |",
    "| --- | --- | --- | --- | --- |",
    ...scorecard.byCategory.map(
      (c) => `| ${c.category} | ${c.score}/100 | ${c.pass} | ${c.warn} | ${c.fail} |`,
    ),
    "",
    "| ID | Checkpoint | Result | Severity | Evidence | Fix |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (c) =>
        `| ${c.id} | ${cell(c.title)} | ${STATUS_LABEL[c.status]} | ${SEVERITY_LABEL[c.severity]} | ${cell(c.evidence)} | ${cell(c.fix ?? (c.status === "pass" ? "—" : ""))} |`,
    ),
  ].join("\n");
}

/** Short list of open issues for the optimise flow. */
export function renderOptimisationSignals(scorecard: AuditScorecard): string {
  const relevant = scorecard.priorities.slice(0, 10);
  if (!relevant.length) return "### Optimisation signals (live checkpoints)\n- No failing or warning checkpoints.";
  return [
    "### Optimisation signals (live checkpoints)",
    ...relevant.map(line),
    "Fix tracking failures (T-codes) before scaling budgets: budget changes on ad sets whose optimisation event isn't recorded only move money blind.",
  ].join("\n");
}
