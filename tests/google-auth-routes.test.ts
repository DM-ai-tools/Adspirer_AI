import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { loadGoogleConnection, saveGoogleConnection } from "@/lib/google/oauth";

vi.mock("@/lib/security/auth", () => ({ getCurrentUser: vi.fn() }));
import { getCurrentUser } from "@/lib/security/auth";

const jar = new Map<string, { value: string; options?: Record<string, unknown> }>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      jar.set(name, { value, options });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

vi.mock("@/lib/google/assets", () => ({ syncGoogleAssets: vi.fn() }));
import { syncGoogleAssets } from "@/lib/google/assets";

// Lets one test make the access-token refresh behave as if Google revoked the grant.
const tokenOverride = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/google/oauth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/google/oauth")>();
  return {
    ...real,
    getGoogleAccessToken: async () => {
      if (tokenOverride.fail) throw new real.GoogleReconnectRequired();
      return real.getGoogleAccessToken();
    },
  };
});

const as = (role: "admin" | "operator") => {
  const p = getDemoStore().profiles.find((x) => x.role === role)!;
  vi.mocked(getCurrentUser).mockResolvedValue({ id: p.id, email: p.email, profile: p });
  return p;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const callbackReq = (qs: string) =>
  ({
    nextUrl: new URL(`https://app.example.com/api/auth/google/callback?${qs}`),
  }) as unknown as import("next/server").NextRequest;
const locationOf = (res: Response) => new URL(res.headers.get("location")!);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  process.env.APP_URL = "https://app.example.com";
  resetConfigCache();
  jar.clear();
  tokenOverride.fail = false;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(syncGoogleAssets).mockReset();
  vi.mocked(syncGoogleAssets).mockResolvedValue({ ga4: 0, ads: 0, gsc: 0, warnings: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.APP_URL;
  resetConfigCache();
});

describe("GET /api/auth/google (start)", () => {
  it("refuses non-admins", async () => {
    as("operator");
    const { GET } = await import("@/app/api/auth/google/route");
    expect((await GET()).status).toBe(403);
  });

  it("is 503 when Google is not configured", async () => {
    as("admin");
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    resetConfigCache();
    const { GET } = await import("@/app/api/auth/google/route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Google is not configured" });
  });

  it("redirects an admin to Google with a state cookie", async () => {
    as("admin");
    const { GET } = await import("@/app/api/auth/google/route");
    const res = await GET();
    expect([302, 307]).toContain(res.status);
    const loc = locationOf(res);
    expect(loc.host).toBe("accounts.google.com");
    const cookie = jar.get("google_oauth_state")!;
    expect(cookie.value).toMatch(/^[0-9a-f]{32}$/);
    expect(loc.searchParams.get("state")).toBe(cookie.value);
    expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 600 });
  });
});

describe("GET /api/auth/google/callback", () => {
  const goodTokens = () =>
    fetchMock
      .mockResolvedValueOnce(
        json({ access_token: "at", refresh_token: "rt-plain", expires_in: 3599, scope: "openid email" }),
      )
      .mockResolvedValueOnce(json({ email: "agency@example.com" }));

  it("rejects a mismatched state, saves nothing and clears the cookie", async () => {
    as("admin");
    jar.set("google_oauth_state", { value: "right" });
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const res = await GET(callbackReq("code=c&state=wrong"));
    expect(locationOf(res).searchParams.get("google_error")).toBe("state_mismatch");
    expect(await loadGoogleConnection()).toBeNull();
    expect(jar.has("google_oauth_state")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores nothing when Google sends no refresh token", async () => {
    as("admin");
    jar.set("google_oauth_state", { value: "s" });
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "at", expires_in: 3599 }))
      .mockResolvedValueOnce(json({ email: "a@b.com" }));
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const res = await GET(callbackReq("code=c&state=s"));
    expect(locationOf(res).searchParams.get("google_error")).toBe("no_refresh_token");
    expect(await loadGoogleConnection()).toBeNull();
    expect(jar.has("google_oauth_state")).toBe(false);
  });

  it("maps a failed exchange to exchange_failed", async () => {
    as("admin");
    jar.set("google_oauth_state", { value: "s" });
    fetchMock.mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const res = await GET(callbackReq("code=c&state=s"));
    expect(locationOf(res).searchParams.get("google_error")).toBe("exchange_failed");
    expect(await loadGoogleConnection()).toBeNull();
  });

  it("handles access_denied from Google and clears the cookie", async () => {
    as("admin");
    jar.set("google_oauth_state", { value: "s" });
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const res = await GET(callbackReq("error=access_denied&state=s"));
    expect(locationOf(res).searchParams.get("google_error")).toBe("denied");
    expect(jar.has("google_oauth_state")).toBe(false);
  });

  it("refuses a non-admin session, saves nothing and clears the cookie", async () => {
    as("operator");
    jar.set("google_oauth_state", { value: "s" });
    goodTokens();
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const res = await GET(callbackReq("code=c&state=s"));
    expect(locationOf(res).searchParams.get("google_error")).toBe("not_admin");
    expect(await loadGoogleConnection()).toBeNull();
    expect(jar.has("google_oauth_state")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves the connection and redirects with the asset count", async () => {
    const admin = as("admin");
    jar.set("google_oauth_state", { value: "s" });
    goodTokens();
    vi.mocked(syncGoogleAssets).mockResolvedValue({ ga4: 2, ads: 1, gsc: 3, warnings: [] });
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const res = await GET(callbackReq("code=c&state=s"));
    const loc = locationOf(res);
    expect(loc.pathname).toBe("/admin/connections");
    expect(loc.searchParams.get("google_connected")).toBe("1");
    expect(loc.searchParams.get("google_assets")).toBe("6");
    expect(await loadGoogleConnection()).toMatchObject({
      google_email: "agency@example.com",
      connected_by: admin.id,
    });
    expect(jar.has("google_oauth_state")).toBe(false);
  });

  it("keeps the connection when the asset sync fails", async () => {
    as("admin");
    jar.set("google_oauth_state", { value: "s" });
    goodTokens();
    vi.mocked(syncGoogleAssets).mockRejectedValue(new Error("boom"));
    const { GET } = await import("@/app/api/auth/google/callback/route");
    const res = await GET(callbackReq("code=c&state=s"));
    const loc = locationOf(res);
    expect(loc.searchParams.get("google_connected")).toBe("1");
    expect(loc.searchParams.get("google_assets")).toBe("0");
    expect(await loadGoogleConnection()).not.toBeNull();
  });
});

