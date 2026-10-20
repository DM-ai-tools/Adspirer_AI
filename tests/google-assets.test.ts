import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { NotFoundError } from "@/lib/errors";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

vi.mock("@/lib/google/ga4", () => ({ listGa4Properties: vi.fn() }));
vi.mock("@/lib/google/ads", () => ({ discoverAdsAccounts: vi.fn() }));
vi.mock("@/lib/google/gsc", () => ({ listGscSites: vi.fn() }));
import { listGa4Properties } from "@/lib/google/ga4";
import { discoverAdsAccounts } from "@/lib/google/ads";
import { listGscSites } from "@/lib/google/gsc";

import { clientGoogleAssets, listGoogleAssets, mapGoogleAsset, syncGoogleAssets } from "@/lib/google/assets";
import { DEMO_CLICKTRENDS_META_ACCOUNT_ID, demoMetaAuditSnapshot } from "@/lib/audit/meta-audit-data";
import { createMockMetaAdsProvider } from "@/lib/adspirer/mock-provider";
import { detectCapabilityGaps } from "@/lib/strategy/meta-capabilities";

const CT = "client_clicktrends";
const TR = "client_trafficradius";

const as = (role: "admin" | "operator") => {
  const p = getDemoStore().profiles.find((x) => x.role === role)!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
  return p;
};
const post = (body: unknown) =>
  new Request("https://app.example.com/api/admin/google/map", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const ga4 = (name = "Shop") => [
  { propertyId: "123", name, accountName: "Shop account", currency: "USD", timezone: "America/New_York" },
];
const ads = () => [
  {
    customerId: "5556667778",
    name: "Shop Ads",
    currency: "USD",
    timezone: "America/New_York",
    loginCustomerId: "9990001112",
    manager: false,
    parentName: "Agency MCC",
  },
];
const sites = () => [
  { siteUrl: "https://shop.example/", permissionLevel: "siteOwner" },
  { siteUrl: "sc-domain:shop.example", permissionLevel: "siteFullUser" },
  { siteUrl: "https://unverified.example/", permissionLevel: "siteUnverifiedUser" },
];

const byExternal = (externalId: string) => getDemoStore().googleAssets.find((a) => a.external_id === externalId);

beforeEach(() => {
  // Discovery is live-only (DEMO_MODE sync is a no-op). Without Supabase variables the
  // demo store still holds the assets, so these tests run discovery against it.
  process.env.DEMO_MODE = "false";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  resetConfigCache();
  vi.mocked(listGa4Properties).mockReset().mockResolvedValue(ga4());
  vi.mocked(discoverAdsAccounts).mockReset().mockResolvedValue(ads());
  vi.mocked(listGscSites).mockReset().mockResolvedValue(sites());
});

afterEach(() => {
  process.env.DEMO_MODE = "true";
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  resetConfigCache();
});

describe("syncGoogleAssets", () => {
  it("upserts all three kinds and a second sync keeps a mapping", async () => {
    expect(await syncGoogleAssets()).toEqual({ ga4: 1, ads: 1, gsc: 2, warnings: [] });

    const property = byExternal("properties/123")!;
    expect(property).toMatchObject({
      kind: "ga4_property",
      name: "Shop",
      parent_name: "Shop account",
      currency: "USD",
      timezone: "America/New_York",
      mapped_client_id: null,
    });
    expect(byExternal("5556667778")).toMatchObject({
      kind: "ads_customer",
      name: "Shop Ads",
      parent_name: "Agency MCC",
      login_customer_id: "9990001112",
    });
    expect(byExternal("https://shop.example/")).toMatchObject({ kind: "gsc_site" });
    expect(byExternal("sc-domain:shop.example")).toMatchObject({ kind: "gsc_site" });
    expect(byExternal("https://unverified.example/")).toBeUndefined();

    await mapGoogleAsset(property.id, TR);
    vi.mocked(listGa4Properties).mockResolvedValue(ga4("Shop renamed"));
    await syncGoogleAssets();

    const again = getDemoStore().googleAssets.filter((a) => a.external_id === "properties/123");
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ id: property.id, name: "Shop renamed", mapped_client_id: TR });
  });

  it("still syncs GA4 and Search Console when Google Ads fails, with a warning", async () => {
    vi.mocked(discoverAdsAccounts).mockRejectedValue(new Error("quota exceeded"));
    const result = await syncGoogleAssets();
    expect(result).toEqual({ ga4: 1, ads: 0, gsc: 2, warnings: ["Google Ads: quota exceeded"] });
    expect(byExternal("properties/123")).toBeDefined();
    expect(byExternal("https://shop.example/")).toBeDefined();
  });

  it("syncs Google Ads with only the OAuth client set (no developer token)", async () => {
    const result = await syncGoogleAssets();
    expect(result.warnings).toEqual([]);
    expect(result.ads).toBeGreaterThan(0);
    expect(discoverAdsAccounts).toHaveBeenCalled();
  });
});

