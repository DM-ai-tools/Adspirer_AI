import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const DEMO_USER_COOKIE = "adspirer_demo_user";

/**
 * Next.js 16 auth gate (proxy).
 * Uses getClaims() so JWT verification is local (after JWKS cache warm) —
 * getUser() hits Supabase Auth on every navigation and made nav feel slow.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isAppRoute =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/clients") ||
    pathname.startsWith("/workspace") ||
    pathname.startsWith("/workspace-v2") ||
    pathname.startsWith("/approvals") ||
    pathname.startsWith("/monitoring") ||
    pathname.startsWith("/competitors") ||
    pathname.startsWith("/creatives") ||
    pathname.startsWith("/audit") ||
    pathname.startsWith("/admin");

  if (!isAppRoute) {
    return NextResponse.next();
  }

  const demoMode = process.env.DEMO_MODE !== "false";
  if (demoMode) {
    const demoUser = request.cookies.get(DEMO_USER_COOKIE)?.value;
    if (!demoUser) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next();
  }

  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({
          request: { headers: request.headers },
        });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Prefer local JWT verification over Auth-server round trip.
  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();

  if (claimsError || !claimsData?.claims) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/clients/:path*",
    "/workspace/:path*",
    "/workspace-v2",
    "/workspace-v2/:path*",
    "/approvals/:path*",
    "/monitoring/:path*",
    "/competitors/:path*",
    "/creatives/:path*",
    "/audit/:path*",
    "/admin/:path*",
  ],
};
