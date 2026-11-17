import type { MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import { COMPARISON_THRESHOLDS } from "./thresholds";

export type EntityLevel = "campaign" | "ad set" | "ad";

export type EntityChange = {
  level: EntityLevel;
  id: string;
  name: string;
  objective: string | null;
  current: PeriodPerformance | null;
  previous: PeriodPerformance | null;
  /** This entity's spend change ÷ the account's spend change × 100; null when the account change is under the materiality threshold or unknown. */
  spendContributionPct: number | null;
  resultsContributionPct: number | null;
  lowVolume: boolean;
};

const MAX_PER_LEVEL = 25;
const LEVELS: EntityLevel[] = ["campaign", "ad set", "ad"];

type Raw = {
  level: EntityLevel;
  id: string;
  name: string;
  objective: string | null;
  current: PeriodPerformance | null;
  previous: PeriodPerformance | null;
};

type Row = {
  id: string;
  name: string;
  campaignId?: string;
  performance: PeriodPerformance | null;
  previousPerformance?: PeriodPerformance | null;
};

type Deltas = { spend: number | null; results: number | null };

function finite(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function spendOf(p: PeriodPerformance | null | undefined): number {
  return finite(p?.spendCents) ?? 0;
}

function delivered(p: PeriodPerformance | null | undefined): p is PeriodPerformance {
  return spendOf(p) > 0;
}

/**
 * The account's change, or null when it moved less than the materiality threshold: a share of a
 * near-zero change is noise (a campaign "carrying 900% of the change").
 */
function material(delta: number, previous: number): number | null {
  if (previous <= 0) return delta === 0 ? null : delta;
  return (Math.abs(delta) / previous) * 100 < COMPARISON_THRESHOLDS.materialityPct ? null : delta;
}

function accountDeltas(snap: MetaAuditSnapshot): Deltas {
  const cur = snap.totals;
  const prev = snap.previousTotals;
  if (!cur || !prev) return { spend: null, results: null };
  const spend = material(spendOf(cur) - spendOf(prev), spendOf(prev));
  const c = finite(cur.results);
  const p = finite(prev.results);
  return { spend, results: c != null && p != null ? material(c - p, p) : null };
}

/**
 * The entity's share of the account's net change, 0–100%. Outside that range the entity moved against
 * the net change, or by more than it (a stopped campaign larger than the net drop): a "199.7%" or
 * "−99.7%" share reads as an error to a client, so it is null and the renderer explains why.
 */
function pct(delta: number | null, accountDelta: number | null): number | null {
  if (delta == null || accountDelta == null || accountDelta === 0) return null;
  const r = (delta / accountDelta) * 100;
  return Number.isFinite(r) && r >= 0 && r <= 100 ? r : null;
}

/** Spend share of the account in that window, as a fraction; null when unknown. */
function shareOf(p: PeriodPerformance | null, totals: PeriodPerformance | null | undefined): number | null {
  const total = finite(totals?.spendCents);
  if (!p || total == null || total <= 0) return null;
  return spendOf(p) / total;
}

function isLowVolume(snap: MetaAuditSnapshot, e: Raw): boolean {
  const small = (s: number | null) => s != null && s < COMPARISON_THRESHOLDS.minSpendShare;
  const curSmall = small(shareOf(e.current, snap.totals));
  const prevSmall = small(shareOf(e.previous, snap.previousTotals));
  // Added entities only exist now, stopped ones only existed before; judge them on the window they have.
  const lowShare = e.current && e.previous ? curSmall && prevSmall : e.current ? curSmall : prevSmall;
  const lowResults = [e.current, e.previous].some((p) => {
    const r = finite(p?.results);
    return r != null && r < COMPARISON_THRESHOLDS.minResults;
  });
  return lowShare || lowResults;
}

function toChange(snap: MetaAuditSnapshot, e: Raw, acc: Deltas): EntityChange {
  const spendDelta = spendOf(e.current) - spendOf(e.previous);
  const c = finite(e.current?.results);
  const p = finite(e.previous?.results);
  const resultsDelta = c == null && p == null ? null : (c ?? 0) - (p ?? 0);
  return {
    ...e,
    spendContributionPct: pct(spendDelta, acc.spend),
    resultsContributionPct: pct(resultsDelta, acc.results),
    lowVolume: isLowVolume(snap, e),
  };
}

function absDelta(e: EntityChange): number {
  return Math.abs(spendOf(e.current) - spendOf(e.previous));
}

/** Per level: biggest |spend change| first, at most MAX_PER_LEVEL kept. */
function rank(list: EntityChange[]): EntityChange[] {
  return LEVELS.flatMap((level) => list.filter((e) => e.level === level).sort((a, b) => absDelta(b) - absDelta(a)).slice(0, MAX_PER_LEVEL));
}

function rawFor(level: EntityLevel, rows: Row[], objectives: Map<string, string | null>): Raw[] {
  // No row carries a previous window at all: it was never loaded, so do not call everything "added".
  if (!rows.some((r) => r.previousPerformance !== undefined)) return [];
  return rows
    .map((r) => ({
      level,
      id: r.id,
      name: r.name,
      objective: level === "campaign" ? (objectives.get(r.id) ?? null) : (objectives.get(r.campaignId ?? "") ?? null),
      current: delivered(r.performance) ? r.performance : null,
      previous: delivered(r.previousPerformance) ? r.previousPerformance : null,
    }))
    .filter((r) => r.current || r.previous);
}

function objectivesOf(snap: MetaAuditSnapshot): Map<string, string | null> {
  return new Map((snap.campaigns ?? []).map((c) => [c.id, c.objective ?? null]));
}

/** Campaigns and ad sets split into like-for-like (spent in both windows), added (current only) and stopped (previous only). */
export function entitySplit(snap: MetaAuditSnapshot): { likeForLike: EntityChange[]; added: EntityChange[]; stopped: EntityChange[] } {
  const objectives = objectivesOf(snap);
  const acc = accountDeltas(snap);
  const all = [
    ...rawFor("campaign", snap.campaigns ?? [], objectives),
    ...rawFor("ad set", (snap.adSets ?? []) as Row[], objectives),
  ].map((r) => toChange(snap, r, acc));
  return {
    likeForLike: rank(all.filter((e) => e.current && e.previous)),
    added: rank(all.filter((e) => e.current && !e.previous)),
    stopped: rank(all.filter((e) => !e.current && e.previous)),
  };
}

/** Ad-level changes, the spend share that went to brand-new ads, and ads whose CTR fell while frequency is high. */
export function creativeChanges(snap: MetaAuditSnapshot): {
  ads: EntityChange[];
  newAdsSpendSharePct: number | null;
  fatigue: Array<{ adId: string; name: string; frequency7d: number; ctrCurrent: number; ctrPrevious: number }>;
} {
  const ads = snap.ads ?? [];
  const acc = accountDeltas(snap);
  const changes = rawFor("ad", ads as Row[], objectivesOf(snap)).map((r) => toChange(snap, r, acc));

  const totalCurrent = changes.reduce((s, e) => s + spendOf(e.current), 0);
  const newSpend = changes.filter((e) => e.current && !e.previous).reduce((s, e) => s + spendOf(e.current), 0);
  const newAdsSpendSharePct = totalCurrent > 0 ? (newSpend / totalCurrent) * 100 : null;

  const fatigue: Array<{ adId: string; name: string; frequency7d: number; ctrCurrent: number; ctrPrevious: number }> = [];
  for (const ad of ads) {
    const freq = finite(ad.frequency7d);
    const ctrCurrent = finite(ad.performance?.linkCtr);
    const ctrPrevious = finite(ad.previousPerformance?.linkCtr);
    if (!delivered(ad.performance) || !delivered(ad.previousPerformance)) continue;
    if (freq == null || ctrCurrent == null || ctrPrevious == null || ctrPrevious <= 0) continue;
    if (freq >= 3 && (ctrPrevious - ctrCurrent) / ctrPrevious >= 0.15) {
      fatigue.push({ adId: ad.id, name: ad.name, frequency7d: freq, ctrCurrent, ctrPrevious });
    }
  }
  return { ads: rank(changes), newAdsSpendSharePct, fatigue };
}
