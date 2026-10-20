import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDemoStore } from "@/lib/demo/store";
import { listGoogleAssets } from "@/lib/google/assets";
import { googleAssetsSummary, googleErrorMessage, groupGoogleAssets } from "@/lib/google/assets-view";
import type { GoogleAsset } from "@/lib/google/types";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";
import { GET } from "@/app/api/v2/clients/[clientId]/google-assets/route";

const asset = (kind: GoogleAsset["kind"], name: string): GoogleAsset => ({
  id: `${kind}-${name}`,
  kind,
  external_id: `ext-${name}`,
  name,
  parent_name: null,
  currency: null,
  timezone: null,
  login_customer_id: null,
  mapped_client_id: null,
  raw_metadata: null,
  last_synced_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
});

describe("groupGoogleAssets", () => {
  it("groups by kind and sorts each group by name", () => {
    const grouped = groupGoogleAssets([
      asset("ga4_property", "Zed"),
      asset("gsc_site", "https://b.example/"),
      asset("ga4_property", "Alpha"),
    ]);
    expect(grouped.ga4_property.map((a) => a.name)).toEqual(["Alpha", "Zed"]);
    expect(grouped.gsc_site).toHaveLength(1);
    expect(grouped.ads_customer).toEqual([]);
  });
});

describe("googleErrorMessage", () => {
  it.each(["state_mismatch", "denied", "no_refresh_token", "exchange_failed", "not_admin"])(
    "has plain copy for %s",
    (code) => {
      const text = googleErrorMessage(code);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain(code);
    },
  );
  it("falls back for an unknown code", () => {
    expect(googleErrorMessage("weird")).toMatch(/try again/i);
  });
});

describe("googleAssetsSummary", () => {
  it("lists the mapped assets", () => {
    expect(
      googleAssetsSummary({ ga4: { name: "Store" }, ads: { name: "Ads A" }, gsc: { name: "site.com" } }),
    ).toBe("GA4: Store · Google Ads: Ads A · Search Console: site.com");
  });
  it("lists only what is mapped", () => {
    expect(googleAssetsSummary({ ga4: { name: "Store" }, ads: null, gsc: null })).toBe("GA4: Store");
  });
  it("says so when nothing is mapped", () => {
    expect(googleAssetsSummary({ ga4: null, ads: null, gsc: null })).toBe("Not mapped — map under Connections");
  });
});

describe("GET /api/v2/clients/:clientId/google-assets", () => {
  const as = (role: "admin" | "operator") => {
    const p = getDemoStore().profiles.find((x) => x.role === role)!;
    vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
    return p;
  };
  const call = (clientId: string) =>
    GET(new Request("http://x"), { params: Promise.resolve({ clientId }) });

  beforeEach(() => vi.mocked(getCurrentUser).mockReset());

  it("returns the demo ClickTrends assets without raw_metadata", async () => {
    as("operator");
    const res = await call("client_clicktrends");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const all = await listGoogleAssets();
    const ga4 = all.find((a) => a.mapped_client_id === "client_clicktrends" && a.kind === "ga4_property")!;
    expect(body.data.ga4).toEqual({ name: ga4.name, external_id: ga4.external_id });
    expect(body.data.ads).not.toBeNull();
    expect(body.data.gsc).not.toBeNull();
    expect(JSON.stringify(body)).not.toContain("raw_metadata");
    expect(Object.keys(body.data.ga4).sort()).toEqual(["external_id", "name"]);
  });

  it("returns nulls for a client with nothing mapped", async () => {
    as("admin");
    const other = getDemoStore().clients.find((c) => c.id !== "client_clicktrends")!;
    const body = await (await call(other.id)).json();
    expect(body.data).toEqual({ ga4: null, ads: null, gsc: null });
  });

  it("is 403 for a user without access to the client", async () => {
    const op = as("operator");
    const store = getDemoStore();
    store.userClientAccess = store.userClientAccess.filter(
      (a) => !(a.user_id === op.id && a.client_id === "client_clicktrends"),
    );
    const res = await call("client_clicktrends");
    expect(res.status).toBe(403);
  });

  it("is 401 when signed out", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    expect((await call("client_clicktrends")).status).toBe(401);
  });
});
