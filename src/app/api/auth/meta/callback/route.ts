import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { encryptToken } from "@/lib/meta/token-crypto";
import { invalidateUserMetaToken } from "@/lib/meta/get-user-token";
import { logger } from "@/lib/observability/logger";

export async function GET(request: NextRequest) {
  const config = getConfig();
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error =
    searchParams.get("error") ||
    (searchParams.get("error_code") ? "facebook_error" : null);
  const errorReason = searchParams.get("error_reason");
  const errorDescription =
    searchParams.get("error_description") ||
    searchParams.get("error_message");
  const cookieStore = await cookies();
  const returnTo = cookieStore.get("meta_oauth_return")?.value;
  const safeReturn =
    returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
      ? returnTo
      : "/workspace";

  const redirectWith = (params: Record<string, string>) => {
    const url = new URL(safeReturn, config.APP_URL);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return NextResponse.redirect(url.toString());
  };

  logger.info("Meta OAuth callback hit", {
    hasCode: Boolean(code),
    hasState: Boolean(state),
    error,
    returnTo: safeReturn,
  });

  if (error) {
    cookieStore.delete("meta_oauth_return");
    return redirectWith({
      meta_error: error,
      ...(errorReason ? { meta_error_reason: errorReason } : {}),
      ...(errorDescription
        ? { meta_error_description: errorDescription }
        : {}),
    });
  }

  if (!code || !state) {
    cookieStore.delete("meta_oauth_return");
    return redirectWith({ meta_error: "missing_params" });
  }

  const savedState = cookieStore.get("meta_oauth_state")?.value;
  cookieStore.delete("meta_oauth_state");
  cookieStore.delete("meta_oauth_nonce");

  if (state !== savedState) {
    cookieStore.delete("meta_oauth_return");
    return redirectWith({ meta_error: "invalid_state" });
  }

  const appId = config.META_APP_ID;
  const appSecret = config.META_APP_SECRET;
  if (!appId || !appSecret) {
    cookieStore.delete("meta_oauth_return");
    return redirectWith({ meta_error: "app_not_configured" });
  }

  const redirectUri = `${config.APP_URL}/api/auth/meta/callback`;
  const version = config.META_GRAPH_VERSION || "v23.0";

  const tokenUrl = new URL(
    `https://graph.facebook.com/${version}/oauth/access_token`,
  );
  tokenUrl.searchParams.set("client_id", appId);
  tokenUrl.searchParams.set("client_secret", appSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);

  const tokenRes = await fetch(tokenUrl.toString());
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    logger.error("Meta token exchange failed", {
      status: tokenRes.status,
      body: body.slice(0, 500),
      redirectUri,
    });
    cookieStore.delete("meta_oauth_return");
    return redirectWith({ meta_error: "token_exchange_failed" });
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    expires_in?: number;
  };

  const longUrl = new URL(
    `https://graph.facebook.com/${version}/oauth/access_token`,
  );
  longUrl.searchParams.set("grant_type", "fb_exchange_token");
  longUrl.searchParams.set("client_id", appId);
  longUrl.searchParams.set("client_secret", appSecret);
  longUrl.searchParams.set("fb_exchange_token", tokenData.access_token);

  const longRes = await fetch(longUrl.toString());
  let accessToken = tokenData.access_token;
  let expiresIn = tokenData.expires_in ?? 3600;

  if (longRes.ok) {
    const longData = (await longRes.json()) as {
      access_token: string;
      expires_in?: number;
    };
    accessToken = longData.access_token;
    expiresIn = longData.expires_in ?? 5184000;
  }

  const [meRes, permRes] = await Promise.all([
    fetch(`https://graph.facebook.com/${version}/me?fields=id,name`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    fetch(`https://graph.facebook.com/${version}/me/permissions`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  ]);
  let metaUserId: string | null = null;
  let metaUserName: string | null = null;
  if (meRes.ok) {
    const meData = (await meRes.json()) as { id?: string; name?: string };
    metaUserId = meData.id ?? null;
    metaUserName = meData.name ?? null;
  }

  // Record what the user actually granted — permissions can be unticked in
  // the Facebook dialog, and a missing ads scope must not look "connected".
  let grantedScopes: string[] = [];
  if (permRes.ok) {
    const permData = (await permRes.json()) as {
      data?: Array<{ permission?: string; status?: string }>;
    };
    grantedScopes = (permData.data ?? [])
      .filter((p) => p.status === "granted" && p.permission)
      .map((p) => p.permission as string);
    if (
      !grantedScopes.includes("ads_read") &&
      !grantedScopes.includes("ads_management")
    ) {
      cookieStore.delete("meta_oauth_return");
      return redirectWith({
        meta_error: "missing_permissions",
        meta_error_description:
          "Ad account access was not granted. Reconnect and allow the ads permissions in the Facebook dialog.",
      });
    }
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    cookieStore.delete("meta_oauth_return");
    return redirectWith({ meta_error: "not_authenticated" });
  }

  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const encrypted = encryptToken(accessToken);

  const { error: saveError } = await supabase.from("meta_oauth_tokens").upsert(
    {
      user_id: user.id,
      access_token_encrypted: encrypted,
      token_expires_at: expiresAt,
      scopes: grantedScopes,
      meta_user_id: metaUserId,
      meta_user_name: metaUserName,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  invalidateUserMetaToken(user.id);
  if (saveError) {
    logger.error("Failed to save Meta OAuth token", {
      message: saveError.message,
    });
    cookieStore.delete("meta_oauth_return");
    return redirectWith({
      meta_error: "save_failed",
      meta_error_description:
        "Facebook connected, but the connection could not be saved. Please try again.",
    });
  }

  let syncedCount = 0;
  try {
    const { syncConnectedMetaAccounts } = await import(
      "@/lib/adspirer/account-sync"
    );
    const sync = await syncConnectedMetaAccounts({ source: "facebook_oauth" });
    syncedCount = sync.count;
  } catch (syncError) {
    logger.warn("Meta OAuth account sync failed after connect", {
      error:
        syncError instanceof Error ? syncError.message : String(syncError),
    });
  }

  cookieStore.delete("meta_oauth_return");
  return redirectWith({
    meta_connected: "true",
    ...(metaUserName ? { meta_user: metaUserName } : {}),
    meta_accounts: String(syncedCount),
  });
}
