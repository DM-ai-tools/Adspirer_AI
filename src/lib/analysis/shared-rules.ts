import type { MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";

/**
 * Rules every analysis writer follows — audit, comparison and strategy — so the three reports
 * label, qualify and number things the same way. Kept as one text block so the frameworks can
 * include it instead of each carrying its own slightly different copy.
 */
export const SHARED_ANALYSIS_RULES = `SHARED RULES (apply to every report)
1. Use only values supplied in the evidence. Never calculate, estimate or invent numbers. If a value is missing, write "Not available" and say why.
2. Label platform data "Meta-reported". Do not call it revenue or profit unless the operator supplied actual revenue.
3. Label every explanation: [Observed] (the data shows it), [Likely] (indirect evidence) or [Hypothesis] (needs testing). Never state a cause as fact unless it is Observed.
4. State the attribution setting and the conversion events used. If an attribution or measurement change falls inside either window, flag a MEASUREMENT BREAK and do not present the affected change as a performance change.
5. Do not blend different campaign objectives into one metric.
6. Show the absolute values next to every percentage. Mark low-volume metrics "Low volume - not a trend".
7. Tone: neutral, specific, plain words, short bullets. Report declines as clearly as wins.
8. Adapt emphasis to the business type:
   - ecom: purchases, purchase value, ROAS, cost per purchase, average order value; funnel through add to cart and checkout.
   - leadgen: leads, cost per lead, cost per qualified lead if CRM data exists; funnel through form open to form submit; warn if cost per lead improved while lead quality declined.
   - hybrid: cover both, kept separate.
9. Findings carry stable IDs shared across reports: AUD-### (audit), CMP-### (comparison), STR-### (strategy actions). When a strategy has no qualifying audit, its own findings are SF-###, never AUD-###.`;

export type BusinessType = "ecom" | "leadgen" | "hybrid";

/** Campaign objectives grouped the way the report never blends them. */
function objectiveGroup(objective: string): string {
  const o = objective.toUpperCase();
  if (o === "OUTCOME_SALES" || o === "CONVERSIONS" || o === "PRODUCT_CATALOG_SALES") return "sales";
  if (o === "OUTCOME_LEADS" || o === "LEAD_GENERATION") return "leads";
  return o;
}

/** Share of total campaign spend each objective group carries. */
function spendShareByGroup(snapshot: MetaAuditSnapshot): Map<string, number> {
  const spend = new Map<string, number>();
  let total = 0;
  for (const c of snapshot.campaigns) {
    const s = c.performance?.spendCents ?? 0;
    total += s;
    const g = objectiveGroup(c.objective);
    spend.set(g, (spend.get(g) ?? 0) + s);
  }
  const share = new Map<string, number>();
  for (const [g, s] of spend) share.set(g, total > 0 ? s / total : 0);
  return share;
}

/**
 * Ecommerce, lead gen or both. The operator's stated business model wins; without one it is
 * read from the data. "Hybrid" needs both purchases and leads in the totals AND both the sales
 * and the leads objective carrying at least 10% of spend, so a stray lead form doesn't turn a
 * shop into a hybrid.
 */
export function businessTypeOf(
  snapshot: MetaAuditSnapshot,
  businessModel: string | undefined,
): BusinessType {
  if (businessModel === "ecommerce") return "ecom";
  if (businessModel === "lead_gen" || businessModel === "local_service" || businessModel === "b2b") {
    return "leadgen";
  }
  const hasPurchases = (snapshot.totals?.purchases ?? 0) > 0;
  const hasLeads = (snapshot.totals?.leads ?? 0) > 0;
  if (hasPurchases && !hasLeads) return "ecom";
  if (hasLeads && !hasPurchases) return "leadgen";
  if (!hasPurchases && !hasLeads) return "ecom";
  const share = spendShareByGroup(snapshot);
  const sales = share.get("sales") ?? 0;
  const leads = share.get("leads") ?? 0;
  if (sales >= 0.1 && leads >= 0.1) return "hybrid";
  return sales >= leads ? "ecom" : "leadgen";
}
