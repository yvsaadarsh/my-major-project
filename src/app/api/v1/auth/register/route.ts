import { NextRequest, NextResponse } from "next/server";

import { ApiError, handleApiError, parseJson } from "@/lib/api/http";
import { hashPassword } from "@/lib/auth/password";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { assessPassword } from "@/lib/domain/auth-policy";
import { prisma } from "@/lib/db";
import { registerSchema } from "@/lib/validators";

/**
 * Create an account.
 *
 * Password strength is enforced here, server-side, using the same pure policy
 * the UI meter renders from — so the meter can never promise something the API
 * then rejects, and a client that skips the meter entirely still cannot store a
 * weak password.
 *
 * On the enumeration question: registration necessarily reveals whether an
 * email is taken (there is no way to create a second account on the same
 * address and no way to pretend we did). We accept that here and instead ensure
 * the *sign-in* path leaks nothing, which is where an attacker would actually
 * sweep a list of addresses.
 */
export async function POST(request: NextRequest) {
  try {
    const input = await parseJson(request, registerSchema);

    // Reject weak passwords before doing any database work. The assessment is
    // pure and cheap, so there is no reason to hit Postgres first.
    const assessment = assessPassword(input.password, {
      email: input.email,
      name: input.name,
    });

    if (!assessment.acceptable) {
      throw new ApiError(422, "weak_password", assessment.problems[0], {
        problems: assessment.problems,
        score: assessment.score,
        suggestions: assessment.suggestions,
      });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ApiError(409, "user_exists", "An account with this email already exists.");
    }

    const passwordHash = await hashPassword(input.password);
    const now = new Date();

    const user = await prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash,
        passwordChangedAt: now,
      },
      select: {
        id: true,
        name: true,
        email: true,
        sessionEpoch: true,
      },
    });

    const token = await createSessionToken({
      activeOrganizationId: null,
      sessionEpoch: user.sessionEpoch,
      userId: user.id,
    });

    const response = NextResponse.json({
      needsOrganization: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });

    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());

    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
