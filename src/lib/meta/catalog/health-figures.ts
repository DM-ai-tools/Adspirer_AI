import type { CatalogFinding } from "./findings";
import type { CatalogDiagnostic, CatalogFeed } from "./types";

const OUT_OF_STOCK = /OUT_OF_STOCK/i;
const REJECTED = /NOT_APPROVED|POLICY|REJECT/i;

export type ProblemFigures = {
  /** Items Meta rejected (not approved, policy or rejection issues). */
  rejected: number;
  /** Other must-fix items that are neither out of stock nor rejected (empty title, image fetch failed, ...). */
  otherProblems: number;
};

/**
 * Splits the diagnostics' child issues into rejected and other must-fix problems. Only child
 * figures are summed; a parent's own count is never used, because a parent mixes issue kinds.
 * Out-of-stock children are left to the out-of-stock figure.
 */
export function problemFigures(diagnostics: CatalogDiagnostic[]): ProblemFigures {
  let rejected = 0;
  let otherProblems = 0;
  for (const d of diagnostics) {
    for (const c of d.children) {
      if (c.affectedItems <= 0 || OUT_OF_STOCK.test(c.type)) continue;
      if (REJECTED.test(c.type)) rejected += c.affectedItems;
      else if (d.severity === "MUST_FIX") otherProblems += c.affectedItems;
    }
  }
  return { rejected, otherProblems };
}

export type FeedHealth = {
  value: string;
  hint: string;
  tone: "success" | "warning" | "default";
};

/**
 * Feed card state, derived from the feeds themselves. The stale and upload-error checks skip
 * feeds with no upload or no schedule, so "Healthy" is only claimed when every feed has both.
 * A real stale/error finding outranks the "not scheduled" and "no uploads" notes.
 */
export function feedHealth(feeds: CatalogFeed[], findings: Pick<CatalogFinding, "id">[]): FeedHealth {
  if (feeds.length === 0) {
    return { value: "No feed", hint: "Products are synced from your store", tone: "default" };
  }
  if (findings.some((f) => f.id.startsWith("feed_"))) {
    return { value: "Needs attention", hint: "Your product list is stale or has upload errors", tone: "warning" };
  }
  if (feeds.some((f) => f.lastUpload === null)) {
    return { value: "No uploads yet", hint: "Meta has not read a product list from this feed", tone: "warning" };
  }
  if (feeds.some((f) => !f.scheduleUrl)) {
    return {
      value: "Not scheduled",
      hint: "This feed has no schedule, so it is not refreshed automatically",
      tone: "warning",
    };
  }
  return { value: "Healthy", hint: "Your product list is uploading on schedule", tone: "success" };
}

/** Matched share (0-1) across all events, or null when Meta reported none. */
export function overallMatchRate(events: Array<{ matched: number; unmatched: number }>): number | null {
  let matched = 0;
  let total = 0;
  for (const e of events) {
    matched += e.matched;
    total += e.matched + e.unmatched;
  }
  return total > 0 ? matched / total : null;
}
