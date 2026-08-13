import { NextRequest } from "next/server";

import { json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { requireProjectForTenant } from "@/lib/tenant/queries";
import { milestoneCreateSchema } from "@/lib/validators";

type Params = {
  projectId: string;
};

export const GET = withTenantGuard<Params>(
  Permission.ProjectsRead,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;

    await requireProjectForTenant(tenant.tenantId, projectId);

    const records = await prisma.milestone.findMany({
      where: {
        organizationId: tenant.tenantId,
        projectId,
      },
      orderBy: { dueDate: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        dueDate: true,
        status: true,
        tasks: { select: { status: true } },
      },
    });

    const milestones = records.map(({ tasks, ...milestone }) => {
      const taskTotal = tasks.length;
      const taskCompleted = tasks.filter((task) => task.status === "DONE").length;

      return {
        ...milestone,
        taskTotal,
        taskCompleted,
        completion: taskTotal ? Math.round((taskCompleted / taskTotal) * 100) : 0,
      };
    });

    return json({ milestones });
  },
);

export const POST = withTenantGuard<Params>(
  Permission.ProjectsUpdate,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;
    const input = await parseJson(request, milestoneCreateSchema);

    await requireProjectForTenant(tenant.tenantId, projectId);

    const milestone = await prisma.$transaction(async (tx) => {
      const created = await tx.milestone.create({
        data: {
          createdByUserId: tenant.user.id,
          description: input.description,
          dueDate: new Date(input.dueDate),
          name: input.name,
          organizationId: tenant.tenantId,
          projectId,
          status: input.status,
        },
        select: {
          id: true,
          name: true,
          description: true,
          dueDate: true,
          status: true,
        },
      });

      await tx.activityLog.create({
        data: {
          action: "milestone.created",
          actorUserId: tenant.user.id,
          entityId: created.id,
          entityType: "milestone",
          metadata: {
            dueDate: created.dueDate.toISOString(),
            projectId,
            status: created.status,
          },
          organizationId: tenant.tenantId,
        },
      });

      return created;
    });

    return json({ milestone }, 201);
  },
);
