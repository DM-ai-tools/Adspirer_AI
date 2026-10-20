import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { decryptToken, encryptToken } from "@/lib/security/token-vault";
import { createAdminClient } from "@/lib/supabase/admin";
import { nowIso } from "@/lib/utils";
import type { GoogleConnection } from "./types";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const TIMEOUT_MS = 25_000;

export const GOOGLE_SCOPES: readonly string[] = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/adwords",
];

/** The agency's refresh token is gone or revoked; an admin must reconnect. */
export class GoogleReconnectRequired extends Error {
  constructor(message = "Google needs reconnecting") {
    super(message);
    this.name = "GoogleReconnectRequired";
  }
}

function redirectUri(): string {
  return `${getConfig().APP_URL.replace(/\/$/, "")}/api/auth/google/callback`;
}

export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getConfig().GOOGLE_OAUTH_CLIENT_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

async function postToken(
  form: Record<string, string>,
): Promise<{ status: number; body: TokenResponse }> {
  const config = getConfig();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: config.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      ...form,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let body: TokenResponse = {};
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    // Non-JSON body: callers fall back to the HTTP status.
  }
  return { status: res.status, body };
}

export async function exchangeGoogleCode(code: string): Promise<{
  refreshToken: string | null;
  accessToken: string;
  expiresInSec: number;
  email: string | null;
  scopes: string[];
}> {
  const { status, body } = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
  });
  if (status < 200 || status >= 300 || !body.access_token) {
    throw new Error(`Google sign-in failed (${body.error ?? `HTTP ${status}`}).`);
  }

  let email: string | null = null;
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${body.access_token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) email = ((await res.json()) as { email?: string }).email ?? null;
  } catch {
    // The email is only a label.
  }

  return {
    refreshToken: body.refresh_token ?? null,
    accessToken: body.access_token,
    expiresInSec: body.expires_in ?? 3600,
    email,
    scopes: body.scope ? body.scope.split(" ").filter(Boolean) : [],
  };
}

function inDemoStore(): boolean {
  const config = getConfig();
  return config.isDemoMode || !config.hasSupabase;
}

export async function saveGoogleConnection(input: {
  refreshToken: string;
  email: string | null;
  scopes: string[];
  connectedBy: string | null;
}): Promise<void> {
  const now = nowIso();
  const encrypted = encryptToken(input.refreshToken);
  resetGoogleTokenCache();

  if (inDemoStore()) {
    getDemoStore().googleConnection = {
      id: "demo_google_connection",
      google_email: input.email,
      scopes: input.scopes,
      refresh_token_encrypted: encrypted,
      connected_by: input.connectedBy,
      connected_at: now,
      last_refreshed_at: null,
      created_at: now,
      updated_at: now,
    };
    return;
  }

  // One row: clear any existing connection, then insert.
  const supabase = createAdminClient();
  const cleared = await supabase
    .from("google_oauth_connection")
    .delete()
    .not("id", "is", null);
  if (cleared.error) throw new Error(cleared.error.message);
  const inserted = await supabase.from("google_oauth_connection").insert({
    google_email: input.email,
    scopes: input.scopes,
    refresh_token_encrypted: encrypted,
    connected_by: input.connectedBy,
    connected_at: now,
  });
  if (inserted.error) throw new Error(inserted.error.message);
}

export async function loadGoogleConnection(): Promise<GoogleConnection | null> {
  if (inDemoStore()) return getDemoStore().googleConnection;
  const { data, error } = await createAdminClient()
    .from("google_oauth_connection")
    .select("*")
    .order("connected_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data as GoogleConnection[] | null) ?? [])[0] ?? null;
}

export async function deleteGoogleConnection(): Promise<void> {
  resetGoogleTokenCache();
  if (inDemoStore()) {
    getDemoStore().googleConnection = null;
    return;
  }
  const { error } = await createAdminClient()
    .from("google_oauth_connection")
    .delete()
    .not("id", "is", null);
  if (error) throw new Error(error.message);
}

let cached: { token: string; expiresAt: number } | null = null;
/** The refresh in flight, shared by every caller until it settles. */
let inflight: Promise<string> | null = null;
/** Bumped by each reset, so a refresh a reset overtook never writes the cache. */
let generation = 0;

export function resetGoogleTokenCache(): void {
  cached = null;
  inflight = null;
  generation += 1;
}

/** Access tokens live in memory only, until `expires_in - 60` seconds; parallel callers share one refresh. */
export async function getGoogleAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (inflight) return inflight;

  const started = generation;
  const refresh = refreshAccessToken(started).finally(() => {
    if (inflight === refresh) inflight = null;
  });
  inflight = refresh;
  return refresh;
}

async function refreshAccessToken(started: number): Promise<string> {
  const connection = await loadGoogleConnection();
  if (!connection) throw new GoogleReconnectRequired();
  if (inDemoStore()) return "demo-google-token";

  const { status, body } = await postToken({
    grant_type: "refresh_token",
    refresh_token: decryptToken(connection.refresh_token_encrypted),
  });
  if (body.error === "invalid_grant") {
    if (generation === started) cached = null;
    throw new GoogleReconnectRequired();
  }
  if (status < 200 || status >= 300 || !body.access_token) {
    throw new Error(`Google token refresh failed (${body.error ?? `HTTP ${status}`}).`);
  }

  const ttlSec = Math.max((body.expires_in ?? 3600) - 60, 0);
  // A reset (disconnect, reconnect) while this refresh was in flight: don't bring its token back.
  if (generation === started) cached = { token: body.access_token, expiresAt: Date.now() + ttlSec * 1000 };
  // Best effort: a failed bookkeeping write must not fail the refresh.
  try {
    await createAdminClient()
      .from("google_oauth_connection")
      .update({ last_refreshed_at: nowIso() })
      .eq("id", connection.id);
  } catch {
    // ignore
  }
  return body.access_token;
}
