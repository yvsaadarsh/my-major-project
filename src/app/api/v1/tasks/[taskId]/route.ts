import { NextRequest } from "next/server";

import { MembershipRole } from "@/generated/prisma/client";
import { ApiError, empty, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { runAutomationsForEvent } from "@/lib/automation/executor";
import { prisma } from "@/lib/db";
import { wouldCreateSubtaskCycle } from "@/lib/domain/work-intelligence";
import { assertPermission, Permission } from "@/lib/rbac";
import {
  requireActiveMemberForTenant,
  requireTaskForTenant,
} from "@/lib/tenant/queries";
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

export const PATCH = withTenantGuard<Params>(
  undefined,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { taskId } = await context.params;
    const input = await parseJson(request, taskUpdateSchema);
    const task = await requireTaskForTenant(tenant.tenantId, taskId);
    const requestedFields = Object.keys(input);
    const completedAtUpdate =
      input.status === undefined
        ? undefined
        : input.status === "DONE"
          ? task.completedAt ?? new Date()
          : null;

    if (tenant.role === MembershipRole.MEMBER) {
      const statusOnlyUpdate =
        requestedFields.length === 1 && requestedFields[0] === "status";

      if (!statusOnlyUpdate || task.assignedToUserId !== tenant.user.id) {
        throw new ApiError(
          403,
          "forbidden",
          "Team members can only update the status of tasks assigned to them.",
        );
      }
    } else {
      assertPermission(tenant.role, Permission.TasksUpdate);
    }

    if (input.assignedToUserId) {
      await requireActiveMemberForTenant(tenant.tenantId, input.assignedToUserId);
    }

    if (input.parentTaskId) {
      if (input.parentTaskId === taskId) {
        throw new ApiError(
          409,
          "circular_subtask",
          "A task cannot be its own parent.",
        );
      }

      const parent = await prisma.task.findFirst({
        where: {
          id: input.parentTaskId,
          organizationId: tenant.tenantId,
          projectId: task.projectId,
        },
        select: { id: true },
      });

      if (!parent) {
        throw new ApiError(
          422,
          "invalid_parent_task",
          "The parent task must belong to this project and organization.",
        );
      }

      const projectTasks = await prisma.task.findMany({
        where: {
          organizationId: tenant.tenantId,
          projectId: task.projectId,
        },
        select: { id: true, parentTaskId: true },
      });

      if (wouldCreateSubtaskCycle(taskId, input.parentTaskId, projectTasks)) {
        throw new ApiError(
          409,
          "circular_subtask",
          "This change would make the task an ancestor of itself.",
        );
      }
    }

    if (input.milestoneId) {
      const milestone = await prisma.milestone.findFirst({
        where: {
          id: input.milestoneId,
          organizationId: tenant.tenantId,
          projectId: task.projectId,
        },
        select: { id: true },
      });

      if (!milestone) {
        throw new ApiError(
          422,
          "invalid_milestone",
          "The milestone must belong to this project and organization.",
        );
      }
    }

    const updatedTask = await prisma.$transaction(async (tx) => {
      await tx.task.updateMany({
        where: {
          id: taskId,
          organizationId: tenant.tenantId,
        },
        data: {
          assignedToUserId: input.assignedToUserId,
          description: input.description,
          dueDate:
            input.dueDate === undefined
              ? undefined
              : input.dueDate
                ? new Date(input.dueDate)
                : null,
          milestoneId: input.milestoneId,
          parentTaskId: input.parentTaskId,
          priority: input.priority,
          rating: input.rating,
          completedAt: completedAtUpdate,
          status: input.status,
          title: input.title,
        },
      });

      const updated = await tx.task.findFirstOrThrow({
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
          assignedToUserId: true,
          milestoneId: true,
          parentTaskId: true,
          rating: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Record the before/after due date whenever it actually moves.
      //
      // This is the only source of schedule-slippage history in the product:
      // the tasks table stores the current due date, so without this the fact
      // that a date was pushed is lost the moment it is overwritten. The keys
      // are omitted entirely when the date did not change, which keeps the log
      // readable and lets the reader treat "absent" as "no schedule change"
      // (see `scheduleChangesFromActivity`).
      //
      // Note: history only exists from the deploy that introduced this. Slippage
      // for anything earlier is unrecoverable, so the intelligence layer reports
      // low confidence rather than claiming the schedule was stable.
      const dueDateChanged =
        (task.dueDate?.getTime() ?? null) !== (updated.dueDate?.getTime() ?? null);

      await tx.activityLog.create({
        data: {
          action: input.status && input.status !== task.status ? "task.status_changed" : "task.updated",
          actorUserId: tenant.user.id,
          entityId: taskId,
          entityType: "task",
          metadata: {
            changedFields: requestedFields.join(","),
            fromStatus: task.status,
            toStatus: updated.status,
            ...(dueDateChanged
              ? {
                  fromDueDate: task.dueDate?.toISOString() ?? null,
                  toDueDate: updated.dueDate?.toISOString() ?? null,
                }
              : {}),
          },
          organizationId: tenant.tenantId,
        },
      });

      return updated;
    });

    // Fire automations OUTSIDE the mutation transaction (already committed). The
    // executor is fully idempotent and never throws, but we still guard here so
    // an automation failure can never fail the user's task update.
    if (input.status !== undefined && input.status !== task.status) {
      try {
        await runAutomationsForEvent(prisma, tenant.tenantId, tenant.user.id, {
          kind: "TASK_STATUS_CHANGED",
          task: {
            id: updatedTask.id,
            title: updatedTask.title,
            status: updatedTask.status,
            priority: updatedTask.priority,
            projectId: task.projectId,
            milestoneId: updatedTask.milestoneId,
            dueDate: updatedTask.dueDate,
          },
          fromStatus: task.status,
          toStatus: updatedTask.status,
        });
      } catch (error) {
        console.error("Automation dispatch failed for task status change", error);
      }
    }

    return json({ task: updatedTask });
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