describe("GET /api/auth/google/status", () => {
  it("refuses non-admins", async () => {
    as("operator");
    const { GET } = await import("@/app/api/auth/google/status/route");
    expect((await GET()).status).toBe(403);
  });

  it("reports not connected", async () => {
    as("admin");
    const { GET } = await import("@/app/api/auth/google/status/route");
    const body = (await (await GET()).json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      configured: true,
      connected: false,
      email: null,
      needsReconnect: false,
    });
  });

  it("reports connected with the email and no token anywhere", async () => {
    as("admin");
    await saveGoogleConnection({
      refreshToken: "rt-plain-secret",
      email: "agency@example.com",
      scopes: ["openid"],
      connectedBy: null,
    });
    const encrypted = getDemoStore().googleConnection!.refresh_token_encrypted;
    const { GET } = await import("@/app/api/auth/google/status/route");
    const text = JSON.stringify(await (await GET()).json());
    expect(JSON.parse(text).data).toMatchObject({
      connected: true,
      email: "agency@example.com",
      needsReconnect: false,
    });
    expect(text).not.toContain("rt-plain-secret");
    expect(text).not.toContain(encrypted);
    expect(text).not.toMatch(/token/i);
  });

  it("flags needsReconnect when the refresh token was revoked", async () => {
    as("admin");
    await saveGoogleConnection({ refreshToken: "rt", email: null, scopes: [], connectedBy: null });
    tokenOverride.fail = true;
    const { GET } = await import("@/app/api/auth/google/status/route");
    const body = (await (await GET()).json()) as { data: { connected: boolean; needsReconnect: boolean } };
    expect(body.data).toMatchObject({ connected: true, needsReconnect: true });
  });
});

describe("POST /api/auth/google/disconnect", () => {
  const connect = () =>
    saveGoogleConnection({ refreshToken: "rt-to-revoke", email: "a@b.com", scopes: [], connectedBy: null });

  it("refuses non-admins", async () => {
    as("operator");
    const { POST } = await import("@/app/api/auth/google/disconnect/route");
    expect((await POST()).status).toBe(403);
  });

  it("revokes the refresh token at Google, then deletes the connection", async () => {
    as("admin");
    await connect();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { POST } = await import("@/app/api/auth/google/disconnect/route");
    const res = await POST();
    expect(((await res.json()) as { data: { ok: boolean } }).data.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("token=rt-to-revoke");
    expect(await loadGoogleConnection()).toBeNull();
  });

  it("still deletes when the revoke call fails", async () => {
    as("admin");
    await connect();
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const { POST } = await import("@/app/api/auth/google/disconnect/route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await loadGoogleConnection()).toBeNull();
  });

  it("never logs the refresh token when the revoke call fails or is refused", async () => {
    const { logger } = await import("@/lib/observability/logger");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      as("admin");
      const { POST } = await import("@/app/api/auth/google/disconnect/route");
      // A failure whose message echoes the request body.
      await connect();
      fetchMock.mockRejectedValueOnce(new Error("socket hang up sending token=rt-to-revoke"));
      expect((await POST()).status).toBe(200);
      await connect();
      fetchMock.mockResolvedValueOnce(new Response("token rt-to-revoke is invalid", { status: 400 }));
      expect((await POST()).status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(2);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("rt-to-revoke");
      expect(logged).toContain("Google token revoke failed");
      expect(logged).toContain("Google token revoke was refused");
    } finally {
      warn.mockRestore();
    }
  });

  it("status then reports connected: false", async () => {
    as("admin");
    await connect();
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { POST } = await import("@/app/api/auth/google/disconnect/route");
    await POST();
    const { GET } = await import("@/app/api/auth/google/status/route");
    const body = (await (await GET()).json()) as { data: { connected: boolean } };
    expect(body.data.connected).toBe(false);
  });
});
