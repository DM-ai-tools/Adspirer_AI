import { createClient } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/meta/token-crypto";
import { getConfig } from "@/lib/config"; // used by tryRefreshToken

export interface MetaTokenResult {
  accessToken: string;
  expiresAt: Date | null;
  metaUserId: string | null;
}

/**
 * Resolves the Meta access token for the current authenticated user via OAuth.
 */
export async function getUserMetaToken(): Promise<MetaTokenResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data } = await supabase
      .from("meta_oauth_tokens")
      .select("access_token_encrypted, token_expires_at, meta_user_id")
      .eq("user_id", user.id)
      .single();

    if (data?.access_token_encrypted) {
      const accessToken = decryptToken(data.access_token_encrypted);

      const expiresAt = data.token_expires_at
        ? new Date(data.token_expires_at)
        : null;

      // Auto-refresh if expiring within 7 days
      if (expiresAt && expiresAt.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000) {
        const refreshed = await tryRefreshToken(accessToken);
        if (refreshed) {
          await supabase
            .from("meta_oauth_tokens")
            .update({
              access_token_encrypted: (await import("./token-crypto")).encryptToken(refreshed.accessToken),
              token_expires_at: refreshed.expiresAt?.toISOString() ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", user.id);
          return refreshed;
        }
      }

      return {
        accessToken,
        expiresAt,
        metaUserId: data.meta_user_id ?? null,
      };
    }
  }

  throw new Error(
    "No Meta access token found. Please connect your Facebook account.",
  );
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

    const res = await fetch(url.toString());
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