describe("mapGoogleAsset", () => {
  it("mapping a second GA4 property to ClickTrends unmaps the first", async () => {
    await syncGoogleAssets();
    const seeded = byExternal("properties/demo-ga4")!;
    expect(seeded.mapped_client_id).toBe(CT);

    const mapped = await mapGoogleAsset(byExternal("properties/123")!.id, CT);
    expect(mapped).toMatchObject({ external_id: "properties/123", mapped_client_id: CT });
    expect(byExternal("properties/demo-ga4")!.mapped_client_id).toBeNull();
    // Other kinds stay mapped.
    expect(byExternal("1112223334")!.mapped_client_id).toBe(CT);
    expect((await clientGoogleAssets(CT)).ga4?.external_id).toBe("properties/123");
  });

  it("unmaps with a null client", async () => {
    const seeded = byExternal("properties/demo-ga4")!;
    expect((await mapGoogleAsset(seeded.id, null)).mapped_client_id).toBeNull();
    expect((await clientGoogleAssets(CT)).ga4).toBeNull();
  });

  it("rejects an unknown asset or client as not found", async () => {
    const seeded = byExternal("properties/demo-ga4")!;
    await expect(mapGoogleAsset("nope", CT)).rejects.toBeInstanceOf(NotFoundError);
    await expect(mapGoogleAsset(seeded.id, "client_nope")).rejects.toBeInstanceOf(NotFoundError);
    expect(byExternal("properties/demo-ga4")!.mapped_client_id).toBe(CT);
  });
});

describe("clientGoogleAssets and the demo seed", () => {
  it("returns ClickTrends' three seeded assets in its currency", async () => {
    const currency = getDemoStore().clients.find((c) => c.id === CT)!.currency;
    const assets = await clientGoogleAssets(CT);
    expect(assets.ga4).toMatchObject({ kind: "ga4_property", external_id: "properties/demo-ga4", currency });
    expect(assets.ads).toMatchObject({ kind: "ads_customer", external_id: "1112223334", currency });
    expect(assets.gsc).toMatchObject({ kind: "gsc_site", external_id: "https://clicktrends.example/" });
    expect(await clientGoogleAssets("client_modern_dental")).toEqual({ ga4: null, ads: null, gsc: null });
  });

  it("seeds ClickTrends as an ecommerce client with a granted Meta account", async () => {
    const store = getDemoStore();
    expect(store.clients.find((c) => c.id === CT)!.goals_profile).toMatchObject({
      business_model: "ecommerce",
      target_roas: 4,
      gross_margin_pct: 45,
    });
    expect(store.connectedMetaAccounts.find((a) => a.client_id === CT)!.access_status).toBe("granted");
    expect((await listGoogleAssets()).map((a) => a.external_id).sort()).toEqual(
      ["1112223334", "https://clicktrends.example/", "properties/demo-ga4"],
    );
  });
});

