import { describe, expect, it } from "vitest";
import {
  demoMetaAuditSnapshot,
  type AuditChange,
  type MetaAuditSnapshot,
  type PeriodPerformance,
} from "@/lib/audit/meta-audit-data";
import { SHARED_ANALYSIS_RULES, businessTypeOf } from "@/lib/analysis/shared-rules";
import {
  measurementBreaks,
  measurementCaveats,
  renderMeasurementEvidence,
} from "@/lib/analysis/measurement";

const LIMITATION =
  "Meta's activity history may not record every attribution or dataset edit, and earlier ad set attribution settings can't be recovered.";

function perf(over: Partial<PeriodPerformance> = {}): PeriodPerformance {
  return {
    spendCents: 100_000,
    impressions: 10_000,
    reach: 8_000,
    frequency: 1.2,
    linkCtr: 1,
    cpmCents: 1000,
    results: 10,
    resultLabel: "results",
    costPerResultCents: 10_000,
    roas: null,
    ...over,
  };
}

/** A small snapshot with two campaigns (sales, leads) and the given spend split and totals. */
function snap(opts: {
  salesSpend: number;
  leadsSpend: number;
  purchases?: number | null;
  leads?: number | null;
}): MetaAuditSnapshot {
  const base = demoMetaAuditSnapshot("act_1", "Test", 30);
  const [c1, c2] = base.campaigns;
  return {
    ...base,
    totals: perf({
      spendCents: opts.salesSpend + opts.leadsSpend,
      purchases: opts.purchases ?? null,
      leads: opts.leads ?? null,
    }),
    campaigns: [
      { ...c1, objective: "OUTCOME_SALES", performance: perf({ spendCents: opts.salesSpend }) },
      { ...c2, objective: "OUTCOME_LEADS", performance: perf({ spendCents: opts.leadsSpend }) },
    ],
    changes: [],
  };
}

function change(over: Partial<AuditChange>): AuditChange {
  return {
    time: "2026-10-10T10:00:00Z",
    localDate: "2026-10-10",
    eventType: "update_ad_set_budget",
    label: null,
    actor: null,
    application: null,
    objectType: "AD_SET",
    objectId: "1",
    objectName: "Set A",
    campaignId: null,
    detail: null,
    ...over,
  };
}

describe("SHARED_ANALYSIS_RULES", () => {
  it("carries the nine rules and the ID schemes", () => {
    expect(SHARED_ANALYSIS_RULES).toContain("[Observed]");
    expect(SHARED_ANALYSIS_RULES).toContain("MEASUREMENT BREAK");
    expect(SHARED_ANALYSIS_RULES).toContain("9. ");
    for (const id of ["AUD-###", "CMP-###", "STR-###", "SF-###"]) {
      expect(SHARED_ANALYSIS_RULES).toContain(id);
    }
    expect(SHARED_ANALYSIS_RULES).not.toContain("input JSON");
  });
});

describe("businessTypeOf", () => {
  const s = snap({ salesSpend: 50_000, leadsSpend: 50_000, purchases: 5, leads: 5 });

  it("maps the stated business model first", () => {
    expect(businessTypeOf(s, "ecommerce")).toBe("ecom");
    expect(businessTypeOf(s, "lead_gen")).toBe("leadgen");
    expect(businessTypeOf(s, "local_service")).toBe("leadgen");
    expect(businessTypeOf(s, "b2b")).toBe("leadgen");
  });

  it("reads purchases only as ecom and leads only as leadgen", () => {
    expect(businessTypeOf(snap({ salesSpend: 90_000, leadsSpend: 10_000, purchases: 5 }), undefined)).toBe("ecom");
    expect(businessTypeOf(snap({ salesSpend: 10_000, leadsSpend: 90_000, leads: 5 }), undefined)).toBe("leadgen");
  });

  it("calls it hybrid when both exist and each objective has at least 10% of spend", () => {
    expect(businessTypeOf(s, undefined)).toBe("hybrid");
    expect(businessTypeOf(snap({ salesSpend: 90_000, leadsSpend: 10_000, purchases: 5, leads: 5 }), undefined)).toBe("hybrid");
  });

  it("does not call it hybrid when one objective is a sliver of spend", () => {
    expect(businessTypeOf(snap({ salesSpend: 95_000, leadsSpend: 5_000, purchases: 5, leads: 5 }), undefined)).toBe("ecom");
  });
});

