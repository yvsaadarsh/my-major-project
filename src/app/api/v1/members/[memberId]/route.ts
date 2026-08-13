import { ApiError, empty } from "@/lib/api/http";
import { MembershipStatus } from "@/generated/prisma/client";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { assertNotLastActiveAdmin } from "@/lib/tenant/queries";

type Params = {
  memberId: string;
};

export const DELETE = withTenantGuard<Params>(
  Permission.MembersManage,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { memberId } = await context.params;
    const member = await assertNotLastActiveAdmin(tenant.tenantId, memberId);

    if (member.userId === tenant.user.id) {
      throw new ApiError(409, "self_remove", "You cannot remove yourself.");
    }

    await prisma.organizationMember.updateMany({
      where: {
        id: memberId,
        organizationId: tenant.tenantId,
      },
      data: {
        status: MembershipStatus.DISABLED,
      },
    });

    return empty();
  },
);
