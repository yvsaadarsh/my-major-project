import { TaskStatus } from "@/generated/prisma/client";
import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

export const GET = withTenantGuard(Permission.DashboardRead, async (_request, tenant) => {
  const [projectCount, taskCount, completedTaskCount, memberCount] = await Promise.all([
    prisma.project.count({
      where: { organizationId: tenant.tenantId },
    }),
    prisma.task.count({
      where: { organizationId: tenant.tenantId },
    }),
    prisma.task.count({
      where: {
        organizationId: tenant.tenantId,
        status: TaskStatus.DONE,
      },
    }),
    prisma.organizationMember.count({
      where: { organizationId: tenant.tenantId },
    }),
  ]);

  return json({
    summary: {
      completedTaskCount,
      memberCount,
      projectCount,
      taskCount,
    },
  });
});
