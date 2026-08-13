import { NextRequest, NextResponse } from "next/server";

import { ApiError, handleApiError, parseJson } from "@/lib/api/http";
import { requireAuthenticatedUser } from "@/lib/auth/context";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { assessPassword } from "@/lib/domain/auth-policy";
import { prisma } from "@/lib/db";
import { passwordChangeSchema } from "@/lib/validators";

/**
 * Change your own password.
 *
 * Four things happen here, in this order, and the order matters:
 *
 * 1. **Re-authenticate.** The current password is required even though the
 *    caller already holds a valid session. A stolen session cookie must not be
 *    enough to take permanent ownership of the account by changing its
 *    password — that is the difference between a session compromise and an
 *    account compromise.
 * 2. **Enforce the policy** on the new password, same as registration.
 * 3. **Reject no-ops.** Re-submitting the current password is refused, because
 *    silently succeeding would suggest the password rotated when it did not.
 * 4. **Bump the session epoch**, invalidating every token minted before now,
 *    then immediately re-issue a fresh cookie for *this* session. The net
 *    effect is exactly what a user expects from "change my password": every
 *    other device is signed out, and the device they are using stays in.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUser();
    const input = await parseJson(request, passwordChangeSchema);

    const user = await prisma.user.findUnique({
      where: { id: auth.user.id },
      select: { id: true, email: true, name: true, passwordHash: true, sessionEpoch: true },
    });

    if (!user) {
      throw new ApiError(401, "invalid_session", "Session user no longer exists.");
    }

    const currentMatches = await verifyPassword(input.currentPassword, user.passwordHash);

    if (!currentMatches) {
      // No lockout counter here: the caller already proved they hold a valid
      // session, so this is not an anonymous guessing surface. It is still a
      // 401 rather than a 422 because the credential, not the payload, is wrong.
      throw new ApiError(401, "invalid_credentials", "Your current password is incorrect.");
    }

    const assessment = assessPassword(input.newPassword, {
      email: user.email,
      name: user.name,
    });

    if (!assessment.acceptable) {
      throw new ApiError(422, "weak_password", assessment.problems[0], {
        problems: assessment.problems,
        score: assessment.score,
        suggestions: assessment.suggestions,
      });
    }

    const reused = await verifyPassword(input.newPassword, user.passwordHash);

    if (reused) {
      throw new ApiError(
        422,
        "password_unchanged",
        "Your new password must be different from your current one.",
      );
    }

    const now = new Date();
    const nextEpoch = user.sessionEpoch + 1;

    await prisma.user.update({
      data: {
        // Rotating the password also clears any lockout: the credential that was
        // being guessed no longer exists, so continuing to punish the owner of
        // the account would be pointless.
        failedLoginCount: 0,
        lastFailedLoginAt: null,
        lockedUntil: null,
        passwordChangedAt: now,
        passwordHash: await hashPassword(input.newPassword),
        sessionEpoch: nextEpoch,
      },
      where: { id: user.id },
    });

    // Re-issue this session under the new epoch so the current device is not
    // logged out by the revocation it just triggered.
    const token = await createSessionToken({
      activeOrganizationId: auth.activeOrganizationId,
      sessionEpoch: nextEpoch,
      userId: user.id,
    });

    const response = NextResponse.json({
      otherSessionsSignedOut: true,
      passwordChangedAt: now.toISOString(),
    });

    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());

    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
