import { describe, expect, it } from "vitest";
import { evaluateCheckpoints, weightedAreaScore, type Checkpoint } from "@/lib/audit/checkpoints";
import { demoMetaAuditSnapshot, type MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { resolveGoals, type GoalsProfile } from "@/lib/clients/goals";

const snap = (): MetaAuditSnapshot => demoMetaAuditSnapshot("act_1", "Demo", 30);
const run = (s: MetaAuditSnapshot, profile: GoalsProfile = {}) =>
  evaluateCheckpoints(s, { goals: resolveGoals({ goals_profile: profile }) });
const get = (cps: Checkpoint[], id: string) => cps.find((c) => c.id === id);

describe("coverage-based grading", () => {
  it("grades an account with enough data", () => {
    const card = run(snap(), { target_cpa_cents: 6000 });
    expect(card.coverage).toBeGreaterThanOrEqual(0.8);
    expect(card.gradeStatus).toBe("graded");
  });

  it("gives no grade (not 100) when almost nothing could be checked", () => {
    const empty: MetaAuditSnapshot = {
      ...snap(),
      totals: null,
      pixels: [],
      audiences: [],
      campaigns: [],
      adSets: [],
      ads: [],
      placements: [],
      account: { ...snap().account, spendCapCents: null },
    };
    const card = run(empty);
    expect(card.gradeStatus).toBe("not_graded");
    expect(card.score).not.toBe(100);
  });

  it("weights areas: tracking 30%, creative 30%, structure 20%, audiences 20%", () => {
    const area = (category: string, score: number) => ({ category, score, possible: 10 }) as never;
    // Tracking 0, everything else 100 → 70.
    expect(
      weightedAreaScore([
        area("Tracking & measurement", 0),
        area("Creative", 100),
        area("Funnel & frequency", 100),
        area("Account structure", 100),
        area("Bidding & budget", 100),
        area("Audiences & targeting", 100),
      ]),
    ).toBe(70);
  });
});

describe("checks measured against the client's goals", () => {
  it("B6: flags ad sets whose daily budget can't reach 50 results a week at the target cost", () => {
    const b6 = get(run(snap(), { target_cpa_cents: 500 }).checkpoints, "B6")!; // needs $35.71/day
    expect(b6.status).toBe("warn");
    expect(b6.evidence).toMatch(/Implants – Interests: dental/);
    expect(b6.evidence).not.toMatch(/Broad AU/);
    expect(get(run(snap()).checkpoints, "B6")?.status).toBe("not_checked");
  });

  it("B7: compares cost per result with the client's target", () => {
    // Demo account: $3,880 for 92 results = $42.17 per result.
    expect(get(run(snap(), { target_cpa_cents: 6000 }).checkpoints, "B7")?.status).toBe("pass");
    expect(get(run(snap(), { target_cpa_cents: 3000 }).checkpoints, "B7")?.status).toBe("warn");
    expect(get(run(snap(), { target_cpa_cents: 2000 }).checkpoints, "B7")?.status).toBe("fail");
    expect(get(run(snap()).checkpoints, "B7")?.status).toBe("not_checked");
  });

  it("F3: judges ROAS only for e-commerce or a ROAS target, against the client's target", () => {
    expect(get(run(snap()).checkpoints, "F3")).toBeUndefined();
    const s = snap();
    s.adSets[0]!.performance = { ...s.adSets[0]!.performance!, roas: 2.5 };
    expect(get(run(s, { target_roas: 2 }).checkpoints, "F3")?.status).toBe("pass");
    expect(get(run(s, { target_roas: 3 }).checkpoints, "F3")?.status).toBe("warn");
  });

  it("F2: uses the client's frequency limits", () => {
    const s = snap();
    s.adSets[0]!.frequency7d = 2.8; // prospecting
    expect(get(run(s).checkpoints, "F2")?.evidence).not.toMatch(/Implants – Broad AU 30-65 \(2\.8/);
    expect(get(run(s, { policy: { prospecting_frequency_max: 2.5 } }).checkpoints, "F2")?.evidence).toMatch(/Implants – Broad AU 30-65 \(2\.8/);
  });
});

describe("structure and tracking checks", () => {
  it("B1: rates the share of learning-limited ad sets", () => {
    const s = snap(); // 1 of 4 limited → 25%
    expect(get(run(s).checkpoints, "B1")?.status).toBe("pass");
    s.adSets[0]!.learningStatus = "FAIL"; // 2 of 4
    expect(get(run(s).checkpoints, "B1")?.status).toBe("warn");
    s.adSets[2]!.learningStatus = "FAIL"; // 3 of 4
    expect(get(run(s).checkpoints, "B1")?.status).toBe("fail");
  });

  it("S5: fails a disabled or restricted ad account", () => {
    const s = snap();
    expect(get(run(s).checkpoints, "S5")?.status).toBe("pass");
    s.account = { ...s.account, statusCode: 2, disableReason: "Reason 1" };
    const s5 = get(run(s).checkpoints, "S5")!;
    expect(s5.status).toBe("fail");
    expect(s5.severity).toBe("critical");
  });

  it("T4: rates how much of the tracking is server-side", () => {
    const s = snap();
    const share = (v: number) => {
      s.pixels[0]!.stats7d = { ...s.pixels[0]!.stats7d!, serverShare: v };
      return get(run(s).checkpoints, "T4")?.status;
    };
    expect(share(0)).toBe("fail");
    expect(share(0.2)).toBe("warn");
    expect(share(0.5)).toBe("pass");
  });

  it("A2: counts website audiences as exclusion candidates too", () => {
    const s = snap();
    s.audiences = s.audiences.filter((a) => a.subtype !== "CUSTOM"); // only website + lookalike left
    expect(get(run(s).checkpoints, "A2")).toBeDefined();
  });

  it("C5: checks every live ad carries UTM tags", () => {
    const s = snap();
    s.ads = s.ads.map((a) => ({ ...a, urlTags: a.id === "ad_1" ? "utm_source=facebook&utm_medium=paid" : null }));
    const c5 = get(run(s).checkpoints, "C5")!;
    expect(c5.status).toBe("warn");
    s.ads = s.ads.map((a) => ({ ...a, urlTags: "utm_source=facebook" }));
    expect(get(run(s).checkpoints, "C5")?.status).toBe("pass");
  });

  it("C6: flags live ads Meta ranks below average", () => {
    const s = snap();
    s.ads = s.ads.map((a) => (a.id === "ad_2" ? { ...a, rankings: { quality: "BELOW_AVERAGE_20", engagement: "AVERAGE", conversion: "AVERAGE" } } : a));
    const c6 = get(run(s).checkpoints, "C6")!;
    expect(c6.status).toBe("warn");
    expect(c6.evidence).toMatch(/Implants – Doctor intro/);
  });

  it("F5: flags a big drop between link clicks and landing page views", () => {
    const s = snap();
    s.totals = { ...s.totals!, linkClicks: 1000, landingPageViews: 450 };
    expect(get(run(s).checkpoints, "F5")?.status).toBe("warn");
    s.totals = { ...s.totals!, linkClicks: 1000, landingPageViews: 850 };
    expect(get(run(s).checkpoints, "F5")?.status).toBe("pass");
  });
});
