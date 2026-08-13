import { withTenantGuard } from "@/lib/api/tenant-guard";
import { json } from "@/lib/api/http";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

export const GET = withTenantGuard(Permission.MembersRead, async (_request, tenant) => {
  const members = await prisma.organizationMember.findMany({
    where: {
      organizationId: tenant.tenantId,
    },
    orderBy: { createdAt: "asc" },
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

  return json({ members });
});
