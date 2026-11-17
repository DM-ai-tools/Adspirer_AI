import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot, fetchMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";

type Params = Record<string, unknown>;

function fakeGraph(options: { failPreviousCountry?: boolean; failCurrentAge?: boolean; failPreviousAds?: boolean } = {}) {
  const calls: Array<{ path: string; params: Params }> = [];
  const insight = (extra: Params, spend: string, leads: string) => ({
    ...extra,
    spend,
    impressions: "1000",
    reach: "800",
    frequency: "1.25",
    inline_link_click_ctr: "1.1",
    inline_link_clicks: "11",
    cpm: "10",
    results: [{ indicator: "actions:onsite_conversion.lead_grouped", values: [{ value: leads }] }],
  });
  const graph = {
    get: async <T,>(path: string, params: Params = {}): Promise<T> => {
      calls.push({ path, params });
      const previous = String(params.time_range ?? "").includes("2026-10-17");
      const spend = previous ? "100" : "120";
      const leads = previous ? "2" : "6";
      if (path === "act_1") return { name: "TR", currency: "USD", timezone_name: "Australia/Sydney", account_status: 1 } as T;
      if (path === "act_1/campaigns") return { data: [{ id: "c1", name: "TR | Lead Gen", objective: "OUTCOME_LEADS", effective_status: "ACTIVE" }] } as T;
      if (path === "act_1/adsets") return { data: [{ id: "a1", name: "Broad", campaign_id: "c1", effective_status: "ACTIVE" }] } as T;
      if (path === "act_1/ads") {
        return { data: [{ id: "ad1", name: "Ad one", adset_id: "a1", campaign_id: "c1", effective_status: "ACTIVE" }] } as T;
      }
      if (path !== "act_1/insights") return { data: [] } as T;
      const breakdowns = params.breakdowns as string | undefined;
      if (breakdowns === "age,gender") {
        if (previous === false && options.failCurrentAge) throw new Error("age failed");
        return { data: [insight({ age: "25-34", gender: "female" }, spend, leads)] } as T;
      }
      if (breakdowns === "publisher_platform,platform_position") {
        return { data: [insight({ publisher_platform: "instagram", platform_position: "feed" }, spend, leads)] } as T;
      }
      if (breakdowns === "country") {
        if (previous && options.failPreviousCountry) throw new Error("country failed");
        return { data: [insight({ country: "AU" }, spend, leads)] } as T;
      }
      if (breakdowns === "impression_device") {
        return { data: [insight({ impression_device: "mobile_app" }, spend, leads)] } as T;
      }
      if (breakdowns) return { data: [] } as T;
      if (params.level === "ad" && params.time_range) {
        if (previous && options.failPreviousAds) throw new Error("ads failed");
        return { data: [insight({ ad_id: "ad1" }, spend, leads)] } as T;
      }
      if (params.level === "campaign") return { data: [insight({ campaign_id: "c1" }, spend, leads)] } as T;
      if (params.level === "adset" && params.time_range) return { data: [insight({ adset_id: "a1" }, spend, leads)] } as T;
      if (params.level === "account") return { data: [insight({ account_id: "act_1" }, spend, leads)] } as T;
      return { data: [] } as T;
    },
  };
  return { graph, calls };
}

const range = {
  since: "2026-10-19",
  until: "2026-10-20",
  compareSince: "2026-10-17",
  compareUntil: "2026-10-18",
};
const isPrevious = (c: { params: Params }) => String(c.params.time_range ?? "").includes("2026-10-17");

