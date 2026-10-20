import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/security/auth";
import { isAdmin } from "@/lib/security/roles";
import { logger } from "@/lib/observability/logger";
import { exchangeGoogleCode, saveGoogleConnection } from "@/lib/google/oauth";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const cookieStore = await cookies();
  const savedState = cookieStore.get("google_oauth_state")?.value;
  // The state is single-use: gone whatever happens next.
  cookieStore.delete("google_oauth_state");

  const redirectWith = (params: Record<string, string>) => {
    const url = new URL("/admin/connections", getConfig().APP_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return NextResponse.redirect(url.toString());
  };

  const user = await getCurrentUser();
  if (!user || !isAdmin(user.profile)) return redirectWith({ google_error: "not_admin" });

  if (searchParams.get("error")) return redirectWith({ google_error: "denied" });

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state || !savedState || state !== savedState) {
    return redirectWith({ google_error: "state_mismatch" });
  }

  let exchanged: Awaited<ReturnType<typeof exchangeGoogleCode>>;
  try {
    exchanged = await exchangeGoogleCode(code);
  } catch (error) {
    logger.error("Google token exchange failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return redirectWith({ google_error: "exchange_failed" });
  }

  // Without a refresh token the connection would die within the hour.
  if (!exchanged.refreshToken) return redirectWith({ google_error: "no_refresh_token" });

  try {
    await saveGoogleConnection({
      refreshToken: exchanged.refreshToken,
      email: exchanged.email,
      scopes: exchanged.scopes,
      connectedBy: user.id,
    });
  } catch (error) {
    logger.error("Failed to save Google connection", {
      message: error instanceof Error ? error.message : String(error),
    });
    return redirectWith({ google_error: "exchange_failed" });
  }

  let assets = 0;
  try {
    const { syncGoogleAssets } = await import("@/lib/google/assets");
    const synced = await syncGoogleAssets();
    assets = synced.ga4 + synced.ads + synced.gsc;
  } catch (error) {
    logger.warn("Google asset sync failed after connect", {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return redirectWith({ google_connected: "1", google_assets: String(assets) });
}
