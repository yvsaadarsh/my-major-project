import { createHash, randomBytes } from "node:crypto";

import { LoginOutcome } from "@/generated/prisma/client";
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import {
  registerFailure,
  registerSuccess,
  type LockoutState,
} from "@/lib/domain/auth-policy";

/**
 * Impure adapter between the pure lockout policy and the database.
 *
 * The decisions ("is this locked?", "how long is the next lock?") all live in
 * `@/lib/domain/auth-policy`, which is tested in isolation. This file only
 * translates those decisions into reads and writes, so there is exactly one
 * place where lockout policy can change and exactly one place where it touches
 * Postgres.
 */

/** Columns the lockout logic needs. Kept narrow so nothing else leaks out. */
export type LockoutColumns = {
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastFailedLoginAt: Date | null;
};

export function toLockoutState(columns: LockoutColumns): LockoutState {
  return {
    failedCount: columns.failedLoginCount,
    lastFailedAt: columns.lastFailedLoginAt,
    lockedUntil: columns.lockedUntil,
  };
}

/**
 * Hash a client IP before storing it.
 *
 * We want to group attempts by source without retaining an identifier we have
 * no product use for. Salting with SESSION_SECRET means the hashes are useless
 * to anyone who obtains only the database, and rotating that secret renders old
 * hashes uncorrelatable — which is the desired direction of failure.
 */
export function hashIp(ip: string | null): string | null {
  if (!ip) {
    return null;
  }

  const salt = process.env.SESSION_SECRET ?? "";

  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 64);
}

/**
 * Best-effort client IP.
 *
 * Behind Vercel's proxy the original address is the first entry of
 * `x-forwarded-for`. We deliberately do not trust this for anything
 * security-critical — it is attacker-controlled and only ever used for grouping
 * in the forensic log, never for authorization or for the lockout counter
 * (which keys off the account, so spoofing the header cannot bypass it).
 */
export function clientIpFrom(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }

  return request.headers.get("x-real-ip")?.trim() ?? null;
}

/** Truncate a user agent to the column width, tolerating a missing header. */
function normalizeUserAgent(request: Request): string | null {
  const agent = request.headers.get("user-agent");

  if (!agent) {
    return null;
  }

  return agent.slice(0, 400);
}

/**
 * Append one row to the sign-in attempt log.
 *
 * Failures here are swallowed on purpose: an audit-log write must never be the
 * reason a legitimate user cannot sign in, and must never turn a clean 401 into
 * a 500 that reveals the write failed. The row is nice to have; the auth
 * decision is not negotiable.
 */
export async function recordLoginAttempt(input: {
  email: string;
  outcome: LoginOutcome;
  request: Request;
  userId?: string | null;
}): Promise<void> {
  try {
    await prisma.loginAttempt.create({
      data: {
        email: input.email.slice(0, 320),
        ipHash: hashIp(clientIpFrom(input.request)),
        outcome: input.outcome,
        userAgent: normalizeUserAgent(input.request),
        userId: input.userId ?? null,
      },
    });
  } catch {
    // Intentionally ignored — see the note above.
  }
}

/**
 * Fold a failed attempt into the user's stored lockout state.
 *
 * Returns the state that was persisted, so the caller can decide whether to
 * answer 401 (still under the threshold) or 423 (now locked) without a second
 * read.
 */
export async function applyLoginFailure(
  user: { id: string } & LockoutColumns,
  now: Date,
): Promise<LockoutState> {
  const next = registerFailure(toLockoutState(user), now);

  await prisma.user.update({
    data: {
      failedLoginCount: next.failedCount,
      lastFailedLoginAt: next.lastFailedAt,
      lockedUntil: next.lockedUntil,
    },
    where: { id: user.id },
  });

  return next;
}

/**
 * Clear lockout state after a successful sign-in and stamp the login time.
 *
 * We only write when there is something to clear. A user who signs in cleanly
 * every day should not generate a pointless UPDATE of three null columns on
 * every request — but `lastLoginAt` is always worth recording, so the write
 * happens either way and simply carries fewer changes in the common case.
 */
export async function applyLoginSuccess(
  user: { id: string } & LockoutColumns,
  now: Date,
): Promise<LockoutState> {
  const cleared = registerSuccess();
  const hadFailures =
    user.failedLoginCount !== 0 || user.lockedUntil !== null || user.lastFailedLoginAt !== null;

  await prisma.user.update({
    data: hadFailures
      ? {
          failedLoginCount: cleared.failedCount,
          lastFailedLoginAt: cleared.lastFailedAt,
          lastLoginAt: now,
          lockedUntil: cleared.lockedUntil,
        }
      : { lastLoginAt: now },
    where: { id: user.id },
  });

  return cleared;
}

/**
 * A bcrypt hash of a value nobody knows, used to burn the same CPU time when
 * the email does not exist as when it does.
 *
 * Why this matters: without it, "unknown email" returns in about a millisecond
 * while "wrong password" takes the ~250 ms a cost-12 bcrypt comparison needs.
 * That gap is a reliable account-enumeration oracle — an attacker can discover
 * which addresses are registered without ever guessing a password. Comparing
 * against a decoy makes both paths cost the same.
 *
 * The hash is derived once per process from a random secret rather than being
 * hard-coded. A literal would be a magic constant that has to be kept a valid
 * bcrypt digest forever (an invalid one silently returns false *immediately*,
 * quietly reintroducing the timing gap this exists to close), and it could be
 * mistaken for a real credential. Deriving it costs one extra hash on the first
 * unknown-email attempt after a cold start, then nothing.
 */
let decoyHashPromise: Promise<string> | null = null;

export function decoyPasswordHash(): Promise<string> {
  if (decoyHashPromise === null) {
    decoyHashPromise = hashPassword(randomBytes(32).toString("hex"));
  }

  return decoyHashPromise;
}

export { LoginOutcome };
