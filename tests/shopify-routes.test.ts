import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { ConflictError, NotFoundError } from "@/lib/errors";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

vi.mock("@/lib/shopify/sync", () => ({
  connectShopify: vi.fn(),
  syncShopify: vi.fn(),
  disconnectShopify: vi.fn(),
  getShopifyStatus: vi.fn(),
  syncAllShopify: vi.fn(),
}));
import {
  connectShopify,
  syncShopify,
  disconnectShopify,
  getShopifyStatus,
  syncAllShopify,
} from "@/lib/shopify/sync";

const TOKEN = "shpat_supersecret123";
const clientId = () => getDemoStore().clients[0].id;
const as = (role: "admin" | "operator") => {
  const p = getDemoStore().profiles.find((x) => x.role === role)!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
};
const post = (path: string, body: unknown) =>
  new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  resetConfigCache();
  vi.mocked(getCurrentUser).mockReset();
  for (const f of [connectShopify, syncShopify, disconnectShopify, getShopifyStatus, syncAllShopify]) {
    vi.mocked(f).mockReset();
  }
  vi.mocked(connectShopify).mockResolvedValue({ shopName: "Shop", currency: "USD" });
  vi.mocked(syncShopify).mockResolvedValue({
    orders: 4, sales_variants: 3, skipped_line_items: 0,
  });
  vi.mocked(getShopifyStatus).mockResolvedValue({
    connected: true, shop_domain: "a.myshopify.com", shop_name: "Shop", currency: "USD",
    last_sync_at: null, last_sync_status: "ok", last_sync_error: null, counts: null,
  });
});

afterEach(() => {
  delete process.env.CRON_SECRET;
});

const calls = async () => {
  const c = await import("@/app/api/admin/shopify/connect/route");
  const s = await import("@/app/api/admin/shopify/sync/route");
  const d = await import("@/app/api/admin/shopify/disconnect/route");
  const st = await import("@/app/api/admin/shopify/status/route");
  const id = clientId();
  return {
    connect: () => c.POST(post("/api/admin/shopify/connect", { clientId: id, shopDomain: "a.myshopify.com", accessToken: TOKEN })),
    sync: () => s.POST(post("/api/admin/shopify/sync", { clientId: id })),
    disconnect: () => d.POST(post("/api/admin/shopify/disconnect", { clientId: id })),
    status: () => st.GET(new Request(`https://app.example.com/api/admin/shopify/status?clientId=${id}`)),
  };
};

describe("shopify admin routes auth", () => {
  it("403 for non-admins on all four", async () => {
    as("operator");
    const r = await calls();
    for (const k of ["connect", "sync", "disconnect", "status"] as const) {
      expect((await r[k]()).status, k).toBe(403);
    }
    expect(connectShopify).not.toHaveBeenCalled();
  });
  it("401 when unauthenticated on all four", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const r = await calls();
    for (const k of ["connect", "sync", "disconnect", "status"] as const) {
      expect((await r[k]()).status, k).toBe(401);
    }
  });
});

