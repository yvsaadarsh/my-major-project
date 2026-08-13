import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

export const GET = withTenantGuard(Permission.DashboardRead, async (_request, tenant) => {
  const tasks = await prisma.task.findMany({
    where: {
      assignedToUserId: tenant.user.id,
      organizationId: tenant.tenantId,
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      dueDate: true,
      project: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  return json({ tasks });
});
