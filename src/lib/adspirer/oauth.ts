import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { getConfig } from "@/lib/config";
import { getDemoStore } from "@/lib/demo/store";
import { addHoursIso, nowIso } from "@/lib/utils";
import type { OAuthPkceState } from "@/types";

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function generateCodeChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function generateOAuthState(): string {
  return base64Url(randomBytes(16));
}

export interface ConnectUrlResult {
  url: string;
  state: string;
  code_verifier: string;
  pkce: OAuthPkceState;
}

/**
 * Create PKCE state and return Adspirer OAuth authorize URL.
 */
export function createConnectUrl(params: {
  createdBy?: string | null;
  redirectUri?: string;
}): ConnectUrlResult {
  const config = getConfig();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateOAuthState();
  const redirectUri =
    params.redirectUri ??
    config.ADSPIRER_REDIRECT_URI ??
    `${config.APP_URL}/api/adspirer/oauth/callback`;

  const pkce: OAuthPkceState = {
    id: `pkce_${nanoid(10)}`,
    state,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    created_by: params.createdBy ?? null,
    expires_at: addHoursIso(1),
    consumed_at: null,
    created_at: nowIso(),
  };

  if (config.isDemoMode || !config.hasSupabase) {
    getDemoStore().oauthPkceStates.push(pkce);
  }

  const authorizeBase =
    config.ADSPIRER_OAUTH_AUTHORIZE_URL?.trim() ||
    "";

  if (!authorizeBase) {
    throw new Error(
      "Adspirer OAuth is not configured. With ADSPIRER_API_KEY, use Sync accounts instead — or set ADSPIRER_OAUTH_AUTHORIZE_URL / CLIENT_ID for OAuth.",
    );
  }

  let url: URL;
  try {
    url = new URL(authorizeBase);
  } catch {
    throw new Error(
      `Invalid ADSPIRER_OAUTH_AUTHORIZE_URL: "${authorizeBase}". Expected a full https URL.`,
    );
  }
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "client_id",
    config.ADSPIRER_CLIENT_ID?.trim() || "demo-client",
  );
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "ads_read ads_management");

  return { url: url.toString(), state, code_verifier: codeVerifier, pkce };
}

export function consumePkceState(state: string): OAuthPkceState | null {
  const store = getDemoStore();
  const entry = store.oauthPkceStates.find(
    (p) => p.state === state && !p.consumed_at,
  );
  if (!entry) return null;
  if (new Date(entry.expires_at).getTime() < Date.now()) return null;
  entry.consumed_at = nowIso();
  return entry;
}
