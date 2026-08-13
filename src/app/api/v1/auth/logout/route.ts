import { NextRequest, NextResponse } from "next/server";

import { handleApiError } from "@/lib/api/http";
import { requireAuthenticatedUser } from "@/lib/auth/context";
import {
  clearedSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from "@/lib/auth/session";
import { prisma } from "@/lib/db";

/**
 * Sign out.
 *
 * Two modes, selected by the `everywhere` query parameter:
 *
 * - default: clears this browser's cookie. Other devices stay signed in.
 * - `?everywhere=1`: also bumps the user's session epoch, which invalidates
 *   every token minted before now — the "sign out of all devices" action.
 *
 * Clearing the cookie always succeeds even if the epoch bump cannot run (for
 * example the session was already invalid). Sign-out must never fail: a user who
 * clicks it and gets an error has no way to protect themselves, so the cookie is
 * dropped first and the revocation is best-effort on top.
 */
export async function POST(request: NextRequest) {
  try {
    const everywhere = ["1", "true", "yes"].includes(
      (request.nextUrl.searchParams.get("everywhere") ?? "").toLowerCase(),
    );

    let revokedOtherSessions = false;

    if (everywhere) {
      try {
        const auth = await requireAuthenticatedUser();

        await prisma.user.update({
          data: { sessionEpoch: { increment: 1 } },
          where: { id: auth.user.id },
        });

        revokedOtherSessions = true;
      } catch {
        // Already signed out, session revoked, or the user is gone. Nothing to
        // revoke — fall through and still clear the cookie.
      }
    }

    const response = NextResponse.json({ revokedOtherSessions });

    response.cookies.set(SESSION_COOKIE_NAME, "", clearedSessionCookieOptions());

    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
