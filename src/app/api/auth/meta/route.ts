import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { randomBytes } from "crypto";
import { cookies } from "next/headers";
import { logger } from "@/lib/observability/logger";

const SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "ads_management",
  "ads_read",
  "business_management",
].join(",");

/**
 * Start Facebook OAuth via Meta's official dialog.
 * Keep this URL minimal — extra params (reauthenticate / logout.php wrappers)
 * often dump the user on facebook.com/home instead of returning with ?code=.
 */
export async function GET(request: NextRequest) {
  const config = getConfig();
  const appId = config.META_APP_ID;
  if (!appId) {
    return NextResponse.json(
      { error: "META_APP_ID not configured" },
      { status: 500 },
    );
  }

  const redirectUri = `${config.APP_URL}/api/auth/meta/callback`;
  const state = randomBytes(16).toString("hex");
  const returnTo = request.nextUrl.searchParams.get("returnTo");
  const version = config.META_GRAPH_VERSION || "v23.0";

  const cookieStore = await cookies();
  cookieStore.set("meta_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  // Clear leftover nonce from older reauthenticate flow
  cookieStore.delete("meta_oauth_nonce");

  if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
    cookieStore.set("meta_oauth_return", returnTo, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
  } else {
    cookieStore.delete("meta_oauth_return");
  }

  const dialogParams = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    response_type: "code",
    scope: SCOPES,
  });

  const dialogUrl = `https://www.facebook.com/${version}/dialog/oauth?${dialogParams}`;

  logger.info("Meta OAuth start redirect", {
    appIdSuffix: appId.slice(-4),
    redirectUri,
    version,
    returnTo: returnTo ?? null,
  });

  // ?debug=1 returns the URL instead of redirecting (for manual checks)
  if (request.nextUrl.searchParams.get("debug") === "1") {
    return NextResponse.json({
      dialogUrl,
      redirectUri,
      appId,
      scopes: SCOPES,
    });
  }

  return NextResponse.redirect(dialogUrl);
}
