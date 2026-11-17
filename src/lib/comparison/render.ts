import { renderMeasurementEvidence } from "@/lib/analysis/measurement";
import type { BreakdownDimension, MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { moneyFor, renderChangesEvidence, renderScorecardEvidence } from "@/lib/audit/render";
import { escapeTableCell } from "@/lib/reports/table-row";
import {
  bridgeIsFlat,
  buildComparison,
  formatBridgeEffect,
  formatBridgeValue,
  formatCount,
  formatKpiRow,
  formatKpiValue,
  type ComparisonInput,
} from "./findings";
import type { EntityChange } from "./entities";
import { COMPARISON_THRESHOLDS } from "./thresholds";

export { buildComparison } from "./findings";
export type { ComparisonFinding, ComparisonInput } from "./findings";

const LOW_VOLUME = "Low volume - not a trend";
const cell = (text: string | null | undefined) => escapeTableCell(text ?? "");
const pct2 = (v: number | null) => (v == null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(2)}%`);
const pct1 = (v: number | null) => (v == null || !Number.isFinite(v) ? "n/a" : `${v.toFixed(1)}%`);

function windowsBlock(w: ReturnType<typeof buildComparison>["windows"]): string[] {
  const lines = [
    `- Current: ${w.current.since} to ${w.current.until} (${w.current.days} days)`,
    `- Previous: ${w.previous.since} to ${w.previous.until} (${w.previous.days} days)`,
  ];
  lines.push(
    w.equalLength
      ? "- The windows are the same length."
      : `- The windows differ in length (${w.current.days} vs ${w.previous.days} days): totals are not like-for-like, compare the per-day figures.`,
  );
  lines.push(
    w.maturity.immature
      ? `- Current window is still maturing from ${w.maturity.immatureFrom}: ${w.maturity.reason}. Recent results may rise.`
      : "- Current window is mature: Meta is no longer adding conversions to it.",
  );
  return lines;
}

function settingsBlock(snap: MetaAuditSnapshot, type: string, breaks: number, caveats: string[]): string[] {
  const live = snap.adSets.filter((a) => a.status === "ACTIVE");
  const sets = live.length > 0 ? live : snap.adSets;
  const windows = [...new Set(sets.flatMap((a) => a.attributionWindows))];
  const events = [...new Set(sets.map((a) => [a.optimizationGoal, a.customEventType].filter(Boolean).join(" / ")).filter(Boolean))];
  return [
    `- Attribution windows in use: ${windows.length ? windows.join(", ") : "Not available (Meta returned none)"}`,
    `- Optimisation events: ${events.length ? events.join("; ") : "Not available"}`,
    `- Business type: ${type}`,
    `- Measurement breaks recorded: ${breaks} (see Tracking)`,
    ...caveats.map((c) => `- Measurement caveat: ${c}`),
  ];
}

function kpiBlock(c: ReturnType<typeof buildComparison>, money: (n: number) => string, currencyNote: string): string[] {
  if (c.kpis.length === 0) return ["- No KPI rows: no totals were loaded for either window."];
  const lines = [
    "| Metric | Current | Previous | Δ | Δ% | Status |",
    "| --- | --- | --- | --- | --- | --- |",
    ...c.kpis.map((r) => formatKpiRow(r, money)),
    `Money is in ${currencyNote}. "n/a" means a side or the baseline is missing: do not quote a % for it. "${LOW_VOLUME}" rows are too small to judge: never call them a trend.`,
  ];
  if (!c.windows.equalLength) {
    lines.push("Per day (the windows differ in length):");
    for (const r of c.kpis) {
      if (r.perDayCurrent == null && r.perDayPrevious == null) continue;
      lines.push(`- ${r.metric}: ${formatKpiValue(r.metric, r.perDayPrevious, money)} -> ${formatKpiValue(r.metric, r.perDayCurrent, money)} per day`);
    }
  }
  return lines;
}

function bridgeBlock(snap: MetaAuditSnapshot, c: ReturnType<typeof buildComparison>, money: (n: number) => string): string[] {
  if (!snap.totals || !snap.previousTotals) {
    return [`- Bridge not available: ${!snap.totals ? "current" : "previous"} account totals did not load.`];
  }
  const lines: string[] = [];
  for (const b of c.bridges) {
    if ("unavailable" in b) {
      lines.push(`- ${b.metric}: not available - missing ${b.unavailable}`);
      continue;
    }
    const head = `- ${b.metric}: ${formatBridgeValue(b.metric, b.previous, money)} -> ${formatBridgeValue(b.metric, b.current, money)}`;
    if (bridgeIsFlat(b.previous, b.current)) {
      lines.push(`${head}; no material change (no driver split)`);
      continue;
    }
    lines.push(`${head}; drivers: ${b.effects.map((e) => formatBridgeEffect(b.metric, e, money)).join("; ")}`);
  }
  if (c.bridges.length === 0) lines.push("- No bridge was computed.");
  return lines;
}

function funnelBlock(c: ReturnType<typeof buildComparison>): string[] {
  if (c.funnels.length === 0) return ["- No funnel for this business type."];
  const lines: string[] = [];
  for (const f of c.funnels) {
    lines.push(`${f.kind === "ecom" ? "Ecommerce" : "Lead generation"} funnel (rate = step ÷ the step before it, same window):`);
    lines.push("| Step | Current | Previous | Rate current | Rate previous | Note |", "| --- | --- | --- | --- | --- | --- |");
    for (const s of f.steps) {
      lines.push(`| ${s.step} | ${formatCount(s.current)} | ${formatCount(s.previous)} | ${pct2(s.rateCurrent)} | ${pct2(s.ratePrevious)} | ${cell(s.note)} |`);
    }
  }
  return lines;
}

function entityTable(list: EntityChange[], money: (n: number) => string): string[] {
  if (list.length === 0) return ["- none"];
  const res = (p: EntityChange["current"]) => (p?.results == null ? "n/a" : `${formatCount(p.results)} ${p.resultLabel}`);
  const spend = (p: EntityChange["current"]) => (p ? money(p.spendCents) : "none");
  return [
    "| Level | Name | Spend current | Spend previous | Results current | Results previous | Share of spend change | Share of results change | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...list.map(
      (e) =>
        `| ${e.level} | ${cell(e.name)} (${cell(e.id)}) | ${spend(e.current)} | ${spend(e.previous)} | ${res(e.current)} | ${res(e.previous)} | ${pct1(e.spendContributionPct)} | ${pct1(e.resultsContributionPct)} | ${e.lowVolume ? LOW_VOLUME : ""} |`,
    ),
  ];
}

function splitAds(ads: EntityChange[]) {
  return {
    likeForLike: ads.filter((e) => e.current && e.previous),
    added: ads.filter((e) => e.current && !e.previous),
    stopped: ads.filter((e) => !e.current && e.previous),
  };
}

function entityGroups(parts: { likeForLike: EntityChange[]; added: EntityChange[]; stopped: EntityChange[] }, money: (n: number) => string): string[] {
  return [
    "Like-for-like (spent in both windows):",
    ...entityTable(parts.likeForLike, money),
    "New (spent only in the current window):",
    ...entityTable(parts.added, money),
    "Stopped (spent only in the previous window):",
    ...entityTable(parts.stopped, money),
  ];
}

const DIMENSION_LABEL: Record<BreakdownDimension, string> = {
  age_gender: "Age and gender",
  placement: "Placement",
  country: "Country",
  device: "Device",
};

function shiftsBlock(snap: MetaAuditSnapshot, c: ReturnType<typeof buildComparison>, money: (n: number) => string): string[] {
  if (!snap.comparisonBreakdowns?.length) return ["- No breakdown data was loaded for this comparison."];
  const lines: string[] = [];
  const dims = [...new Set(c.shifts.shifts.map((s) => s.dimension))];
  for (const d of dims) {
    lines.push(`${DIMENSION_LABEL[d]}:`);
    lines.push("| Segment | Spend share current | Spend share previous | Cost per result current | Cost per result previous | Note |", "| --- | --- | --- | --- | --- | --- |");
    for (const s of c.shifts.shifts.filter((x) => x.dimension === d)) {
      const cpr = (v: number | null) => (v == null ? "n/a" : money(v));
      lines.push(`| ${cell(s.key)} | ${pct1(s.spendShareCurrentPct)} | ${pct1(s.spendSharePreviousPct)} | ${cpr(s.costPerResultCurrent)} | ${cpr(s.costPerResultPrevious)} | ${s.lowVolume ? LOW_VOLUME : ""} |`);
    }
  }
  for (const d of c.shifts.failed) lines.push(`- ${DIMENSION_LABEL[d]}: failed to load`);
  return lines;
}

/** The tracking checkpoints (T-lines) of the audit scorecard evidence, nothing else from it. */
function trackingLines(input: ComparisonInput): string[] {
  const ids = new Set(input.scorecard.checkpoints.filter((c) => c.category === "Tracking & measurement").map((c) => c.id));
  const out: string[] = [];
  let keep = false;
  for (const line of renderScorecardEvidence(input.scorecard, input.snapshot).split("\n")) {
    const m = /^- \[([A-Z0-9]+)\]/.exec(line);
    if (m) keep = ids.has(m[1]);
    else if (!line.startsWith("  ")) keep = false;
    if (keep) out.push(line);
  }
  return out.length ? out : ["- No tracking checkpoints were evaluated."];
}

function failedBlock(snap: MetaAuditSnapshot): string[] {
  const lines = (snap.comparisonFailures ?? []).map((f) => `- ${f}: failed to load`);
  for (const w of snap.warnings) lines.push(`- warning: ${w}`);
  if (lines.length === 0) return ["- Nothing failed to load."];
  lines.push("Say which part failed to load; do not report its metrics as \"not available\".");
  return lines;
}

function thresholdsBlock(): string[] {
  const t = COMPARISON_THRESHOLDS;
  return [
    `- A change of ${t.materialityPct}% or less is Stable.`,
    `- Fewer than ${t.minResults} results/purchases/leads in either window is ${LOW_VOLUME}.`,
    `- Fewer than ${t.minImpressions} impressions in either window makes rate metrics ${LOW_VOLUME}.`,
    `- A campaign, ad set or ad under ${t.minSpendShare * 100}% of account spend is ${LOW_VOLUME}.`,
  ];
}

/** The evidence the comparison writer copies from; every figure is computed here, none by the model. */
export function renderComparisonEvidence(input: ComparisonInput): string {
  const snap = input.snapshot;
  const c = buildComparison(input);
  const money = moneyFor(snap.account.currency);
  const ads = splitAds(c.creative.ads);
  const scoped = Boolean(snap.scope);

  const section = (title: string, body: string[]) => [`#### ${title}`, ...body, ""];

  return [
    `### Comparison evidence — ${snap.account.name}`,
    "",
    ...section("Windows", windowsBlock(c.windows)),
    ...section("Settings", settingsBlock(snap, c.type, c.breaks.length, c.caveats)),
    ...section("KPI scorecard", kpiBlock(c, money, snap.account.currency)),
    ...section("Bridge", bridgeBlock(snap, c, money)),
    ...section("Funnel", funnelBlock(c)),
    ...section("Entities", [
      ...entityGroups(c.entities, money),
      "Ads (same split):",
      ...entityGroups(ads, money),
    ]),
    ...section("Creative", [
      `- Share of current spend on brand-new ads: ${pct1(c.creative.newAdsSpendSharePct)}`,
      c.creative.fatigue.length
        ? `- Fatigue flags: ${c.creative.fatigue.map((f) => `${f.name} (Link CTR ${f.ctrPrevious.toFixed(2)}% -> ${f.ctrCurrent.toFixed(2)}%, 7-day frequency ${f.frequency7d.toFixed(2)})`).join("; ")}`
        : "- Fatigue flags: none",
      ...entityGroups(ads, money),
    ]),
    ...section(scoped ? "Breakdown shifts (whole account)" : "Breakdown shifts", shiftsBlock(snap, c, money)),
    ...section("Changes", [renderChangesEvidence(snap)]),
    ...section("Tracking", [...trackingLines(input), renderMeasurementEvidence(snap)]),
    ...section("User context", [input.userContext?.trim() ? input.userContext.trim() : "none supplied"]),
    ...section("Failed to load", failedBlock(snap)),
    ...section(
      "Findings",
      c.findings.length
        ? c.findings.map((f) => `${f.id} | ${f.kind} | ${cell(f.title)} | ${cell(f.evidence)} | ${f.bucket}`)
        : ["- No findings: nothing moved beyond the thresholds."],
    ),
    ...section("Thresholds", thresholdsBlock()),
  ]
    .join("\n")
    .trimEnd();
}
