import { NextRequest } from "next/server";

import { empty, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { updateTaskForTenant } from "@/lib/tasks/update-task";
import { requireTaskForTenant } from "@/lib/tenant/queries";
import { taskUpdateSchema } from "@/lib/validators";

type Params = {
  taskId: string;
};

export const GET = withTenantGuard<Params>(
  Permission.TasksRead,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { taskId } = await context.params;

    const task = await prisma.task.findFirst({
      where: {
        id: taskId,
        organizationId: tenant.tenantId,
      },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        dueDate: true,
        rating: true,
        completedAt: true,
        milestoneId: true,
        parentTaskId: true,
        createdAt: true,
        updatedAt: true,
        assignedTo: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        comments: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            body: true,
            createdAt: true,
            author: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        project: {
          select: {
            id: true,
            name: true,
          },
        },
        parentTask: {
          select: {
            id: true,
            title: true,
            status: true,
          },
        },
        subtasks: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            assignedTo: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!task) {
      await requireTaskForTenant(tenant.tenantId, taskId);
    }

    return json({ task });
  },
);

/**
 * No permission is passed to the guard: a MEMBER may legitimately reach this
 * route to move their own task's status. `updateTaskForTenant` authorizes by
 * the *shape* of the change, which the permission matrix cannot express.
 */
export const PATCH = withTenantGuard<Params>(
  undefined,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { taskId } = await context.params;
    const input = await parseJson(request, taskUpdateSchema);

    return json({ task: await updateTaskForTenant(tenant, taskId, input) });
  },
);

export const DELETE = withTenantGuard<Params>(
  Permission.TasksDelete,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { taskId } = await context.params;

    await requireTaskForTenant(tenant.tenantId, taskId);
    await prisma.task.deleteMany({
      where: {
        id: taskId,
        organizationId: tenant.tenantId,
      },
    });

    return empty();
  },
);
