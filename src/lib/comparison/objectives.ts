import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { objectiveGroup } from "@/lib/analysis/shared-rules";

export type ObjectiveGroup = "sales" | "leads" | "other";

export type ObjectiveMix = {
  /** Share of current campaign spend per objective group, largest first (sales, leads, other on ties). */
  shares: Array<{ group: ObjectiveGroup; sharePct: number }>;
  /** True when no group carries this share or more, so Results and Cost per result mix objectives. */
  blended: boolean;
};

/** One objective "owns" the account's results when it carries at least this share of spend. */
export const SINGLE_OBJECTIVE_SHARE = 0.9;

const ORDER: ObjectiveGroup[] = ["sales", "leads", "other"];

/**
 * Stopgap until KPI rows are split per objective: how current spend splits between sales, leads
 * and every other objective, from the campaign rows. Null when no campaign spent.
 */
export function objectiveMix(snap: MetaAuditSnapshot): ObjectiveMix | null {
  const spend = new Map<ObjectiveGroup, number>();
  let total = 0;
  for (const c of snap.campaigns ?? []) {
    const s = c.performance?.spendCents ?? 0;
    if (!(s > 0)) continue;
    const g = objectiveGroup(c.objective ?? "");
    const group: ObjectiveGroup = g === "sales" || g === "leads" ? g : "other";
    spend.set(group, (spend.get(group) ?? 0) + s);
    total += s;
  }
  if (total <= 0) return null;
  const shares = ORDER.filter((g) => spend.has(g))
    .map((group) => ({ group, sharePct: ((spend.get(group) ?? 0) / total) * 100 }))
    .sort((a, b) => b.sharePct - a.sharePct || ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
  return { shares, blended: !shares.some((s) => s.sharePct >= SINGLE_OBJECTIVE_SHARE * 100) };
}
