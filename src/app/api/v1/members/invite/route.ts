import { NextRequest } from "next/server";

import { MembershipStatus } from "@/generated/prisma/client";
import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { memberInviteSchema } from "@/lib/validators";

export const POST = withTenantGuard(
  Permission.MembersManage,
  async (request: NextRequest, tenant) => {
    const input = await parseJson(request, memberInviteSchema);

    const user = await prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        name: true,
        email: true,
      },
    });

    if (!user) {
      throw new ApiError(
        404,
        "user_not_found",
        "The user must register before they can be added to an organization.",
      );
    }

    const existingMembership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: tenant.tenantId,
          userId: user.id,
        },
      },
    });

    if (existingMembership && existingMembership.status !== MembershipStatus.DISABLED) {
      throw new ApiError(
        409,
        "member_exists",
        "This user is already associated with the organization.",
      );
    }

    const membership = await prisma.$transaction(async (tx) => {
      const createdOrUpdated = existingMembership
        ? await tx.organizationMember.update({
            where: { id: existingMembership.id },
            data: {
              role: input.role,
              status: MembershipStatus.ACTIVE,
            },
            select: {
              id: true,
              role: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          })
        : await tx.organizationMember.create({
            data: {
              organizationId: tenant.tenantId,
              role: input.role,
              status: MembershipStatus.ACTIVE,
              userId: user.id,
            },
            select: {
              id: true,
              role: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          });

      await tx.activityLog.create({
        data: {
          action: existingMembership ? "member.reactivated" : "member.invited",
          actorUserId: tenant.user.id,
          entityId: createdOrUpdated.id,
          entityType: "member",
          metadata: {
            role: createdOrUpdated.role,
            userEmail: createdOrUpdated.user.email,
          },
          organizationId: tenant.tenantId,
        },
      });

      return createdOrUpdated;
    });

    return json({ membership }, 201);
  },
);