describe("shopify admin routes behaviour", () => {
  it("connect returns shopName and currency, never the token", async () => {
    as("admin");
    const res = await (await calls()).connect();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).data).toEqual({ shopName: "Shop", currency: "USD" });
    expect(connectShopify).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: clientId(), shopDomain: "a.myshopify.com", accessToken: TOKEN }),
    );
  });
  it("bad connect body gives 400/404 without echoing the token", async () => {
    as("admin");
    const { POST } = await import("@/app/api/admin/shopify/connect/route");
    const bodies = [
      { clientId: "", shopDomain: "a.myshopify.com", accessToken: TOKEN },
      { clientId: clientId(), shopDomain: 5, accessToken: TOKEN },
      { clientId: clientId(), shopDomain: TOKEN.repeat(0) + 7, accessToken: "" },
      { clientId: clientId(), shopDomain: "a.myshopify.com", accessToken: TOKEN, extra: TOKEN },
      { clientId: TOKEN, shopDomain: "a.myshopify.com", accessToken: TOKEN },
      { clientId: [TOKEN], shopDomain: "a.myshopify.com", accessToken: TOKEN },
      { clientId: clientId(), shopDomain: { x: TOKEN }, accessToken: TOKEN },
      { clientId: clientId(), shopDomain: "a.myshopify.com", accessToken: { t: TOKEN } },
    ];
    for (const body of bodies) {
      const res = await POST(post("/api/admin/shopify/connect", body));
      expect([400, 404]).toContain(res.status);
      expect(await res.text()).not.toContain(TOKEN);
    }
    expect(connectShopify).not.toHaveBeenCalled();
  });
  it("invalid JSON gives 400", async () => {
    as("admin");
    const { POST } = await import("@/app/api/admin/shopify/connect/route");
    const res = await POST(new Request("https://x/y", { method: "POST", body: "{nope" }));
    expect(res.status).toBe(400);
  });
  it("unknown client gives 404 and no call", async () => {
    as("admin");
    const { POST } = await import("@/app/api/admin/shopify/sync/route");
    const res = await POST(post("/api/admin/shopify/sync", { clientId: "no-such-client" }));
    expect(res.status).toBe(404);
    expect(syncShopify).not.toHaveBeenCalled();
  });
  it("sync returns counts and maps typed errors", async () => {
    as("admin");
    const r = await calls();
    const ok = await r.sync();
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.sales_variants).toBe(3);
    vi.mocked(syncShopify).mockRejectedValueOnce(new NotFoundError("This client has no Shopify store connected."));
    expect((await r.sync()).status).toBe(404);
    vi.mocked(syncShopify).mockRejectedValueOnce(new ConflictError("A sync is already running for this store"));
    expect((await r.sync()).status).toBe(409);
  });
  it("sync upstream failure is 502 with fixed text", async () => {
    as("admin");
    const { ShopifyUpstreamError } = await import("@/lib/shopify/sync-errors");
    vi.mocked(syncShopify).mockRejectedValueOnce(new ShopifyUpstreamError("Shopify is busy, try again in a few minutes"));
    const res = await (await calls()).sync();
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toBe("Shopify is busy, try again in a few minutes");
  });
  it("disconnect calls through", async () => {
    as("admin");
    const res = await (await calls()).disconnect();
    expect(res.status).toBe(200);
    expect(disconnectShopify).toHaveBeenCalledWith(clientId());
  });
  it("status returns status without secrets; missing clientId is 400", async () => {
    as("admin");
    const res = await (await calls()).status();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/access_token|ciphertext/i);
    const { GET } = await import("@/app/api/admin/shopify/status/route");
    expect((await GET(new Request("https://x/api/admin/shopify/status"))).status).toBe(400);
  });
});

describe("POST /api/cron/shopify-sync", () => {
  const req = (auth?: string) =>
    new Request("https://x/api/cron/shopify-sync", { method: "POST", headers: auth ? { authorization: auth } : {} });
  it("401 without secret configured", async () => {
    const { POST } = await import("@/app/api/cron/shopify-sync/route");
    expect((await POST(req("Bearer "))).status).toBe(401);
    expect((await POST(req())).status).toBe(401);
    expect(syncAllShopify).not.toHaveBeenCalled();
  });
  it("401 with missing or wrong secret", async () => {
    process.env.CRON_SECRET = "right";
    const { POST } = await import("@/app/api/cron/shopify-sync/route");
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req("Bearer wrong"))).status).toBe(401);
    expect(syncAllShopify).not.toHaveBeenCalled();
  });
  it("200 and runs syncAllShopify with the right secret", async () => {
    process.env.CRON_SECRET = "right";
    vi.mocked(syncAllShopify).mockResolvedValue({ synced: 2, failed: 1 });
    const { POST } = await import("@/app/api/cron/shopify-sync/route");
    const res = await POST(req("Bearer right"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ synced: 2, failed: 1 });
    expect(syncAllShopify).toHaveBeenCalledTimes(1);
  });
});
