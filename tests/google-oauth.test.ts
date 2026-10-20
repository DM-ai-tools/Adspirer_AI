import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigCache } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { GoogleApiError, googleFetch } from "@/lib/google/http";
import {
  GOOGLE_SCOPES,
  GoogleReconnectRequired,
  deleteGoogleConnection,
  exchangeGoogleCode,
  getGoogleAccessToken,
  googleAuthUrl,
  loadGoogleConnection,
  resetGoogleTokenCache,
  saveGoogleConnection,
} from "@/lib/google/oauth";
import { decryptToken } from "@/lib/security/token-vault";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
  process.env.APP_URL = "https://app.example.com";
  resetConfigCache();
  resetGoogleTokenCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  delete process.env.APP_URL;
  resetConfigCache();
});

describe("googleAuthUrl", () => {
  it("asks for offline consent with every scope, state and the redirect URI", () => {
    const q = new URL(googleAuthUrl("s1")).searchParams;
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("state")).toBe("s1");
    expect(q.get("include_granted_scopes")).toBe("true");
    expect(q.get("redirect_uri")).toBe("https://app.example.com/api/auth/google/callback");
    for (const scope of GOOGLE_SCOPES) expect(q.get("scope")).toContain(scope);
  });
});

describe("exchangeGoogleCode", () => {
  it("posts the authorization_code grant and returns refresh token and email", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ access_token: "at", refresh_token: "rt", expires_in: 3599, scope: "openid email" }),
      )
      .mockResolvedValueOnce(json({ email: "a@b.com" }));
    const out = await exchangeGoogleCode("code1");
    expect(out).toMatchObject({
      refreshToken: "rt",
      accessToken: "at",
      email: "a@b.com",
      expiresInSec: 3599,
      scopes: ["openid", "email"],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(String(init.body)).toContain("grant_type=authorization_code");
    expect(String(init.body)).toContain("code=code1");
    expect(fetchMock.mock.calls[1][0]).toBe("https://openidconnect.googleapis.com/v1/userinfo");
  });

  it("returns a null refresh token when Google sends none", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "at", expires_in: 3599 }))
      .mockResolvedValueOnce(json({}));
    const out = await exchangeGoogleCode("c");
    expect(out.refreshToken).toBeNull();
    expect(out.email).toBeNull();
  });
});

describe("connection storage (demo store)", () => {
  it("stores the refresh token encrypted and round-trips it", async () => {
    await saveGoogleConnection({
      refreshToken: "plain-rt",
      email: "a@b.com",
      scopes: ["openid"],
      connectedBy: null,
    });
    const stored = getDemoStore().googleConnection!;
    expect(stored.refresh_token_encrypted).not.toContain("plain-rt");
    expect(decryptToken(stored.refresh_token_encrypted)).toBe("plain-rt");
    expect((await loadGoogleConnection())?.google_email).toBe("a@b.com");
    await deleteGoogleConnection();
    expect(await loadGoogleConnection()).toBeNull();
  });

  it("demo mode returns the demo token with a connection, else needs reconnect", async () => {
    // The demo store seeds a connection; without one a reconnect is needed.
    expect(await getGoogleAccessToken()).toBe("demo-google-token");
    await deleteGoogleConnection();
    await expect(getGoogleAccessToken()).rejects.toBeInstanceOf(GoogleReconnectRequired);
    await saveGoogleConnection({ refreshToken: "rt", email: null, scopes: [], connectedBy: null });
    expect(await getGoogleAccessToken()).toBe("demo-google-token");
  });
});

describe("googleFetch", () => {
  beforeEach(() => vi.useFakeTimers());

  it("retries a 503 then succeeds, token only in the Authorization header", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { message: "down" } }, 503))
      .mockResolvedValueOnce(json({ ok: true }));
    const p = googleFetch<{ ok: boolean }>("https://example.googleapis.com/v1/x", {
      accessToken: "SECRET",
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain("SECRET");
    expect(init.headers.Authorization).toBe("Bearer SECRET");
  });

  it("refuses any mutate URL before calling Google", async () => {
    for (const url of [
      "https://googleads.googleapis.com/v21/customers/123/campaigns:mutate",
      "https://googleads.googleapis.com/v21/customers/123/googleAds:Mutate",
      "https://googleads.googleapis.com/v21/customers/123/campaignBudgets/MUTATE",
    ]) {
      await expect(googleFetch(url, { method: "POST", accessToken: "t", body: {} }), url).rejects.toThrow(/read-only/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a 400", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "bad", status: "INVALID_ARGUMENT" } }, 400),
    );
    await expect(
      googleFetch("https://x.googleapis.com/", { accessToken: "t" }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_ARGUMENT" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("turns a non-JSON 500 into a GoogleApiError", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>oops</html>", { status: 500 }));
    const p = googleFetch("https://x.googleapis.com/", { accessToken: "t" });
    const settled = p.then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await settled;
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as GoogleApiError).status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