describe("comparison-only snapshot data", () => {
  it("makes none of the extra calls without comparisonDetail", async () => {
    const { graph, calls } = fakeGraph();
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", range);
    expect(calls.some((c) => c.params.breakdowns === "country" || c.params.breakdowns === "impression_device")).toBe(false);
    expect(calls.some((c) => c.params.level === "ad" && isPrevious(c))).toBe(false);
    expect(calls.some((c) => c.params.breakdowns === "age,gender" && isPrevious(c))).toBe(false);
    expect(snap.comparisonBreakdowns).toBeUndefined();
    expect(snap.ads[0]!.previousPerformance).toBeUndefined();
  });

  it("with comparisonDetail, ads carry previous figures and all four breakdowns load for both windows", async () => {
    const { graph } = fakeGraph();
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { ...range, comparisonDetail: true });
    expect(snap.ads[0]!.previousPerformance?.spendCents).toBe(10_000);
    expect(snap.ads[0]!.performance?.spendCents).toBe(12_000);
    expect(snap.comparisonFailures).toBeUndefined();
    const dims = snap.comparisonBreakdowns!;
    expect(dims.map((d) => d.dimension).sort()).toEqual(["age_gender", "country", "device", "placement"]);
    const byDim = Object.fromEntries(dims.map((d) => [d.dimension, d]));
    expect(byDim.age_gender!.current![0]!.key).toBe("25-34 · female");
    expect(byDim.placement!.previous![0]!.key).toBe("instagram · feed");
    expect(byDim.country!.current![0]!.key).toBe("AU");
    expect(byDim.device!.previous![0]!.key).toBe("mobile_app");
    expect(byDim.country!.current![0]!.performance.spendCents).toBe(12_000);
    expect(byDim.country!.previous![0]!.performance.spendCents).toBe(10_000);
  });

  it("comparisonDetail implies a comparison even when compare is false", async () => {
    const { graph } = fakeGraph();
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { ...range, compare: false, comparisonDetail: true });
    expect(snap.previousTotals).toBeTruthy();
    expect(snap.comparisonBreakdowns).toHaveLength(4);
  });

  it("reuses the current-window age/gender and placement position calls", async () => {
    const { graph, calls } = fakeGraph();
    await fetchMetaAuditSnapshot(graph, "act_1", { ...range, comparisonDetail: true });
    const current = (b: string) => calls.filter((c) => c.params.breakdowns === b && !isPrevious(c));
    expect(current("age,gender")).toHaveLength(1);
    expect(current("publisher_platform,platform_position")).toHaveLength(1);
  });

  it("a failed previous country call leaves previous null and is named", async () => {
    const { graph } = fakeGraph({ failPreviousCountry: true });
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { ...range, comparisonDetail: true });
    const country = snap.comparisonBreakdowns!.find((d) => d.dimension === "country")!;
    expect(country.previous).toBeNull();
    expect(country.current).not.toBeNull();
    expect(snap.comparisonFailures).toContain("breakdowns");
    expect(snap.warnings.join(" ")).toMatch(/country/i);
  });

  it("a failed current breakdown nulls that dimension's current", async () => {
    const { graph } = fakeGraph({ failCurrentAge: true });
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { ...range, comparisonDetail: true });
    const age = snap.comparisonBreakdowns!.find((d) => d.dimension === "age_gender")!;
    expect(age.current).toBeNull();
    expect(snap.comparisonFailures).toContain("breakdowns");
  });

  it("failed previous ad insights are named and ads get no previous figures", async () => {
    const { graph } = fakeGraph({ failPreviousAds: true });
    const snap = await fetchMetaAuditSnapshot(graph, "act_1", { ...range, comparisonDetail: true });
    expect(snap.comparisonFailures).toContain("ads");
    expect(snap.ads[0]!.previousPerformance).toBeUndefined();
  });

  it("demo snapshot with comparisonDetail has ad previous figures and four dimensions", () => {
    for (const account of ["act_400500600", "act_700800900"]) {
      const snap = demoMetaAuditSnapshot(account, "Demo", { days: 30, comparisonDetail: true });
      const withPrev = snap.ads.filter((a) => a.performance);
      expect(withPrev.length).toBeGreaterThan(0);
      expect(withPrev.every((a) => a.previousPerformance)).toBe(true);
      const dims = snap.comparisonBreakdowns!;
      expect(dims.map((d) => d.dimension).sort()).toEqual(["age_gender", "country", "device", "placement"]);
      for (const d of dims) {
        expect(d.current!.length).toBeGreaterThan(0);
        expect(d.previous!.length).toBeGreaterThan(0);
      }
    }
    const plain = demoMetaAuditSnapshot("act_400500600", "Demo", { days: 30 });
    expect(plain.comparisonBreakdowns).toBeUndefined();
    expect(plain.ads[0]!.previousPerformance).toBeUndefined();
  });

  it("demo withoutComparison drops ad previous figures and breakdowns", () => {
    const snap = demoMetaAuditSnapshot("act_400500600", "Demo", { days: 30, compare: false });
    expect(snap.comparisonBreakdowns).toBeUndefined();
    expect(snap.ads.every((a) => a.previousPerformance === undefined)).toBe(true);
  });
});
