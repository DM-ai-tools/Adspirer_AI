import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getConfig } from "@/lib/config";
import { getCurrentUser } from "@/lib/security/auth";
import { assertAdmin, assertAuthenticated } from "@/lib/authz/assert";
import { withApiHandler } from "@/lib/api/response";
import { googleAuthUrl } from "@/lib/google/oauth";

/** Start the agency's Google connection (admins only). */
export async function GET() {
  return withApiHandler(async () => {
    const user = await getCurrentUser();
    assertAuthenticated(user);
    assertAdmin(user);

    if (!getConfig().hasGoogle) {
      return NextResponse.json({ error: "Google is not configured" }, { status: 503 });
    }

    const state = randomBytes(16).toString("hex");
    const cookieStore = await cookies();
    cookieStore.set("google_oauth_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    return NextResponse.redirect(googleAuthUrl(state));
  });
}
