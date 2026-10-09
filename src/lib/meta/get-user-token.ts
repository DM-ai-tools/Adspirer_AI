import { createClient } from "@/lib/supabase/server";
import { decryptToken, encryptToken } from "@/lib/meta/token-crypto";
import { getConfig } from "@/lib/config";
import { getWorkspaceContext } from "@/lib/runtime/workspace-context";

export interface MetaTokenResult {
  accessToken: string;
  expiresAt: Date | null;
  metaUserId: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Try to extend a long-lived token once it is inside its last week. */
const REFRESH_WINDOW_MS = 7 * DAY_MS;
/** …but at most once a day, not on every Graph call. */
const REFRESH_RETRY_MS = DAY_MS;
/**
 * A single audit resolves the provider for every diagnose tool. Reuse the
 * decrypted token briefly instead of re-reading Supabase each time.
 */
const CACHE_TTL_MS = 30_000;

const tokenCache = new Map<
  string,
  { result: MetaTokenResult; cachedAt: number }
>();

export function invalidateUserMetaToken(userId: string): void {
  tokenCache.delete(userId);
}

/**
 * Resolves the Meta access token for the current authenticated user via OAuth.
 */
export async function getUserMetaToken(): Promise<MetaTokenResult> {
  // Background jobs run without cookies: they name the user explicitly and
  // read the token with the service role. Requests use the session.
  const actingUserId = getWorkspaceContext()?.actingUserId;
  let supabase: Awaited<ReturnType<typeof createClient>>;
  let userId: string | null;
  if (actingUserId) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    supabase = createAdminClient() as unknown as typeof supabase;
    userId = actingUserId;
  } else {
    supabase = await createClient();
    const { data: claimsData } = await supabase.auth.getClaims();
    userId =
      typeof claimsData?.claims?.sub === "string" ? claimsData.claims.sub : null;
  }

  if (!userId) {
    throw new Error(
      "No Meta access token found. Please connect your Facebook account.",
    );
  }

  const cached = tokenCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const { data } = await supabase
    .from("meta_oauth_tokens")
    .select("access_token_encrypted, token_expires_at, meta_user_id, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data?.access_token_encrypted) {
    throw new Error(
      "No Meta access token found. Please connect your Facebook account.",
    );
  }

  const accessToken = decryptToken(data.access_token_encrypted);
  const expiresAt = data.token_expires_at
    ? new Date(data.token_expires_at)
    : null;
  let result: MetaTokenResult = {
    accessToken,
    expiresAt,
    metaUserId: data.meta_user_id ?? null,
  };

  const msLeft = expiresAt ? expiresAt.getTime() - Date.now() : Infinity;
  const lastTouched = data.updated_at ? Date.parse(data.updated_at) : 0;
  if (msLeft < REFRESH_WINDOW_MS && Date.now() - lastTouched > REFRESH_RETRY_MS) {
    const refreshed = await tryRefreshToken(accessToken);
    const now = new Date().toISOString();
    if (refreshed) {
      await supabase
        .from("meta_oauth_tokens")
        .update({
          access_token_encrypted: encryptToken(refreshed.accessToken),
          token_expires_at: refreshed.expiresAt?.toISOString() ?? null,
          updated_at: now,
        })
        .eq("user_id", userId);
      result = { ...refreshed, metaUserId: result.metaUserId };
    } else {
      // Record the attempt so we don't hammer the exchange endpoint.
      await supabase
        .from("meta_oauth_tokens")
        .update({ updated_at: now })
        .eq("user_id", userId);
    }
  }

  if (result.expiresAt && result.expiresAt.getTime() <= Date.now()) {
    tokenCache.delete(userId);
    throw new Error(
      "Your Facebook connection has expired. Reconnect Facebook to keep working with this ad account.",
    );
  }

  tokenCache.set(userId, { result, cachedAt: Date.now() });
  return result;
}

async function tryRefreshToken(
  currentToken: string,
): Promise<MetaTokenResult | null> {
  try {
    const config = getConfig();
    const appId = config.META_APP_ID;
    const appSecret = config.META_APP_SECRET;
    if (!appId || !appSecret) return null;

    const version = config.META_GRAPH_VERSION || "v23.0";
    const url = new URL(
      `https://graph.facebook.com/${version}/oauth/access_token`,
    );
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", appId);
    url.searchParams.set("client_secret", appSecret);
    url.searchParams.set("fb_exchange_token", currentToken);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) return null;

    const expiresAt = json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000)
      : null;

    return {
      accessToken: json.access_token,
      expiresAt,
      metaUserId: null,
    };
  } catch {
    return null;
  }
}
