import type { PeriodPerformance } from "@/lib/audit/meta-audit-data";
import type { BusinessType } from "@/lib/analysis/shared-rules";

export type BridgeEffect = {
  driver: "CPM" | "CTR" | "CVR" | "AOV" | "Volume";
  value: number;
  shareOfChangePct: number;
};

export type Bridge =
  | {
      metric: "cost per result" | "results" | "purchase value";
      previous: number;
      current: number;
      change: number;
      effects: BridgeEffect[];
    }
  | { metric: string; unavailable: string };

type Driver = BridgeEffect["driver"];
type Side = "current" | "previous";

/** A raw count, or the name of the input that is missing/zero. */
type Raw = { value: number } | { missing: string };

function positive(v: number | null | undefined, label: string, side: Side): Raw {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? { value: v }
    : { missing: `${label} (${side} period)` };
}

type Counts = {
  spend: number;
  impressions: number;
  clicks: number;
  results: number;
};

function counts(p: PeriodPerformance, side: Side): Counts | { missing: string } {
  const parts = [
    positive(p.spendCents, "spend", side),
    positive(p.impressions, "impressions", side),
    positive(p.linkClicks, "link clicks", side),
    positive(p.results, "results", side),
  ];
  for (const part of parts) if ("missing" in part) return part;
  const [spend, impressions, clicks, results] = parts.map((x) => (x as { value: number }).value);
  return { spend, impressions, clicks, results };
}

type Factor = { driver: Driver; exponent: 1 | -1; cur: number; prev: number };

/** Log-share attribution: effects add up exactly to y_cur - y_prev. */
function build(
  metric: "cost per result" | "results" | "purchase value",
  yPrev: number,
  yCur: number,
  factors: Factor[],
): Bridge {
  const change = yCur - yPrev;
  if (change === 0 || yCur === yPrev) {
    return {
      metric,
      previous: yPrev,
      current: yCur,
      change: 0,
      effects: factors.map((f) => ({ driver: f.driver, value: 0, shareOfChangePct: 0 })),
    };
  }
  const lnY = Math.log(yCur / yPrev);
  return {
    metric,
    previous: yPrev,
    current: yCur,
    change,
    effects: factors.map((f) => {
      const share = (f.exponent * Math.log(f.cur / f.prev)) / lnY;
      return { driver: f.driver, value: change * share, shareOfChangePct: share * 100 };
    }),
  };
}

export function bridgesOf(cur: PeriodPerformance, prev: PeriodPerformance, type: BusinessType): Bridge[] {
  const out: Bridge[] = [];
  const c = counts(cur, "current");
  const p = counts(prev, "previous");

  const funnelMissing = "missing" in p ? p.missing : "missing" in c ? c.missing : null;
  if (funnelMissing || "missing" in p || "missing" in c) {
    out.push({ metric: "cost per result", unavailable: funnelMissing ?? "inputs missing" });
    out.push({ metric: "results", unavailable: funnelMissing ?? "inputs missing" });
  } else {
    const cpm = (x: Counts) => (x.spend / x.impressions) * 1000;
    const ctr = (x: Counts) => x.clicks / x.impressions;
    const cvr = (x: Counts) => x.results / x.clicks;
    const cpmF: Factor = { driver: "CPM", exponent: 1, cur: cpm(c), prev: cpm(p) };
    const ctrF: Factor = { driver: "CTR", exponent: -1, cur: ctr(c), prev: ctr(p) };
    const cvrF: Factor = { driver: "CVR", exponent: -1, cur: cvr(c), prev: cvr(p) };
    out.push(build("cost per result", p.spend / p.results, c.spend / c.results, [cpmF, ctrF, cvrF]));
    out.push(
      build("results", p.results, c.results, [
        { driver: "Volume", exponent: 1, cur: c.spend, prev: p.spend },
        { ...cpmF, exponent: -1 },
        { ...ctrF, exponent: 1 },
        { ...cvrF, exponent: 1 },
      ]),
    );
  }

  if (type === "ecom" || type === "hybrid") {
    const parts = (["previous", "current"] as const).map((side) => {
      const x = side === "previous" ? prev : cur;
      return [
        positive(x.purchases, "purchases", side),
        positive(x.purchaseValueCents, "purchase value", side),
      ] as const;
    });
    const missing = parts.flat().find((r): r is { missing: string } => "missing" in r);
    if (missing) {
      out.push({ metric: "purchase value", unavailable: missing.missing });
    } else {
      const [[pp, pv], [cp, cv]] = parts as unknown as [
        [{ value: number }, { value: number }],
        [{ value: number }, { value: number }],
      ];
      out.push(
        build("purchase value", pv.value, cv.value, [
          { driver: "Volume", exponent: 1, cur: cp.value, prev: pp.value },
          { driver: "AOV", exponent: 1, cur: cv.value / cp.value, prev: pv.value / pp.value },
        ]),
      );
    }
  }
  return out;
}
