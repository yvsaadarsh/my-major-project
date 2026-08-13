import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { requireTaskForTenant } from "@/lib/tenant/queries";

type Params = {
  taskId: string;
};

export const GET = withTenantGuard<Params>(
  Permission.TasksRead,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { taskId } = await context.params;

    await requireTaskForTenant(tenant.tenantId, taskId);

    const activity = await prisma.activityLog.findMany({
      where: {
        organizationId: tenant.tenantId,
        entityType: "task",
        entityId: taskId,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        action: true,
        metadata: true,
        createdAt: true,
        actor: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return json({ activity });
  },
);
