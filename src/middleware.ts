import { NextResponse } from "next/server";

import { securityHeaders } from "@/lib/security/headers";

/**
 * Applies security headers to every response.
 *
 * Deliberately does NOT do authentication. It is tempting to gate routes here,
 * but middleware runs on the Edge runtime where Prisma is unavailable, so it
 * could only check that a cookie *parses* — not that the session is still valid,
 * that the user still exists, or that their session epoch is current. A check
 * that weak is worse than none: it looks like authorization while guaranteeing
 * nothing, and invites callers to stop checking properly downstream.
 *
 * Authorization therefore stays where the database is: `requireAuthenticatedUser`
 * and `requireTenantContext` in `src/lib/auth/context.ts`, called by every route
 * handler and server component that touches tenant data.
 */
export function middleware() {
  const response = NextResponse.next();

  const headers = securityHeaders({
    isProduction: process.env.NODE_ENV === "production",
  });

  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }

  return response;
}

export const config = {
  /**
   * Everything except Next's own static output and common static assets.
   *
   * `_next/static` and `_next/image` are immutable, cached hard, and carry no
   * user data — adding headers to them costs middleware invocations for no
   * security benefit.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|woff|woff2|ttf)$).*)",
  ],
};
