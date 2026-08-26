import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/server/auth/session";

/**
 * The gate. Everything except the login route, the health check and static
 * assets requires a session cookie.
 *
 * The proxy only checks that a cookie is PRESENT — it does not verify the
 * signature. Verification needs the auth secret and a database read, and doing
 * it here would put that on every asset request. Real authorisation happens in
 * `requireUser()` / `requireCapability()` inside every page, action and route
 * handler, which is the only place it can be trusted anyway. This is a cheap
 * redirect for signed-out visitors, not the security boundary.
 */

const PUBLIC_PATHS = ["/login", "/api/health", "/api/auth/login", "/api/auth/logout"];

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // Everything except Next internals, the brand/font assets and the favicon.
    "/((?!_next/static|_next/image|favicon.ico|brand/|fonts/|.*\\.(?:png|jpg|jpeg|svg|ttf|woff2?)$).*)",
  ],
};
