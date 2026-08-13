import { NextRequest, NextResponse } from "next/server";

import { MembershipStatus } from "@/generated/prisma/client";
import { ApiError, handleApiError, parseJson } from "@/lib/api/http";
import {
  LoginOutcome,
  applyLoginFailure,
  applyLoginSuccess,
  decoyPasswordHash,
  recordLoginAttempt,
  toLockoutState,
} from "@/lib/auth/login-guard";
import { verifyPassword } from "@/lib/auth/password";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth/session";
import {
  describeLockout,
  isLocked,
  lockRemainingSeconds,
} from "@/lib/domain/auth-policy";
import { prisma } from "@/lib/db";
import { loginSchema } from "@/lib/validators";

/**
 * Sign in.
 *
 * Three properties this handler is written to guarantee:
 *
 * 1. **No account enumeration.** Whether the email exists or not, the response
 *    is the same `401 invalid_credentials` with the same message, and the same
 *    bcrypt work is performed (against a decoy hash when there is no user), so
 *    the two cases are indistinguishable by both body and timing.
 *
 * 2. **Brute force is expensive.** Consecutive failures inside a rolling window
 *    lock the account with exponential backoff. The counter lives on the user
 *    row, not in process memory, because serverless instances share no state.
 *
 * 3. **Attempts are auditable.** Every outcome is appended to `login_attempts`
 *    with a salted IP hash, so a credential-stuffing sweep is visible after the
 *    fact without retaining raw addresses.
 */
export async function POST(request: NextRequest) {
  try {
    const input = await parseJson(request, loginSchema);
    const now = new Date();

    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        createdAt: true,
        updatedAt: true,
        failedLoginCount: true,
        lockedUntil: true,
        lastFailedLoginAt: true,
        sessionEpoch: true,
        memberships: {
          where: { status: MembershipStatus.ACTIVE },
          orderBy: { createdAt: "asc" },
          select: {
            organizationId: true,
            role: true,
            organization: {
              select: { id: true, name: true, slug: true },
            },
          },
        },
      },
    });

    // Locked accounts are refused before the password is checked. We answer 423
    // rather than 401 because the credentials were never evaluated — telling the
    // user "wait 2 minutes" is both honest and more useful than "wrong
    // password". This does reveal that the address is registered, which is an
    // accepted trade: an attacker who has already triggered a lock has learned
    // that anyway, and hiding it would leave the real user unable to understand
    // why a correct password is failing.
    if (user && isLocked(toLockoutState(user), now)) {
      const seconds = lockRemainingSeconds(toLockoutState(user), now);

      await recordLoginAttempt({
        email: input.email,
        outcome: LoginOutcome.LOCKED,
        request,
        userId: user.id,
      });

      throw new ApiError(
        423,
        "account_locked",
        `Too many failed sign-in attempts. Try again in ${describeLockout(seconds)}.`,
        { retryAfterSeconds: seconds },
        { "Retry-After": String(seconds) },
      );
    }

    // Always run one bcrypt comparison, so the unknown-email path costs the same
    // as the wrong-password path. See `decoyPasswordHash`.
    const comparisonHash = user?.passwordHash ?? (await decoyPasswordHash());
    const passwordMatches = await verifyPassword(input.password, comparisonHash);

    if (!user) {
      await recordLoginAttempt({
        email: input.email,
        outcome: LoginOutcome.UNKNOWN_EMAIL,
        request,
      });

      throw new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
    }

    if (!passwordMatches) {
      const next = await applyLoginFailure(user, now);

      await recordLoginAttempt({
        email: input.email,
        outcome: LoginOutcome.INVALID_PASSWORD,
        request,
        userId: user.id,
      });

      // If that failure crossed the threshold, say so — the user is about to be
      // confused by a correct password failing, and silence would be worse.
      if (isLocked(next, now)) {
        const seconds = lockRemainingSeconds(next, now);

        throw new ApiError(
          423,
          "account_locked",
          `Too many failed sign-in attempts. Try again in ${describeLockout(seconds)}.`,
          { retryAfterSeconds: seconds },
          { "Retry-After": String(seconds) },
        );
      }

      throw new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
    }

    await applyLoginSuccess(user, now);
    await recordLoginAttempt({
      email: input.email,
      outcome: LoginOutcome.SUCCESS,
      request,
      userId: user.id,
    });

    const activeMembership = user.memberships[0] ?? null;

    const token = await createSessionToken({
      activeOrganizationId: activeMembership?.organizationId ?? null,
      sessionEpoch: user.sessionEpoch,
      userId: user.id,
    });

    const response = NextResponse.json({
      activeOrganization: activeMembership?.organization ?? null,
      needsOrganization: !activeMembership,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });

    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());

    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
