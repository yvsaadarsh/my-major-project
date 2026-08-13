import { NextRequest } from "next/server";

import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import {
  requireActiveMemberForTenant,
  requireProjectForTenant,
} from "@/lib/tenant/queries";
import { taskCreateSchema } from "@/lib/validators";

type Params = {
  projectId: string;
};

export const GET = withTenantGuard<Params>(
  Permission.TasksRead,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;

    await requireProjectForTenant(tenant.tenantId, projectId);

    const tasks = await prisma.task.findMany({
      where: {
        organizationId: tenant.tenantId,
        projectId,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        dueDate: true,
        rating: true,
        completedAt: true,
        assignedToUserId: true,
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
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        milestone: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    return json({ tasks });
  },
);

export const POST = withTenantGuard<Params>(
  Permission.TasksCreate,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;
    const input = await parseJson(request, taskCreateSchema);

    await requireProjectForTenant(tenant.tenantId, projectId);

    if (input.assignedToUserId) {
      await requireActiveMemberForTenant(tenant.tenantId, input.assignedToUserId);
    }

    if (input.parentTaskId) {
      const parentCount = await prisma.task.count({
        where: {
          id: input.parentTaskId,
          organizationId: tenant.tenantId,
          projectId,
        },
      });

      if (parentCount !== 1) {
        throw new ApiError(
          422,
          "invalid_parent_task",
          "The parent task must belong to this project and organization.",
        );
      }
    }

    if (input.milestoneId) {
      const milestoneCount = await prisma.milestone.count({
        where: {
          id: input.milestoneId,
          organizationId: tenant.tenantId,
          projectId,
        },
      });

      if (milestoneCount !== 1) {
        throw new ApiError(
          422,
          "invalid_milestone",
          "The milestone must belong to this project and organization.",
        );
      }
    }

    const task = await prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          assignedToUserId: input.assignedToUserId ?? null,
          completedAt: input.status === "DONE" ? new Date() : null,
          createdByUserId: tenant.user.id,
          description: input.description,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          milestoneId: input.milestoneId ?? null,
          organizationId: tenant.tenantId,
          parentTaskId: input.parentTaskId ?? null,
          priority: input.priority,
          projectId,
          rating: input.rating ?? null,
          status: input.status,
          title: input.title,
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
          assignedToUserId: true,
          milestoneId: true,
          parentTaskId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.activityLog.create({
        data: {
          action: "task.created",
          actorUserId: tenant.user.id,
          entityId: created.id,
          entityType: "task",
          metadata: {
            priority: created.priority,
            projectId,
            status: created.status,
            ...(created.parentTaskId ? { parentTaskId: created.parentTaskId } : {}),
            ...(created.milestoneId ? { milestoneId: created.milestoneId } : {}),
          },
          organizationId: tenant.tenantId,
        },
      });

      return created;
    });

    return json({ task }, 201);
  },
);