describe("admin Google asset routes", () => {
  it("refuses non-admins on sync, map and assets", async () => {
    as("operator");
    const sync = await import("@/app/api/admin/google/sync/route");
    const map = await import("@/app/api/admin/google/map/route");
    const list = await import("@/app/api/admin/google/assets/route");
    expect((await sync.POST()).status).toBe(403);
    expect((await map.POST(post({ assetId: "x", clientId: null }))).status).toBe(403);
    expect((await list.GET()).status).toBe(403);
    expect(listGa4Properties).not.toHaveBeenCalled();
  });

  it("syncs, lists without raw metadata and maps for an admin", async () => {
    as("admin");
    const sync = await import("@/app/api/admin/google/sync/route");
    const syncRes = await sync.POST();
    expect(syncRes.status).toBe(200);
    expect((await syncRes.json()).data).toEqual({ ga4: 1, ads: 1, gsc: 2, warnings: [] });

    const list = await import("@/app/api/admin/google/assets/route");
    const listed = (await (await list.GET()).json()).data.assets as Array<Record<string, unknown>>;
    expect(listed.length).toBe(getDemoStore().googleAssets.length);
    for (const asset of listed) expect(asset).not.toHaveProperty("raw_metadata");

    const target = byExternal("properties/123")!;
    const map = await import("@/app/api/admin/google/map/route");
    const res = await map.POST(post({ assetId: target.id, clientId: CT }));
    expect(res.status).toBe(200);
    const { asset } = (await res.json()).data;
    expect(asset).toMatchObject({ id: target.id, mapped_client_id: CT });
    expect(asset).not.toHaveProperty("raw_metadata");
    expect(byExternal("properties/demo-ga4")!.mapped_client_id).toBeNull();
  });

  it("returns 404 for an unknown asset and 400 for a bad body", async () => {
    as("admin");
    const map = await import("@/app/api/admin/google/map/route");
    expect((await map.POST(post({ assetId: "nope", clientId: CT }))).status).toBe(404);
    expect((await map.POST(post({ assetId: "" }))).status).toBe(400);
  });
});

describe("ClickTrends ecommerce demo snapshot", () => {
  it("has ads on the bar stools and sofas collections with purchase ROAS", async () => {
    const currency = getDemoStore().clients.find((c) => c.id === CT)!.currency;
    const snap = await createMockMetaAdsProvider().getAuditSnapshot(DEMO_CLICKTRENDS_META_ACCOUNT_ID);
    expect(snap.account.currency).toBe(currency);

    const barStools = snap.ads.filter((a) => a.linkUrl?.includes("/collections/bar-stools"));
    expect(barStools.length).toBeGreaterThan(0);
    for (const ad of barStools) expect(ad.performance?.roas).not.toBeNull();
    expect(snap.ads.some((a) => a.linkUrl?.includes("/collections/sofas") && a.performance?.roas != null)).toBe(true);
    expect(snap.totals?.resultLabel).toBe("Purchases");

    const states = Object.fromEntries(detectCapabilityGaps(snap, "ecommerce").map((c) => [c.id, c.state]));
    expect(states.advantage_plus_sales).toBe("in_use");
    expect(states.website_retargeting).toBe("in_use");
  });

  it("leaves the Modern Dental snapshot as it was", () => {
    const snap = demoMetaAuditSnapshot("act_100200300", "Modern Dental Centre — Main", 30);
    expect(snap.campaigns.map((c) => c.name)).toEqual([
      "Implants | Leads | Broad | Oct",
      "Veneers Advantage+",
      "Brand | Retargeting | Visitors",
    ]);
    expect(snap.ads.map((a) => a.id)).toEqual(["ad_1", "ad_2", "ad_3", "ad_4", "ad_5", "ad_6"]);
    expect(snap.totals).toMatchObject({ spendCents: 388_000, results: 92, resultLabel: "Leads", roas: null });
    expect(snap.account.currency).toBe("USD");
  });
});
