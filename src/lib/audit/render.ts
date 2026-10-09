import {
  GRADE_BANDS,
  SEVERITY_POINTS,
  checkpointPoints,
  type AuditScorecard,
  type Checkpoint,
  type CheckpointStatus,
} from "@/lib/audit/checkpoints";
import { escapeTableCell } from "@/lib/reports/table-row";
import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";

const STATUS_LABEL: Record<CheckpointStatus, string> = {
  pass: "Pass",
  warn: "Warning",
  fail: "Fail",
  info: "Note",
  not_checked: "Not checked",
};

const SEVERITY_LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;

/** Pipes are escaped (names like "TR | Lead Gen" stay intact); newlines flattened. */
const cell = (text: string | undefined) => escapeTableCell(text ?? "");

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
    `By area: ${scorecard.byCategory
      .map((c) => `${c.category} ${c.score == null ? "not scored" : `${c.score}/100`}`)
      .join(" · ")}`,
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

const pts = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

const STATUS_ORDER: Record<CheckpointStatus, number> = { fail: 0, warn: 1, pass: 2, info: 3, not_checked: 4 };

function resultCell(c: Checkpoint) {
  return c.status === "info" || c.status === "not_checked"
    ? STATUS_LABEL[c.status]
    : `${STATUS_LABEL[c.status]} · ${SEVERITY_LABEL[c.severity]}`;
}

function pointsCell(c: Checkpoint) {
  const p = checkpointPoints(c);
  return p ? `${pts(p.earned)} of ${pts(p.possible)}` : "not scored";
}

/** "T3 Fail (−6) · T2 Warning (−3)" — what cost the area its points. */
function pulledDown(items: Checkpoint[]) {
  const losses = items
    .map((c) => ({ c, p: checkpointPoints(c) }))
    .filter((x) => x.p && x.p.earned < x.p.possible)
    .sort((a, b) => b.p!.possible - b.p!.earned - (a.p!.possible - a.p!.earned));
  if (!losses.length) return "Nothing — every scored checkpoint passed";
  return losses
    .map(({ c, p }) => `${c.id} ${STATUS_LABEL[c.status]} (−${pts(p!.possible - p!.earned)})`)
    .join(" · ");
}

/** Markdown appended to the audit reply (and so to PDF/Word/Excel exports). */
export function renderScorecardMarkdown(scorecard: AuditScorecard, snap: MetaAuditSnapshot): string {
  const unscored = scorecard.counts.info + scorecard.counts.not_checked;
  const bands = GRADE_BANDS.map((b, i) =>
    i === 0 ? `${b.grade} ${b.min}+` : b.min === 0 ? `${b.grade} below ${GRADE_BANDS[i - 1]!.min}` : `${b.grade} ${b.min}–${GRADE_BANDS[i - 1]!.min - 1}`,
  ).join(", ");

  const lines = [
    "## Audit checklist",
    "",
    `Score **${scorecard.score}/100** (grade ${scorecard.grade}) from ${scorecard.checkpoints.length} checkpoints, ${snap.period.since} → ${snap.period.until}: ${scorecard.counts.fail} failed, ${scorecard.counts.warn} warnings, ${scorecard.counts.pass} passed${unscored ? `, ${unscored} notes (not scored)` : ""}.`,
    "",
    "### How the score works",
    `- Each checkpoint is worth points by severity: Critical ${SEVERITY_POINTS.critical}, High ${SEVERITY_POINTS.high}, Medium ${SEVERITY_POINTS.medium}, Low ${SEVERITY_POINTS.low}.`,
    "- **Pass** earns all its points, **Warning** half, **Fail** none. **Notes** (and anything that couldn't be checked) are listed for information but don't count.",
    `- An area's score is the points it earned divided by the points possible in that area. The overall score does the same across every scored checkpoint: ${pts(scorecard.earned)} of ${pts(scorecard.possible)} points = ${scorecard.score}/100.`,
    `- Grades: ${bands}.`,
    "- An area with only notes shows \"Not scored\" — there was nothing in it to pass or fail.",
    "",
    "### Scores by area",
    "",
    "| Area | Score | Points | Checkpoints in this area | What lowered the score |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const area of scorecard.byCategory) {
    const items = scorecard.checkpoints
      .filter((c) => c.category === area.category)
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    lines.push(
      `| ${area.category} | ${area.score == null ? "Not scored" : `${area.score}/100`} | ${
        area.possible ? `${pts(area.earned)} of ${pts(area.possible)}` : "—"
      } | ${items.map((c) => `${c.id} ${STATUS_LABEL[c.status]}`).join(" · ")} | ${
        area.score == null ? "Only notes — nothing to score" : pulledDown(items)
      } |`,
    );
  }

  for (const area of scorecard.byCategory) {
    const items = scorecard.checkpoints
      .filter((c) => c.category === area.category)
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
    lines.push(
      "",
      `### ${area.category} — ${area.score == null ? "not scored" : `${area.score}/100`}`,
      "",
      area.score == null
        ? "Only informational notes in this area, so it doesn't affect the overall score."
        : `${pts(area.earned)} of ${pts(area.possible)} points: ${area.pass} passed, ${area.warn} warning${area.warn === 1 ? "" : "s"}, ${area.fail} failed${area.unscored ? `, ${area.unscored} note${area.unscored === 1 ? "" : "s"}` : ""}.`,
      "",
      "| ID | Checkpoint | Result | Points | Evidence | Fix |",
      "| --- | --- | --- | --- | --- | --- |",
      ...items.map(
        (c) =>
          `| ${c.id} | ${cell(c.title)} | ${resultCell(c)} | ${pointsCell(c)} | ${cell(c.evidence)} | ${cell(c.fix ?? (c.status === "pass" ? "—" : ""))} |`,
      ),
    );
  }

  return lines.join("\n");
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
