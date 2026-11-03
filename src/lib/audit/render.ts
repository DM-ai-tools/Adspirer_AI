import {
  GRADE_BANDS,
  SEVERITY_POINTS,
  checkpointPoints,
  type AuditScorecard,
  type Checkpoint,
  type CheckpointStatus,
} from "@/lib/audit/checkpoints";
import { ownerForCheckpoint, ownerLabel } from "@/lib/agent/optimization-capabilities";
import { escapeTableCell } from "@/lib/reports/table-row";
import { hookRate, holdRate } from "@/lib/creative/fatigue";
import type { AuditAd, AuditAdSet, AuditChange, AuditChangeContext, MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";

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

/** Who has to fix a checkpoint ("this app", "a developer"…); empty for an id with no owner mapped. */
function ownerLine(id: string): string {
  try {
    return `  Who: ${ownerLabel(ownerForCheckpoint(id).owner)}`;
  } catch {
    return "";
  }
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
    snap.warnings.length
      ? `\nParts that failed to load (say which part failed to load — don't report its metrics as "not available"): ${snap.warnings.join("; ")}`
      : "",
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
  options: { video?: boolean; full?: boolean } = {},
): string {
  if (!p || (p.spendCents === 0 && p.impressions === 0)) return "no delivery in the period";
  const n = (v: number) => v.toLocaleString("en");
  const hasSales = p.purchaseValueCents != null || p.purchases != null;
  // When the result is purchases / leads, the results and cost-per-result figures already are those.
  const resultIsPurchases = /^purchases?$/i.test(p.resultLabel);
  const resultIsLeads = /^leads?$/i.test(p.resultLabel);
  return [
    `spend ${money(p.spendCents)}`,
    p.results != null ? `${p.results.toLocaleString("en")} ${p.resultLabel}` : `${p.resultLabel}: not reported`,
    `cost per result ${p.costPerResultCents != null ? money(p.costPerResultCents) : "n/a"}`,
    // Sales revenue is part of every line, not only the snapshot: a sales account is judged on it.
    p.purchaseValueCents != null ? `sales revenue (purchase value) ${money(p.purchaseValueCents)}` : null,
    `impressions ${p.impressions.toLocaleString("en")}`,
    p.reachSummed ? "reach and frequency: not summable across campaigns (people overlap)" : `reach ${p.reach.toLocaleString("en")}`,
    p.reachSummed ? null : `frequency ${p.frequency.toFixed(2)}`,
    `link CTR ${p.linkCtr.toFixed(2)}%`,
    `CPM ${p.cpmCents != null ? money(p.cpmCents) : "n/a"}`,
    p.roas != null ? `ROAS ${p.roas.toFixed(2)}×` : null,
    // The snapshot shows every metric Meta returned, so nothing is missing from it.
    ...(options.full
      ? [
          p.linkClicks != null ? `link clicks ${n(p.linkClicks)}` : null,
          p.linkClicks ? `cost per link click ${money(Math.round(p.spendCents / p.linkClicks))}` : null,
          p.clicks != null ? `clicks (all) ${n(p.clicks)}` : null,
          p.landingPageViews != null ? `landing page views ${n(p.landingPageViews)}` : null,
          p.addToCart != null ? `add to cart ${n(p.addToCart)}` : null,
          p.initiateCheckout != null ? `initiate checkout ${n(p.initiateCheckout)}` : null,
          p.purchases != null && !resultIsPurchases ? `purchases ${n(p.purchases)}` : null,
          p.purchases && !resultIsPurchases ? `cost per purchase ${money(Math.round(p.spendCents / p.purchases))}` : null,
          p.purchases && p.purchaseValueCents != null
            ? `average order value ${money(Math.round(p.purchaseValueCents / p.purchases))}`
            : null,
          p.leads != null && !resultIsLeads ? `leads ${n(p.leads)}` : null,
          p.leads && !resultIsLeads ? `cost per lead ${money(Math.round(p.spendCents / p.leads))}` : null,
          p.videoViews3s != null ? `3-second video plays ${n(p.videoViews3s)}` : null,
          p.thruplays != null ? `ThruPlays ${n(p.thruplays)}` : null,
          hasSales ? null : "sales revenue: no purchase value reported in the period",
        ]
      : []),
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

/** "impressions 50,000 → 60,000 (+20%)"; "n/a" on a side Meta didn't report. */
function delta(
  label: string,
  before: number | null | undefined,
  after: number | null | undefined,
  fmt: (n: number) => string,
): string {
  const show = (n: number | null | undefined) => (n == null ? "n/a" : fmt(n));
  return `${label} ${show(before)} → ${show(after)}${before != null && after != null ? ` (${pctChange(before, after)})` : ""}`;
}

const count = (n: number) => n.toLocaleString("en");

/** Comparison period → this period, every metric "before → after (±%)". */
function changeLine(
  current: PeriodPerformance | null,
  previous: PeriodPerformance | null | undefined,
  money: (cents: number) => string,
  word = "previous period",
): string {
  if (!previous || (previous.spendCents === 0 && previous.impressions === 0)) return `no delivery in the ${word}`;
  const now: PeriodPerformance = current ?? {
    ...previous,
    spendCents: 0,
    impressions: 0,
    reach: 0,
    frequency: 0,
    results: previous.results != null ? 0 : null,
    costPerResultCents: null,
    linkCtr: 0,
    cpmCents: null,
    roas: null,
    ...(previous.linkClicks != null ? { linkClicks: 0 } : {}),
    ...(previous.landingPageViews != null ? { landingPageViews: 0 } : {}),
  };
  const value = (p: PeriodPerformance) =>
    p.purchaseValueCents ?? (p.roas != null ? Math.round(p.roas * p.spendCents) : null);
  const summed = previous.reachSummed || now.reachSummed;
  return [
    delta("spend", previous.spendCents, now.spendCents, money),
    delta("impressions", previous.impressions, now.impressions, count),
    summed
      ? "reach: not summable across campaigns (people overlap), so no reach or frequency for this total"
      : delta("reach", previous.reach, now.reach, count),
    summed ? null : delta("frequency", previous.frequency, now.frequency, (n) => n.toFixed(2)),
    delta("CPM", previous.cpmCents, now.cpmCents, money),
    previous.linkClicks != null || now.linkClicks != null ? delta("link clicks", previous.linkClicks, now.linkClicks, count) : null,
    delta("link CTR", previous.linkCtr, now.linkCtr, (n) => `${n.toFixed(2)}%`),
    previous.results != null || now.results != null
      ? delta(now.resultLabel || previous.resultLabel, previous.results, now.results, count)
      : null,
    previous.costPerResultCents != null || now.costPerResultCents != null
      ? delta("cost per result", previous.costPerResultCents, now.costPerResultCents, money)
      : null,
    previous.roas != null || now.roas != null ? delta("ROAS", previous.roas, now.roas, (n) => `${n.toFixed(2)}×`) : null,
    // Purchase value = ROAS × spend (Meta's purchase ROAS is value ÷ spend).
    value(previous) != null || value(now) != null ? delta("sales revenue (purchase value)", value(previous), value(now), money) : null,
    // Skipped when the result already is purchases (it is listed above under its own label).
    (previous.purchases != null || now.purchases != null) && !/^purchases?$/i.test(now.resultLabel || previous.resultLabel)
      ? delta("purchases", previous.purchases, now.purchases, count)
      : null,
    previous.addToCart != null || now.addToCart != null ? delta("add to cart", previous.addToCart, now.addToCart, count) : null,
    previous.initiateCheckout != null || now.initiateCheckout != null
      ? delta("initiate checkout", previous.initiateCheckout, now.initiateCheckout, count)
      : null,
    previous.leads != null || now.leads != null ? delta("leads", previous.leads, now.leads, count) : null,
    previous.clicks != null || now.clicks != null ? delta("clicks (all)", previous.clicks, now.clicks, count) : null,
    previous.landingPageViews != null || now.landingPageViews != null
      ? delta("landing page views", previous.landingPageViews, now.landingPageViews, count)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const daysIn = (since: string, until: string) =>
  Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
const dayCount = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

/** Per-day figures, for windows of different lengths. */
function dailyLine(
  current: PeriodPerformance | null | undefined,
  previous: PeriodPerformance | null | undefined,
  days: number,
  previousDays: number,
  money: (cents: number) => string,
): string {
  const per = (p: PeriodPerformance | null | undefined, n: number, pick: (p: PeriodPerformance) => number | null) => {
    const v = p ? pick(p) : null;
    return v == null ? null : v / n;
  };
  const both = (pick: (p: PeriodPerformance) => number | null) => [per(previous, previousDays, pick), per(current, days, pick)] as const;
  const [s0, s1] = both((p) => p.spendCents);
  const [i0, i1] = both((p) => p.impressions);
  const [r0, r1] = both((p) => p.results);
  const label = current?.resultLabel || previous?.resultLabel || "Results";
  return [
    delta("spend/day", s0, s1, (n) => money(Math.round(n))),
    delta("impressions/day", i0, i1, (n) => count(Math.round(n))),
    r0 != null || r1 != null ? delta(`${label}/day`, r0, r1, (n) => n.toFixed(1)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

type CompareContext = { word: string; failures: NonNullable<MetaAuditSnapshot["comparisonFailures"]> };

function failedLine(word: string) {
  return `failed to load (Meta returned an error for this part of the ${word}) — say it failed to load; don't call these metrics "not available"`;
}

function adSetBlock(
  a: AuditAdSet,
  ads: AuditAd[],
  campaignSpend: number,
  money: (cents: number) => string,
  compare: CompareContext | null,
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
    compare
      ? `  - vs ${compare.word}: ${
          compare.failures.includes("ad sets") ? failedLine(compare.word) : changeLine(a.performance, a.previousPerformance, money, compare.word)
        }`
      : null,
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
      snap.comparisonNotRequested ? "Comparison: not requested — report this period only." : null,
    ]
      .filter((l) => l != null)
      .join("\n");
  }
  const bySpend = (x: AuditAdSet, y: AuditAdSet) => (y.performance?.spendCents ?? 0) - (x.performance?.spendCents ?? 0);
  const campaignOrder = [...snap.campaigns].sort(
    (x, y) => (y.performance?.spendCents ?? 0) - (x.performance?.spendCents ?? 0),
  );
  const previous = snap.previousPeriod;
  const compare: CompareContext | null = previous
    ? { word: snap.comparisonNamed ? "comparison period" : "previous period", failures: snap.comparisonFailures ?? [] }
    : null;
  const lines: string[] = [header];
  if (previous && compare) {
    const days = daysIn(snap.period.since, snap.period.until);
    const previousDays = daysIn(previous.since, previous.until);
    lines.push(
      `Current: ${snap.period.since} → ${snap.period.until} (${dayCount(days)}); Comparison: ${previous.since} → ${previous.until} (${dayCount(previousDays)}) — ${
        snap.comparisonNamed ? "the range the operator named" : "the same number of days immediately before"
      }. Use exactly these dates in table headers and labels.`,
      `Totals: ${periodLine(snap.totals, money, { full: true })}`,
      `Totals vs ${compare.word} (${previous.since} → ${previous.until}): ${
        compare.failures.includes("totals") ? failedLine(compare.word) : changeLine(snap.totals, snap.previousTotals, money, compare.word)
      }`,
    );
    if (days !== previousDays && !compare.failures.includes("totals")) {
      lines.push(
        `Daily averages (the periods differ in length, ${dayCount(days)} vs ${dayCount(previousDays)}, so totals are not like-for-like): ${dailyLine(snap.totals, snap.previousTotals, days, previousDays, money)}`,
      );
    }
  } else if (snap.comparisonNotRequested) {
    lines.push(`Totals: ${periodLine(snap.totals, money, { full: true })}`, "Comparison: not requested — report this period only.");
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
      `Campaign period: ${periodLine(c.performance, money, { full: true })}`,
      ...(compare
        ? [
            `Campaign vs ${compare.word}: ${
              compare.failures.includes("campaigns")
                ? failedLine(compare.word)
                : changeLine(c.performance, c.previousPerformance, money, compare.word)
            }`,
          ]
        : []),
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
      ? [
          `The "vs ${compare.word}" lines compare against the Comparison window above (${
            snap.comparisonNamed ? "the range the operator named" : "the same number of days immediately before"
          }) — use them to say whether each campaign and ad set is improving or getting worse. Every metric in those lines was loaded: never call it "not available". Only a line that says "failed to load" is missing — say that part failed to load.`,
        ]
      : []),
  );
  return lines.join("\n");
}

const AROUND_DAYS = 3;
const MAX_EDIT_DATES_PER_ENTITY = 12;

/** YYYY-MM-DD shifted by whole days. */
function shiftDay(date: string, delta: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);
}

/** The edits that belong to a campaign, an ad set (incl. its ads) or — for "account" — edits tied to no campaign. */
function editsFor(e: AuditChangeContext, changes: AuditChange[], adSetOfAd: Map<string, string>): AuditChange[] {
  return changes.filter((c) => {
    const type = (c.objectType ?? "").toUpperCase();
    if (e.entityType === "campaign") return type === "CAMPAIGN" && c.objectId === e.id;
    if (e.entityType === "ad set") {
      return ((type === "AD_SET" || type === "ADSET") && c.objectId === e.id) || (type === "AD" && c.objectId != null && adSetOfAd.get(c.objectId) === e.id);
    }
    return c.campaignId == null;
  });
}

/** One window of an object's days as totals and per-day figures: "2 days: $40/day spend, 3 results ($26.67/result), CTR 1.10%". */
function windowLine(days: AuditChangeContext["days"], from: string, to: string, money: (cents: number) => string): string {
  const inside = days.filter((d) => d.date >= from && d.date <= to);
  if (!inside.length) return "no data in the audited period";
  const spend = inside.reduce((sum, d) => sum + d.spendCents, 0);
  const impressions = inside.reduce((sum, d) => sum + d.impressions, 0);
  const counted = inside.filter((d) => d.results != null);
  const results = counted.length ? counted.reduce((sum, d) => sum + d.results!, 0) : null;
  const ctr = impressions > 0 ? inside.reduce((sum, d) => sum + d.linkCtr * d.impressions, 0) / impressions : 0;
  const withRevenue = inside.filter((d) => d.purchaseValueCents != null);
  const revenue = withRevenue.length ? withRevenue.reduce((sum, d) => sum + d.purchaseValueCents!, 0) : null;
  const n = inside.length;
  return [
    `${n} day${n === 1 ? "" : "s"}`,
    `spend ${money(Math.round(spend / n))}/day`,
    results != null ? `${results} results${results > 0 ? ` (${money(Math.round(spend / results))}/result)` : " (no cost per result)"}` : "results n/a",
    `CTR ${ctr.toFixed(2)}%`,
    revenue != null ? `revenue ${money(Math.round(revenue / n))}/day${spend > 0 ? ` (ROAS ${(revenue / spend).toFixed(2)}×)` : ""}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

const MAX_CHANGE_LINES = 120;

/**
 * What was edited in the audited window, as plain facts for the writer: the
 * edits Meta recorded, and the day-by-day delivery of what was edited so
 * movement around an edit can be read. No wording or layout is decided here —
 * the writer works out what mattered (see "Changes during the period" in the
 * audit method). When the history couldn't be read this says so: "nothing
 * changed" is only ever claimed from a list that loaded and was empty.
 */
export function renderChangesEvidence(snap: MetaAuditSnapshot): string {
  const money = moneyFor(snap.account.currency);
  const header = `### Changes made ${snap.period.since} → ${snap.period.until} (Meta account activity history — live, authoritative; days are in the ad account's timezone, ${snap.account.timezone})`;
  if (!snap.changes) {
    const why = snap.warnings.filter((w) => w.startsWith("Change history")).join("; ");
    return [
      header,
      `- The change history could not be read${why ? ` (${why})` : ""}.`,
      "- Say plainly that the history could not be read, so you can't say what was or wasn't edited in this period. Do NOT write that nothing changed, and do not infer edits from the numbers.",
    ].join("\n");
  }
  const scope = scopeLabel(snap);
  if (!snap.changes.length) {
    return [
      header,
      scope ? `Scope: ${scope}.` : "",
      "- Meta recorded no edits in this window. You may say so in one line.",
      snap.changesUnresolved ? `- ${snap.changesUnresolved} edit${snap.changesUnresolved === 1 ? "" : "s"} to ads or ad sets Meta no longer lists could not be tied to these campaigns.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const shown = snap.changes.slice(0, MAX_CHANGE_LINES);
  const kind = (t: string | null) => (t ? t.toLowerCase().replace(/_/g, " ") : "object");
  const lines: string[] = [
    header,
    scope ? `Scope: ${scope} — edits to these campaigns and their ad sets/ads, plus account-wide tracking edits.` : "",
    `${snap.changes.length} edit${snap.changes.length === 1 ? "" : "s"} recorded, newest first:`,
    ...shown.map((c) => {
      const who = c.actor ? `${c.actor}${c.application ? ` via ${c.application}` : ""}` : c.application ? `via ${c.application}` : "actor not reported";
      return `- ${c.localDate} ${c.time.slice(11, 16)} UTC · ${kind(c.objectType)} "${c.objectName ?? c.objectId ?? "unknown"}"${c.objectId ? ` (${c.objectId})` : ""} · ${c.label ?? c.eventType.replace(/_/g, " ")} [${c.eventType}] · ${who}${c.detail ? ` · detail: ${c.detail}` : ""}`;
    }),
    snap.changes.length > shown.length ? `- ${snap.changes.length - shown.length} older edits not listed.` : "",
    snap.changesTruncated ? "- Meta's history was cut at its page cap, so older edits in this window may be missing — say the list may be incomplete." : "",
    snap.changesUnresolved ? `- ${snap.changesUnresolved} further edit${snap.changesUnresolved === 1 ? "" : "s"} to ads or ad sets Meta no longer lists could not be tied to these campaigns, so they aren't shown.` : "",
  ];
  if (snap.changeContext?.length) {
    lines.push(
      "",
      `Numbers around each edit (same period, account timezone, ${snap.account.currency}). "results" are the object's own optimisation result. Each edit is shown with the object's schedule and its figures for the ${AROUND_DAYS} days before, the day of, and the ${AROUND_DAYS} days after (only days inside the audited period exist). Use these — not guesses — to judge each edit:`,
    );
    const adSetOfAd = new Map(snap.ads.map((a) => [a.id, a.adSetId]));
    for (const e of snap.changeContext) {
      const edits = editsFor(e, snap.changes ?? [], adSetOfAd);
      const kindLabel = e.entityType === "account" ? "whole ad account (edits not tied to one campaign, e.g. tracking)" : `${e.entityType} "${e.name}" (${e.id})`;
      const schedule =
        e.entityType === "account"
          ? null
          : `status ${e.status ?? "unknown"} · scheduled ${e.startDate ?? "start not set"} → ${e.endDate ?? "no end date set"}`;
      lines.push(`- ${kindLabel}${schedule ? ` · ${schedule}` : ""}`);
      if (e.days.length <= 31) {
        lines.push(
          `  - Day by day: ${e.days
            .map((d) => `${d.date.slice(5)} spend ${money(d.spendCents)}, ${d.results ?? "n/a"} results${d.costPerResultCents != null ? `, ${money(d.costPerResultCents)}/result` : ""}, CTR ${d.linkCtr.toFixed(2)}%${d.purchaseValueCents != null ? `, revenue ${money(d.purchaseValueCents)}` : ""}`)
            .join(" | ")}`,
        );
      }
      const byDate = new Map<string, AuditChange[]>();
      for (const c of edits) byDate.set(c.localDate, [...(byDate.get(c.localDate) ?? []), c]);
      const dates = [...byDate.keys()].sort().slice(0, MAX_EDIT_DATES_PER_ENTITY);
      for (const date of dates) {
        const group = byDate.get(date)!;
        const what = [...new Set(group.map((c) => c.label ?? c.eventType.replace(/_/g, " ")))].join("; ");
        const who = [...new Set(group.map((c) => c.actor ?? (c.application ? `via ${c.application}` : null)).filter(Boolean))].join(", ") || "actor not reported";
        lines.push(
          `  - Edit on ${date} (${what}; ${who}) — before: ${windowLine(e.days, shiftDay(date, -AROUND_DAYS), shiftDay(date, -1), money)} · day of: ${windowLine(e.days, date, date, money)} · after: ${windowLine(e.days, shiftDay(date, 1), shiftDay(date, AROUND_DAYS), money)}`,
        );
      }
      if (byDate.size > dates.length) lines.push(`  - ${byDate.size - dates.length} more edit days on this object not shown.`);
    }
  }
  lines.push(
    "",
    "Amounts inside \"detail\" are usually in the account currency's minor units (cents) — check them against the budgets in the ad set / campaign evidence before quoting one, and if you can't be sure, say the budget was raised or lowered without a figure.",
    "A name or id missing from \"detail\" is just not reported — don't fill it in.",
  );
  return lines.filter((l) => l !== "").join("\n");
}

/** Short list of open issues for the optimise flow. */
export function renderOptimisationSignals(scorecard: AuditScorecard): string {
  const relevant = scorecard.priorities.slice(0, 10);
  if (!relevant.length) return "### Optimisation signals (live checkpoints)\n- No failing or warning checkpoints.";
  return [
    "### Optimisation signals (live checkpoints)",
    ...relevant.map((c) => {
      const who = ownerLine(c.id);
      return who ? `${line(c)}\n${who}` : line(c);
    }),
    "Fix tracking failures (T-codes) before scaling budgets: budget changes on ad sets whose optimisation event isn't recorded only move money blind.",
  ].join("\n");
}
