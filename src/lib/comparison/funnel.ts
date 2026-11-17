import type { MetaAuditSnapshot, PeriodPerformance } from "@/lib/audit/meta-audit-data";
import type { BusinessType } from "@/lib/analysis/shared-rules";

export type FunnelStep = {
  step: string;
  current: number | null;
  previous: number | null;
  /** This step ÷ the step before it, in the same window; null for the first step or when either side is missing. */
  rateCurrent: number | null;
  ratePrevious: number | null;
  note: string | null;
};

type StepDef = { step: string; read: (p: PeriodPerformance) => number | null | undefined };

const IMPRESSIONS: StepDef = { step: "impressions", read: (p) => p.impressions };
const LINK_CLICKS: StepDef = { step: "link clicks", read: (p) => p.linkClicks };

const ECOM_STEPS: StepDef[] = [
  IMPRESSIONS,
  LINK_CLICKS,
  { step: "landing page views", read: (p) => p.landingPageViews },
  { step: "add to cart", read: (p) => p.addToCart },
  { step: "initiate checkout", read: (p) => p.initiateCheckout },
  { step: "purchases", read: (p) => p.purchases },
];

const LEADGEN_STEPS: StepDef[] = [
  IMPRESSIONS,
  LINK_CLICKS,
  // Meta returns no form opens today.
  { step: "form opens", read: () => null },
  { step: "leads", read: (p) => p.leads },
];

function finite(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function rate(value: number | null, base: number | null): number | null {
  if (value == null || base == null || base === 0) return null;
  const r = (value / base) * 100;
  return Number.isFinite(r) ? r : null;
}

function buildSteps(defs: StepDef[], cur: PeriodPerformance | null | undefined, prev: PeriodPerformance | null | undefined): FunnelStep[] {
  const values = defs.map((d) => ({
    current: cur ? finite(d.read(cur)) : null,
    previous: prev ? finite(d.read(prev)) : null,
  }));
  return defs.map((d, i) => {
    const v = values[i];
    const before = i > 0 ? values[i - 1] : null;
    const noData = v.current == null && v.previous == null;
    const rateCurrent = before ? rate(v.current, before.current) : null;
    const ratePrevious = before ? rate(v.previous, before.previous) : null;
    // More of a later step than the one before it happens when Meta attributes them separately
    // (a purchase can be credited without a tracked checkout); it is not a conversion rate.
    const over = [rateCurrent, ratePrevious].some((r) => r != null && r > 100);
    return {
      step: d.step,
      current: v.current,
      previous: v.previous,
      rateCurrent,
      ratePrevious,
      note: noData
        ? `Not available — Meta returned no ${d.step}`
        : over && i > 0
          ? `Over 100%: more ${d.step} than ${defs[i - 1].step}; attribution artefact, not a conversion rate`
          : null,
    };
  });
}

/** Ecommerce and/or lead-gen funnels for both windows; a hybrid account gets both. */
export function funnelsOf(snap: MetaAuditSnapshot, type: BusinessType): Array<{ kind: "ecom" | "leadgen"; steps: FunnelStep[] }> {
  const out: Array<{ kind: "ecom" | "leadgen"; steps: FunnelStep[] }> = [];
  if (type === "ecom" || type === "hybrid") out.push({ kind: "ecom", steps: buildSteps(ECOM_STEPS, snap.totals, snap.previousTotals) });
  if (type === "leadgen" || type === "hybrid") out.push({ kind: "leadgen", steps: buildSteps(LEADGEN_STEPS, snap.totals, snap.previousTotals) });
  return out;
}
