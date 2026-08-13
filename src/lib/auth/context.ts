import { cookies } from "next/headers";

import {
  MembershipRole,
  MembershipStatus,
  type Organization,
  type OrganizationMember,
  type User,
} from "@/generated/prisma/client";
import { ApiError } from "@/lib/api/http";
import { prisma } from "@/lib/db";
import { assertPermission, type Permission } from "@/lib/rbac";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { isSessionEpochCurrent } from "@/lib/domain/auth-policy";

type SafeUser = Pick<User, "id" | "name" | "email" | "createdAt" | "updatedAt">;

export type MembershipWithOrganization = Pick<
  OrganizationMember,
  "id" | "organizationId" | "role" | "status" | "createdAt" | "updatedAt"
> & {
  organization: Pick<Organization, "id" | "name" | "slug" | "createdAt" | "updatedAt">;
};

export type AuthenticatedRequestContext = {
  activeOrganizationId: string | null;
  memberships: MembershipWithOrganization[];
  user: SafeUser;
};

export type TenantRequestContext = {
  membership: MembershipWithOrganization;
  organization: MembershipWithOrganization["organization"];
  role: MembershipRole;
  tenantId: string;
  user: SafeUser;
};

export async function requireAuthenticatedUser(): Promise<AuthenticatedRequestContext> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    throw new ApiError(401, "unauthorized", "Authentication is required.");
  }

  const session = await verifySessionToken(token);

  if (!session) {
    throw new ApiError(401, "invalid_session", "Session is invalid or expired.");
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      updatedAt: true,
      sessionEpoch: true,
      memberships: {
        where: { status: MembershipStatus.ACTIVE },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          organizationId: true,
          role: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new ApiError(401, "invalid_session", "Session user no longer exists.");
  }

  // Stateless tokens cannot be deleted, so revocation works by epoch: a token
  // minted before the user's current epoch is refused. This is what makes
  // "password changed" and "sign out everywhere" actually end other sessions
  // rather than merely clearing one browser's cookie.
  if (!isSessionEpochCurrent(session.sessionEpoch, user.sessionEpoch)) {
    throw new ApiError(
      401,
      "session_revoked",
      "This session ended because the account password changed. Sign in again.",
    );
  }

  const activeMembership =
    user.memberships.find(
      (membership) => membership.organizationId === session.activeOrganizationId,
    ) ?? user.memberships[0];

  return {
    activeOrganizationId: activeMembership?.organizationId ?? null,
    memberships: user.memberships,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  };
}

export async function requireTenantContext(
  permission?: Permission,
): Promise<TenantRequestContext> {
  const auth = await requireAuthenticatedUser();

  if (!auth.activeOrganizationId) {
    throw new ApiError(
      403,
      "organization_required",
      "Create or join an organization before accessing tenant data.",
    );
  }

  const membership = auth.memberships.find(
    (item) => item.organizationId === auth.activeOrganizationId,
  );

  if (!membership || membership.status !== MembershipStatus.ACTIVE) {
    throw new ApiError(
      403,
      "membership_required",
      "You are not an active member of the requested organization.",
    );
  }

  if (permission) {
    assertPermission(membership.role, permission);
  }

  return {
    membership,
    organization: membership.organization,
    role: membership.role,
    tenantId: membership.organizationId,
    user: auth.user,
  };
}
