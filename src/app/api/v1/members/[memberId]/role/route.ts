import { NextRequest } from "next/server";

import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { assertNotLastActiveAdmin } from "@/lib/tenant/queries";
import { memberRoleUpdateSchema } from "@/lib/validators";

type Params = {
  memberId: string;
};

export const PATCH = withTenantGuard<Params>(
  Permission.MembersManage,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { memberId } = await context.params;
    const input = await parseJson(request, memberRoleUpdateSchema);
    const member = await assertNotLastActiveAdmin(tenant.tenantId, memberId);

    if (member.userId === tenant.user.id && input.role !== "ADMIN") {
      throw new ApiError(409, "self_demote", "You cannot remove your own admin role.");
    }

    await prisma.organizationMember.updateMany({
      where: {
        id: memberId,
        organizationId: tenant.tenantId,
      },
      data: {
        role: input.role,
      },
    });

    const updatedMember = await prisma.organizationMember.findFirstOrThrow({
      where: {
        id: memberId,
        organizationId: tenant.tenantId,
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

    return json({ member: updatedMember });
  },
);
