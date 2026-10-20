import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { syncGoogleAssets } from "@/lib/google/assets";
import { getMockGoogleDataProvider } from "@/lib/google/mock-provider";
import { getGoogleAccessToken, resetGoogleTokenCache } from "@/lib/google/oauth";
import { getGoogleDataProvider } from "@/lib/google/provider";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const LIVE_ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "cid",
  GOOGLE_OAUTH_CLIENT_SECRET: "csecret",
  GOOGLE_ADS_DEVELOPER_TOKEN: "devtoken",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
};

let fetchMock: ReturnType<typeof vi.fn>;

const asAdmin = () => {
  const p = getDemoStore().profiles.find((x) => x.role === "admin")!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
};

beforeEach(() => {
  resetGoogleTokenCache();
  fetchMock = vi.fn(async () => {
    throw new Error("DEMO_MODE must not call Google");
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(LIVE_ENV)) delete process.env[key];
  resetConfigCache();
});

/** Real Google and Supabase variables set, DEMO_MODE still on (tests/setup.ts). */
function withLiveEnv() {
  Object.assign(process.env, LIVE_ENV);
  resetConfigCache();
}

describe("Google in DEMO_MODE", () => {
  it("reports the seeded demo connection as configured and connected, with no Google variables", async () => {
    asAdmin();
    const { GET } = await import("@/app/api/auth/google/status/route");
    const body = (await (await GET()).json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      configured: true,
      adsConfigured: true,
      connected: true,
      email: "demo@clicktrends.example",
      needsReconnect: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("syncs as a no-op over the demo store: current counts, no warnings, no Google calls", async () => {
    withLiveEnv();
    const before = structuredClone(getDemoStore().googleAssets);
    expect(await syncGoogleAssets()).toEqual({ ga4: 1, ads: 1, gsc: 1, warnings: [] });
    asAdmin();
    const sync = await import("@/app/api/admin/google/sync/route");
    expect((await (await sync.POST()).json()).data).toEqual({ ga4: 1, ads: 1, gsc: 1, warnings: [] });
    expect(getDemoStore().googleAssets).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never uses the live provider or a live token refresh, even with the variables set", async () => {
    withLiveEnv();
    const provider = getGoogleDataProvider();
    const mock = getMockGoogleDataProvider();
    const range = { since: "2026-09-19", until: "2026-10-18" };
    expect(await provider.ga4CategoryRevenue("properties/demo-ga4", range)).toEqual(
      await mock.ga4CategoryRevenue("properties/demo-ga4", range),
    );
    expect(await getGoogleAccessToken()).toBe("demo-google-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists ClickTrends' three mapped assets for the card", async () => {
    asAdmin();
    const list = await import("@/app/api/admin/google/assets/route");
    const assets = (await (await list.GET()).json()).data.assets as Array<Record<string, unknown>>;
    expect(assets.map((a) => [a.kind, a.external_id, a.mapped_client_id])).toEqual([
      ["ga4_property", "properties/demo-ga4", "client_clicktrends"],
      ["ads_customer", "1112223334", "client_clicktrends"],
      ["gsc_site", "https://clicktrends.example/", "client_clicktrends"],
    ]);
    for (const a of assets) expect(a).not.toHaveProperty("raw_metadata");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
