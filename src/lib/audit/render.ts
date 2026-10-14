import {
  GRADE_BANDS,
  SEVERITY_POINTS,
  checkpointPoints,
  type AuditScorecard,
  type Checkpoint,
  type CheckpointStatus,
} from "@/lib/audit/checkpoints";
import { escapeTableCell } from "@/lib/reports/table-row";
import { hookRate, holdRate } from "@/lib/creative/fatigue";
import type { AuditAd, AuditAdSet, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";

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

/** "Campaign TR | Lead Gen (1202…)" when the audit is campaign-scoped; null for the whole account. */
function scopeLabel(snap: MetaAuditSnapshot): string | null {
  const scoped = snap.scope?.campaigns;
  if (!scoped) return null;
  if (!scoped.length) return "selected campaigns (none found in the snapshot)";
  return `${scoped.length === 1 ? "campaign" : "campaigns"} ${scoped.map((c) => `${c.name} (${c.id})`).join("; ")}`;
}

/**
 * Evidence block for the writer. Results are authoritative: the narrative
 * may explain and prioritise them but never contradict them.
 */
export function renderScorecardEvidence(scorecard: AuditScorecard, snap: MetaAuditSnapshot): string {
  const tracked = snap.pixels.filter((p) => p.stats7d);
  const scope = scopeLabel(snap);
  return [
    `### Audit checkpoint scorecard (computed from live Meta data — authoritative)`,
    scope ? `Scope: ${scope} — structure, bidding, audience, creative and funnel checks cover only these; tracking checks are account-wide.` : "",
    `Period: ${snap.period.since} → ${snap.period.until} (${snap.period.days} days) · ${gradeLine(scorecard)} · ${scorecard.counts.fail} fail, ${scorecard.counts.warn} warning, ${scorecard.counts.pass} pass`,
    scorecard.gradeStatus === "graded"
      ? ""
      : "The score is provisional or withheld because too many checks had no data — say so, and list what to connect or set (e.g. targets in the client's goals) rather than presenting it as a firm grade.",
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

/** "Score 72/100 (grade C)", or why there is no firm grade. */
function gradeLine(scorecard: AuditScorecard, bold = false): string {
  const coverage = `${Math.round(scorecard.coverage * 100)}% of checks had data`;
  const score = bold ? `**${scorecard.score}/100**` : `${scorecard.score}/100`;
  if (scorecard.gradeStatus === "not_graded") return `Not graded (${coverage})`;
  if (scorecard.gradeStatus === "provisional") return `Provisional score ${score} (grade ${scorecard.grade}, ${coverage})`;
  return `Score ${score} (grade ${scorecard.grade}, ${coverage})`;
}

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

  const scope = scopeLabel(snap);
  const lines = [
    "## Audit checklist",
    "",
    `${gradeLine(scorecard, true)} from ${scorecard.checkpoints.length} checkpoints, ${snap.period.since} → ${snap.period.until}${scope ? ` for ${scope}` : ""}: ${scorecard.counts.fail} failed, ${scorecard.counts.warn} warnings, ${scorecard.counts.pass} passed${unscored ? `, ${unscored} notes or not checked (not scored)` : ""}.`,
    "",
    "### How the score works",
    `- Each checkpoint is worth points by severity: Critical ${SEVERITY_POINTS.critical}, High ${SEVERITY_POINTS.high}, Medium ${SEVERITY_POINTS.medium}, Low ${SEVERITY_POINTS.low}.`,
    "- **Pass** earns all its points, **Warning** half, **Fail** none. **Notes** (and anything that couldn't be checked) are listed for information but don't count.",
    "- An area's score is the points it earned divided by the points possible in that area. The overall score weights the areas: tracking 30%, creative and frequency 30%, structure and budget 20%, audiences 20%.",
    `- Coverage: ${Math.round(scorecard.coverage * 100)}% of applicable checks had data. 80%+ is graded, 60–79% provisional, below 60% not graded. Missing data lowers coverage, never the score.`,
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

const LEARNING_LABEL: Record<string, string> = {
  LEARNING: "In learning",
  SUCCESS: "Exited learning",
  FAIL: "Learning limited",
};

const isLiveStatus = (status: string) => status === "ACTIVE" || status === "WITH_ISSUES";

function moneyFor(currency: string) {
  return (cents: number) => {
    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: cents >= 100_000 ? 0 : 2,
      }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currency}`;
    }
  };
}

function periodLine(
  p: PeriodPerformance | null,
  money: (cents: number) => string,
  options: { video?: boolean } = {},
): string {
  if (!p || (p.spendCents === 0 && p.impressions === 0)) return "no delivery in the period";
  return [
    `spend ${money(p.spendCents)}`,
    p.results != null ? `${p.results.toLocaleString("en")} ${p.resultLabel}` : `${p.resultLabel}: not reported`,
    `cost per result ${p.costPerResultCents != null ? money(p.costPerResultCents) : "n/a"}`,
    `impressions ${p.impressions.toLocaleString("en")}`,
    `reach ${p.reach.toLocaleString("en")}`,
    `frequency ${p.frequency.toFixed(2)}`,
    `link CTR ${p.linkCtr.toFixed(2)}%`,
    `CPM ${p.cpmCents != null ? money(p.cpmCents) : "n/a"}`,
    p.roas != null ? `ROAS ${p.roas.toFixed(2)}×` : null,
    // Video rates only per ad: higher rows mix in image impressions.
    options.video && hookRate(p) != null ? `hook rate ${Math.round(hookRate(p)!)}%` : null,
    options.video && holdRate(p) != null ? `hold rate ${Math.round(holdRate(p)!)}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "+19%" / "−12%" / "new" — change from `before` to `after`. */
function pctChange(before: number, after: number): string {
  if (before === 0) return after === 0 ? "no change" : "new";
  const pct = Math.round(((after - before) / before) * 100);
  return pct === 0 ? "no change" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`;
}

/** Previous period → this period, for the numbers that decide a verdict. */
function changeLine(
  current: PeriodPerformance | null,
  previous: PeriodPerformance | null | undefined,
  money: (cents: number) => string,
): string {
  if (!previous || (previous.spendCents === 0 && previous.impressions === 0)) return "no delivery in the previous period";
  const now = current ?? { ...previous, spendCents: 0, impressions: 0, results: 0, costPerResultCents: null, linkCtr: 0 };
  return [
    `spend ${money(previous.spendCents)} → ${money(now.spendCents)} (${pctChange(previous.spendCents, now.spendCents)})`,
    previous.results != null || now.results != null
      ? `${now.resultLabel || previous.resultLabel} ${previous.results ?? "n/a"} → ${now.results ?? "n/a"}`
      : null,
    previous.costPerResultCents != null && now.costPerResultCents != null
      ? `cost per result ${money(previous.costPerResultCents)} → ${money(now.costPerResultCents)} (${pctChange(previous.costPerResultCents, now.costPerResultCents)})`
      : null,
    `link CTR ${previous.linkCtr.toFixed(2)}% → ${now.linkCtr.toFixed(2)}%`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function adSetBlock(
  a: AuditAdSet,
  ads: AuditAd[],
  campaignSpend: number,
  money: (cents: number) => string,
  compare: boolean,
): string {
  const spend = a.performance?.spendCents ?? 0;
  const liveAds = ads.filter((ad) => isLiveStatus(ad.status));
  const budget = a.dailyBudgetCents
    ? `daily budget ${money(a.dailyBudgetCents)}`
    : a.lifetimeBudgetCents
      ? `lifetime budget ${money(a.lifetimeBudgetCents)}`
      : "budget set at campaign level (CBO)";
  // OFFSITE_CONVERSIONS → "Offsite conversions", so the report reads in plain words.
  const plain = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ");
  const goal = [a.optimizationGoal, a.customEventType].filter((v): v is string => Boolean(v)).map(plain).join(" → ") || "unknown";
  const setup = [
    budget,
    `optimises for ${goal}`,
    `bid ${a.bidStrategy ?? "default (lowest cost)"}`,
    `attribution ${a.attributionWindows.join(", ") || "default"}`,
    `Advantage+ audience ${a.advantageAudience == null ? "unknown" : a.advantageAudience ? "on" : "off"}`,
    `placements ${a.publisherPlatforms.join(", ") || "Advantage+ (all)"}`,
    `countries ${a.countries.join(", ") || "not set"}`,
    `custom audiences ${a.includedAudienceIds.length} included / ${a.excludedAudienceIds.length} excluded`,
  ].join(" · ");
  const adLines = [...ads]
    .sort((x, y) => (y.performance?.spendCents ?? 0) - (x.performance?.spendCents ?? 0))
    .slice(0, 8)
    .map(
      (ad) =>
        `    - ${ad.name} (${ad.id}) · ${ad.status}${ad.format ? ` · ${ad.format}` : ""}${ad.issue ? ` · issue: ${ad.issue}` : ""} — ${periodLine(ad.performance, money, { video: true })}`,
    );
  return [
    `- **${a.name} (${a.id})** · ${a.status} · ${a.learningStatus ? LEARNING_LABEL[a.learningStatus] ?? a.learningStatus : "learning status not reported"}${
      a.lastSignificantEdit ? ` (last significant edit ${a.lastSignificantEdit.slice(0, 10)})` : ""
    }`,
    `  - Setup: ${setup}`,
    `  - Period: ${periodLine(a.performance, money)}${
      campaignSpend > 0 && spend > 0 ? ` · ${Math.round((spend / campaignSpend) * 100)}% of campaign spend` : ""
    }${a.frequency7d != null ? ` · 7-day frequency ${a.frequency7d.toFixed(2)}` : ""}`,
    compare ? `  - vs previous period: ${changeLine(a.performance, a.previousPerformance, money)}` : null,
    `  - Ads: live ads ${liveAds.length} of ${ads.length}${ads.length > 8 ? " (top 8 by spend below)" : ""}`,
    ...adLines,
  ]
    .filter((l) => l != null)
    .join("\n");
}

/**
 * Every ad set in scope with its setup and period numbers, grouped by
 * campaign — the writer audits each one. Account-wide audits list ad sets
 * that are live or spent in the period.
 */
export function renderAdSetEvidence(snap: MetaAuditSnapshot, maxAdSets = 40): string {
  const money = moneyFor(snap.account.currency);
  const scoped = Boolean(snap.scope);
  const adSets = scoped
    ? snap.adSets
    : snap.adSets.filter((a) => isLiveStatus(a.status) || (a.performance?.spendCents ?? 0) > 0);
  const header = `### Ad sets (${snap.period.since} → ${snap.period.until}) — live Meta data, authoritative`;
  if (!adSets.length) {
    return [
      header,
      scoped
        ? "- No ad sets found in the audited campaign(s) — the campaign cannot deliver without one. Say so; do not invent ad set numbers."
        : "- No ad sets are live or spent in the period.",
    ].join("\n");
  }
  const bySpend = (x: AuditAdSet, y: AuditAdSet) => (y.performance?.spendCents ?? 0) - (x.performance?.spendCents ?? 0);
  const campaignOrder = [...snap.campaigns].sort(
    (x, y) => (y.performance?.spendCents ?? 0) - (x.performance?.spendCents ?? 0),
  );
  const previous = snap.previousPeriod;
  const compare = Boolean(previous);
  const lines: string[] = [header];
  if (previous) {
    lines.push(
      `Totals: ${periodLine(snap.totals, money)}`,
      `Totals vs previous period (${previous.since} → ${previous.until}): ${changeLine(snap.totals, snap.previousTotals, money)}`,
    );
  }
  let shown = 0;
  for (const c of campaignOrder) {
    const own = adSets.filter((a) => a.campaignId === c.id).sort(bySpend);
    if (!own.length || shown >= maxAdSets) continue;
    const live = own.filter((a) => isLiveStatus(a.status)).length;
    lines.push(
      "",
      `#### Campaign ${c.name} (${c.id}) · ${c.status} · ${c.objective}${
        c.dailyBudgetCents ? ` · campaign daily budget ${money(c.dailyBudgetCents)}` : ""
      } — ${own.length} ad set${own.length === 1 ? "" : "s"}, ${live} live`,
      `Campaign period: ${periodLine(c.performance, money)}`,
      ...(compare ? [`Campaign vs previous period: ${changeLine(c.performance, c.previousPerformance, money)}`] : []),
    );
    for (const a of own.slice(0, maxAdSets - shown)) {
      lines.push(adSetBlock(a, snap.ads.filter((ad) => ad.adSetId === a.id), c.performance?.spendCents ?? 0, money, compare));
      shown += 1;
    }
  }
  if (adSets.length > shown) lines.push("", `- ${adSets.length - shown} more ad sets not listed.`);
  lines.push(
    "",
    "Use these numbers for the per-ad-set audit. A metric marked \"not reported\" or \"n/a\" was not measured — say so; never estimate it.",
    ...(compare
      ? ["The \"vs previous period\" lines compare against the same number of days immediately before — use them to say whether each campaign and ad set is improving or getting worse."]
      : []),
  );
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
