import { describe, expect, it } from "vitest";
import { demoMetaAuditSnapshot, type MetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { META_CAPABILITIES, detectCapabilityGaps } from "@/lib/strategy/meta-capabilities";

const demo = () => demoMetaAuditSnapshot("act_1", "Demo");
const stateOf = (snap: MetaAuditSnapshot, id: string) => META_CAPABILITIES.find((c) => c.id === id)!.detect(snap);

describe("meta capabilities", () => {
  it("demo includes website and lookalike audiences in an ad set", () => {
    const snap = demo();
    const included = new Set(snap.adSets.flatMap((a) => a.includedAudienceIds));
    expect(included.has("aud_web30")).toBe(true);
    expect(included.has("aud_lal")).toBe(true);
    expect(stateOf(snap, "website_retargeting")).toBe("in_use");
    expect(stateOf(snap, "lookalike_audiences")).toBe("in_use");
  });

  it("no VIDEO ads means video_creative is not_used", () => {
    const snap = demo();
    snap.ads = snap.ads.map((a) => ({ ...a, format: "IMAGE" }));
    expect(stateOf(snap, "video_creative")).toBe("not_used");
    expect(stateOf(demo(), "video_creative")).toBe("in_use");
  });

  it("paused zero-spend entities do not count", () => {
    const snap = demo();
    snap.adSets = snap.adSets.map((a) => ({ ...a, status: "PAUSED", performance: null }));
    expect(stateOf(snap, "website_retargeting")).toBe("unknown");
    snap.ads = snap.ads.map((a) => ({ ...a, status: "PAUSED", performance: null }));
    expect(stateOf(snap, "video_creative")).toBe("unknown");
  });

  it("paused ad set with spend still counts", () => {
    const snap = demo();
    snap.adSets = snap.adSets.map((a) => ({ ...a, status: "PAUSED" }));
    expect(stateOf(snap, "website_retargeting")).toBe("in_use");
  });

  it("catalog_ads is unknown without catalog signals", () => {
    expect(stateOf(demo(), "catalog_ads")).toBe("unknown");
  });

  it("detects cost controls and automatic placements", () => {
    expect(stateOf(demo(), "cost_or_roas_controls")).toBe("in_use");
    expect(stateOf(demo(), "automatic_placements")).toBe("not_used");
  });

  it("filters by business model, in catalogue order", () => {
    const lead = detectCapabilityGaps(demo(), "lead_gen").map((c) => c.id);
    expect(lead).not.toContain("advantage_plus_sales");
    expect(lead).not.toContain("catalog_ads");
    expect(lead).toContain("instant_forms");
    const none = detectCapabilityGaps(demo(), undefined).map((c) => c.id);
    const all = META_CAPABILITIES.filter((c) => c.businessModels === "all").map((c) => c.id);
    expect(none).toEqual(all);
  });
});
