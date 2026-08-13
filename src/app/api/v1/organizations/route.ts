import { NextRequest } from "next/server";

import { MembershipRole } from "@/generated/prisma/client";
import { handleApiError, json, parseJson } from "@/lib/api/http";
import { requireAuthenticatedUser } from "@/lib/auth/context";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { uniqueOrganizationSlug } from "@/lib/slug";
import { organizationCreateSchema } from "@/lib/validators";

export async function GET() {
  try {
    const auth = await requireAuthenticatedUser();

    return json({
      activeOrganizationId: auth.activeOrganizationId,
      organizations: auth.memberships.map((membership) => ({
        membershipId: membership.id,
        organization: membership.organization,
        role: membership.role,
        status: membership.status,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUser();
    const input = await parseJson(request, organizationCreateSchema);
    const slug = await uniqueOrganizationSlug(input.name);

    const result = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          createdByUserId: auth.user.id,
          name: input.name,
          slug,
        },
      });

      const membership = await tx.organizationMember.create({
        data: {
          organizationId: organization.id,
          role: MembershipRole.ADMIN,
          userId: auth.user.id,
        },
      });

      return { membership, organization };
    });

    const token = await createSessionToken({
      activeOrganizationId: result.organization.id,
      userId: auth.user.id,
    });
    const response = json(result, 201);

    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());

    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
