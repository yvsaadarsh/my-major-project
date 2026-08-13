import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE_NAME = "pm_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type SessionClaims = {
  userId: string;
  activeOrganizationId?: string | null;
  /**
   * The user's `sessionEpoch` at the moment this token was minted.
   *
   * Tokens are stateless, so we cannot delete one server-side. Instead the auth
   * context compares this against the user's current epoch and rejects the
   * token if the epoch has moved on. Bumping the stored epoch is therefore how
   * a password change or "sign out everywhere" revokes live sessions.
   *
   * Optional because tokens minted before this claim existed have no epoch;
   * those are treated as epoch 0 so shipping the feature does not sign
   * everybody out. See `isSessionEpochCurrent`.
   */
  sessionEpoch?: number | null;
};

const encoder = new TextEncoder();

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters.");
  }

  return encoder.encode(secret);
}

export async function createSessionToken(claims: SessionClaims) {
  return new SignJWT({
    activeOrganizationId: claims.activeOrganizationId ?? null,
    sessionEpoch: claims.sessionEpoch ?? 0,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret());
}

export async function verifySessionToken(
  token: string
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionSecret());

    if (!payload.sub) {
      return null;
    }

    return {
      userId: payload.sub,
      activeOrganizationId:
        typeof payload.activeOrganizationId === "string"
          ? payload.activeOrganizationId
          : null,
      sessionEpoch:
        typeof payload.sessionEpoch === "number" ? payload.sessionEpoch : null,
    };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAge = SESSION_MAX_AGE_SECONDS) {
  let domain: string | undefined;

  try {
    if (process.env.NEXTAUTH_URL) {
      domain = new URL(process.env.NEXTAUTH_URL).hostname;
    }
  } catch {
    domain = undefined;
  }

  return {
    httpOnly: true,
    maxAge,
    path: "/",
    sameSite: "lax" as const,
    // Secure cookies over HTTPS in production (e.g. Vercel); off for local HTTP dev.
    secure: process.env.NODE_ENV === "production",
    // domain is intentionally omitted so the browser defaults to the request host.
    // Explicitly setting domain="localhost" causes browsers to reject the cookie
    // when accessed via an IP address.
  };
}

/**
 * Cookie options that clear the session cookie.
 *
 * Must mirror the attributes used when setting it — a browser will not replace a
 * cookie unless name, path and domain all match, so a mismatch here leaves the
 * old cookie in place and sign-out silently fails.
 */
export function clearedSessionCookieOptions() {
  return sessionCookieOptions(0);
}
