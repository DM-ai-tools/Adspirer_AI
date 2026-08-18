import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAuthenticated, assertAdmin } from "@/lib/authz/assert";
import { consumePkceState } from "@/lib/adspirer/oauth";
import { storeServiceAccountTokens } from "@/lib/adspirer/token-service";
import { AdspirerConnectionError } from "@/lib/errors";
import { addDaysIso } from "@/lib/utils";
import { jsonError, jsonOk, withApiHandler } from "@/lib/api/response";

/**
 * OAuth callback — exchanges code for tokens (demo stores mock tokens).
 * Accepts both browser redirect (GET) and JSON POST.
 */
export async function GET(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      throw new AdspirerConnectionError(`OAuth error: ${error}`);
    }
    if (!code || !state) {
      throw new AdspirerConnectionError("Missing OAuth code or state");
    }

    await completeOAuth(code, state);

    const config = getConfig();
    return NextResponse.redirect(
      new URL("/admin/adspirer?connected=1", config.APP_URL),
    );
  });
}

export async function POST(request: Request) {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    const body = (await request.json().catch(() => ({}))) as {
      code?: string;
      state?: string;
    };
    if (!body.code || !body.state) {
      return jsonError(new AdspirerConnectionError("Missing OAuth code or state"));
    }

    const account = await completeOAuth(body.code, body.state);
    return jsonOk({
      connected: true,
      account: {
        id: account.id,
        label: account.label,
        is_active: account.is_active,
        token_expires_at: account.token_expires_at,
        scopes: account.scopes,
      },
    });
  });
}

async function completeOAuth(code: string, state: string) {
  const pkce = consumePkceState(state);
  if (!pkce) {
    throw new AdspirerConnectionError("Invalid or expired OAuth state");
  }

  const config = getConfig();

  // Demo / missing MCP: persist opaque demo tokens. Live exchange is Phase 2+.
  if (config.isDemoMode || !config.ADSPIRER_OAUTH_TOKEN_URL) {
    return storeServiceAccountTokens({
      label: "Adspirer Shared Service Account",
      accessToken: `demo_access_${code.slice(0, 12)}`,
      refreshToken: `demo_refresh_${state.slice(0, 12)}`,
      expiresAt: addDaysIso(30),
      scopes: ["ads_read", "ads_management"],
    });
  }

  const tokenRes = await fetch(config.ADSPIRER_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: pkce.redirect_uri,
      client_id: config.ADSPIRER_CLIENT_ID ?? "",
      client_secret: config.ADSPIRER_CLIENT_SECRET ?? "",
      code_verifier: pkce.code_verifier,
    }),
  });

  if (!tokenRes.ok) {
    throw new AdspirerConnectionError("Token exchange failed", {
      status: tokenRes.status,
    });
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  return storeServiceAccountTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null,
    scopes: tokens.scope ? tokens.scope.split(" ") : null,
  });
}
