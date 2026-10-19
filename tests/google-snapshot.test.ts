import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleReconnectRequired } from "@/lib/google/oauth";
import { getGoogleDataProvider, type GoogleDataProvider } from "@/lib/google/provider";
import { getMockGoogleDataProvider } from "@/lib/google/mock-provider";
import { loadChannelSnapshot } from "@/lib/google/snapshot";

vi.mock("@/lib/google/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google/provider")>();
  return { ...actual, getGoogleDataProvider: vi.fn(actual.getGoogleDataProvider) };
});

const CT = "client_clicktrends";
const range = { since: "2026-09-19", until: "2026-10-18" };

function override(patch: Partial<GoogleDataProvider>) {
  const base = getMockGoogleDataProvider();
  vi.mocked(getGoogleDataProvider).mockReturnValue({ ...base, ...patch });
}

afterEach(() => vi.mocked(getGoogleDataProvider).mockReset());

describe("mock Google provider", () => {
  it("is plausible against the demo Meta snapshot", async () => {
    const p = getMockGoogleDataProvider();
    const ga4 = await p.ga4CategoryRevenue("properties/demo-ga4", range);
    expect(ga4.method).toBe("item");
    expect(ga4.currency).toBe("USD");
    expect(ga4.rows.map((r) => r.key).sort()).toEqual(["Bar Stools", "Sofas"]);
    const channels = new Set(ga4.byChannel.map((r) => r.channel));
    expect(channels).toEqual(new Set(["paid_social", "paid_search", "other"]));
    const ads = await p.adsPerformance("1112223334", null, range);
    expect(ads.merchantCenterLinked).toBe(true);
    expect(ads.currency).toBe("USD");
    expect(ads.campaigns.map((c) => c.type).sort()).toEqual(["PERFORMANCE_MAX", "SEARCH"]);
    expect(ads.assetGroups[0].name).toBe("Bar Stools");
    expect(ads.shoppingCategories[0].productType).toBe("Bar Stools");
    const gsc = await p.searchDemand("https://clicktrends.example/", range);
    expect(gsc.rows).toHaveLength(2);
    for (const r of gsc.rows) expect(r.topQueries.length).toBeGreaterThanOrEqual(3);
  });
});

describe("loadChannelSnapshot", () => {
  it("returns all three parts for demo ClickTrends", async () => {
    const snap = await loadChannelSnapshot(CT, range);
    expect(snap.mapped).toEqual({ ga4: true, ads: true, gsc: true });
    expect(snap.ga4).not.toBeNull();
    expect(snap.ads).not.toBeNull();
    expect(snap.gsc).not.toBeNull();
    expect(snap.warnings).toEqual([]);
  });

  it("returns nothing for a client with no assets", async () => {
    const snap = await loadChannelSnapshot("client_trafficradius", range);
    expect(snap).toEqual({
      mapped: { ga4: false, ads: false, gsc: false },
      ga4: null, ads: null, gsc: null, warnings: [],
    });
  });

  it("keeps GA4 when Google Ads fails and adds one warning", async () => {
    override({ adsPerformance: async () => { throw new Error("quota exceeded"); } });
    const snap = await loadChannelSnapshot(CT, range);
    expect(snap.ads).toBeNull();
    expect(snap.ga4).not.toBeNull();
    expect(snap.gsc).not.toBeNull();
    expect(snap.warnings).toEqual(["Google Ads: quota exceeded"]);
  });

  it("warns for GA4 and Search Console failures", async () => {
    override({
      ga4CategoryRevenue: async () => { throw new Error("boom"); },
      searchDemand: async () => { throw new Error("denied"); },
    });
    const snap = await loadChannelSnapshot(CT, range);
    expect(snap.warnings).toEqual(["GA4: boom", "Search Console: denied"]);
    expect(snap.ads).not.toBeNull();
  });

  it("copies GA4 warnings as they are", async () => {
    const base = getMockGoogleDataProvider();
    override({ ga4CategoryRevenue: async (...a) => ({ ...(await base.ga4CategoryRevenue(...a)), warnings: ["GA4 grouped rows into (other)"] }) });
    const snap = await loadChannelSnapshot(CT, range);
    expect(snap.warnings).toEqual(["GA4 grouped rows into (other)"]);
    expect(snap.ga4).not.toBeNull();
  });

  it("gives one reconnect warning and no parts when Google needs reconnecting", async () => {
    override({ adsPerformance: async () => { throw new GoogleReconnectRequired(); } });
    const snap = await loadChannelSnapshot(CT, range);
    expect(snap.warnings).toEqual(["Google needs reconnecting — an admin can reconnect under Connections"]);
    expect(snap.ga4).toBeNull();
    expect(snap.ads).toBeNull();
    expect(snap.gsc).toBeNull();
    expect(snap.mapped).toEqual({ ga4: true, ads: true, gsc: true });
  });
});