describe("measurementBreaks", () => {
  it("flags attribution, optimisation and pixel edits, and tags the window", () => {
    const s: MetaAuditSnapshot = {
      ...snap({ salesSpend: 1, leadsSpend: 1 }),
      period: { days: 7, since: "2026-10-08", until: "2026-10-14" },
      previousPeriod: { since: "2026-10-01", until: "2026-10-07" },
      changes: [
        change({ localDate: "2026-10-03", eventType: "update_ad_set_optimization_goal", label: "Optimization goal changed" }),
        change({ localDate: "2026-10-10", eventType: "update_ad_set_run_status", detail: '{"attribution_spec":"7d_click"}' }),
        change({ localDate: "2026-10-11", eventType: "update_ad_set_budget" }),
        change({ localDate: "2026-10-12", eventType: "edit_pixel_settings", objectName: "Main pixel" }),
      ],
    };
    const breaks = measurementBreaks(s);
    expect(breaks.map((b) => [b.date, b.window])).toEqual([
      ["2026-10-03", "previous"],
      ["2026-10-10", "current"],
      ["2026-10-12", "current"],
    ]);
    expect(breaks[0].what).toBe("Optimization goal changed");
    expect(breaks[2].objectName).toBe("Main pixel");
  });

  it("returns nothing when no history was loaded", () => {
    const s = { ...snap({ salesSpend: 1, leadsSpend: 1 }), changes: undefined };
    expect(measurementBreaks(s)).toEqual([]);
  });
});

describe("measurementCaveats", () => {
  function withWindows(a: string[], b: string[], statusB = "ACTIVE"): MetaAuditSnapshot {
    const s = snap({ salesSpend: 1, leadsSpend: 1 });
    const [set1, set2] = s.adSets;
    return {
      ...s,
      adSets: [
        { ...set1, campaignId: s.campaigns[0].id, status: "ACTIVE", attributionWindows: a },
        { ...set2, campaignId: s.campaigns[0].id, status: statusB, attributionWindows: b },
      ],
    };
  }

  it("returns one caveat when active ad sets in one objective differ", () => {
    const caveats = measurementCaveats(withWindows(["7d_click"], ["1d_click"]));
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain("OUTCOME_SALES");
  });

  it("returns none when windows match or the other set is paused", () => {
    expect(measurementCaveats(withWindows(["7d_click"], ["7d_click"]))).toEqual([]);
    expect(measurementCaveats(withWindows(["7d_click"], ["1d_click"], "PAUSED"))).toEqual([]);
  });
});

describe("renderMeasurementEvidence", () => {
  it("always includes the heading and the limitation line", () => {
    const out = renderMeasurementEvidence({ ...snap({ salesSpend: 1, leadsSpend: 1 }), adSets: [], changes: [] });
    expect(out).toContain("### Measurement settings");
    expect(out).toContain(LIMITATION);
  });

  it("lists breaks and settings when present", () => {
    const s = snap({ salesSpend: 1, leadsSpend: 1 });
    const out = renderMeasurementEvidence({
      ...s,
      adSets: [{ ...s.adSets[0], status: "ACTIVE", attributionWindows: ["7d_click"], optimizationGoal: "OFFSITE_CONVERSIONS" }],
      changes: [change({ eventType: "update_ad_set_optimization_goal" })],
    });
    expect(out).toContain("7d_click");
    expect(out).toContain("OFFSITE_CONVERSIONS");
    expect(out).toContain("MEASUREMENT BREAK");
    expect(out).toContain(LIMITATION);
  });
});
