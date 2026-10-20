import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Supabase-backed token service against a fake admin client: the refresh
// token is read from google_oauth_connection, refreshed over (mocked) fetch,
// and the access token is cached in memory.
const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<Record<string, unknown>>,
  deletes: 0,
}));

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    isDemoMode: false,
    hasSupabase: true,
    APP_URL: "https://app.example.com",
    GOOGLE_OAUTH_CLIENT_ID: "cid",
    GOOGLE_OAUTH_CLIENT_SECRET: "csecret",
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        order: () => ({ limit: async () => ({ data: db.rows, error: null }) }),
      }),
      delete: () => ({
        not: async () => {
          db.deletes += 1;
          db.rows = [];
          return { error: null };
        },
      }),
      insert: async (row: Record<string, unknown>) => {
        db.inserts.push(row);
        db.rows = [{ id: "row1", ...row }];
        return { error: null };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  }),
}));

import {
  GoogleReconnectRequired,
  getGoogleAccessToken,
  resetGoogleTokenCache,
  saveGoogleConnection,
} from "@/lib/google/oauth";
import { decryptToken } from "@/lib/security/token-vault";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  db.rows = [];
  db.inserts = [];
  db.deletes = 0;
  resetGoogleTokenCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await saveGoogleConnection({ refreshToken: "live-rt", email: "a@b.com", scopes: [], connectedBy: null });
});

afterEach(() => vi.unstubAllGlobals());

describe("Supabase token service", () => {
  it("replaces the single row and stores only the encrypted token", () => {
    expect(db.deletes).toBe(1);
    expect(db.inserts).toHaveLength(1);
    const stored = db.inserts[0].refresh_token_encrypted as string;
    expect(stored).not.toContain("live-rt");
    expect(decryptToken(stored)).toBe("live-rt");
  });

  it("refreshes once and serves the second call from cache", async () => {
    fetchMock.mockResolvedValue(json({ access_token: "at1", expires_in: 3600 }));
    expect(await getGoogleAccessToken()).toBe("at1");
    expect(await getGoogleAccessToken()).toBe("at1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=live-rt");
  });

  it("refreshes again once the cached token is within 60s of expiry", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "at1", expires_in: 30 }))
      .mockResolvedValueOnce(json({ access_token: "at2", expires_in: 3600 }));
    expect(await getGoogleAccessToken()).toBe("at1");
    expect(await getGoogleAccessToken()).toBe("at2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one refresh between parallel calls", async () => {
    fetchMock.mockImplementation(async () => json({ access_token: "at1", expires_in: 3600 }));
    const tokens = await Promise.all(Array.from({ length: 6 }, () => getGoogleAccessToken()));
    expect(tokens).toEqual(Array(6).fill("at1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't put a refresh that a reset overtook back in the cache", async () => {
    let answer!: (res: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    const first = getGoogleAccessToken();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // A disconnect or reconnect lands while the refresh is in flight.
    resetGoogleTokenCache();
    answer(json({ access_token: "stale", expires_in: 3600 }));
    expect(await first).toBe("stale");
    fetchMock.mockResolvedValueOnce(json({ access_token: "fresh", expires_in: 3600 }));
    expect(await getGoogleAccessToken()).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalid_grant clears the cache and asks for a reconnect", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "at1", expires_in: 3600 }));
    await getGoogleAccessToken();
    resetGoogleTokenCache();
    fetchMock.mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
    await expect(getGoogleAccessToken()).rejects.toBeInstanceOf(GoogleReconnectRequired);
    fetchMock.mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
    await expect(getGoogleAccessToken()).rejects.toBeInstanceOf(GoogleReconnectRequired);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
