/**
 * Task update, as a service.
 *
 * Extracted from `PATCH /api/v1/tasks/[taskId]`, which had grown to ~200 lines
 * and was doing far more than AGENTS.md's "parse → authorize → delegate". The
 * route now parses the body and calls `updateTaskForTenant`; everything that
 * follows lives here.
 *
 * The order of operations is deliberate and preserved exactly:
 *
 *   1. load the task under the tenant guard (404s another org's task)
 *   2. authorize the *shape* of the change, not just the verb
 *   3. validate every referenced id belongs to this tenant and project
 *   4. write, read back, and log inside one transaction
 *   5. dispatch automations only after that transaction has committed
 *
 * Step 5 is outside the transaction on purpose: the executor is idempotent and
 * never throws, but an automation failure must not roll back a user's edit.
 */

import { MembershipRole, Prisma } from "@/generated/prisma/client";
import type { TenantRequestContext } from "@/lib/auth/context";
import { ApiError } from "@/lib/api/http";
import { runAutomationsForEvent } from "@/lib/automation/executor";
import { prisma } from "@/lib/db";
import { wouldCreateSubtaskCycle } from "@/lib/domain/work-intelligence";
import { assertPermission, Permission } from "@/lib/rbac";
import {
  requireActiveMemberForTenant,
  requireTaskForTenant,
} from "@/lib/tenant/queries";
import type { taskUpdateSchema } from "@/lib/validators";
import type { z } from "zod";

export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

/** Fields returned to the client after an update. */
const UPDATED_TASK_SELECT = {
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
} as const;

type LoadedTask = Awaited<ReturnType<typeof requireTaskForTenant>>;

/**
 * Authorize the change by its *shape*, not just the verb.
 *
 * A MEMBER may move a task they own between statuses and nothing else. That is
 * narrower than the permission matrix can express — it depends on which fields
 * are present and on who the task is assigned to — so it is decided here rather
 * than being smeared across the route as an inline role check.
 */
function assertMayApply(
  tenant: TenantRequestContext,
  task: LoadedTask,
  requestedFields: string[],
): void {
  if (tenant.role !== MembershipRole.MEMBER) {
    assertPermission(tenant.role, Permission.TasksUpdate);
    return;
  }

  const statusOnlyUpdate = requestedFields.length === 1 && requestedFields[0] === "status";

  if (!statusOnlyUpdate || task.assignedToUserId !== tenant.user.id) {
    throw new ApiError(
      403,
      "forbidden",
      "Team members can only update the status of tasks assigned to them.",
    );
  }
}

/**
 * Every id in the payload must resolve inside this tenant, and inside this
 * task's project where the schema implies it.
 *
 * Done before the transaction so a bad reference costs no write, and so the
 * caller gets one specific error rather than a foreign-key violation.
 */
async function assertReferencesResolve(
  tenant: TenantRequestContext,
  task: LoadedTask,
  taskId: string,
  input: TaskUpdateInput,
): Promise<void> {
  if (input.assignedToUserId) {
    await requireActiveMemberForTenant(tenant.tenantId, input.assignedToUserId);
  }

  if (input.parentTaskId) {
    if (input.parentTaskId === taskId) {
      throw new ApiError(409, "circular_subtask", "A task cannot be its own parent.");
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
}

/**
 * Write the change and record it, atomically.
 *
 * The activity row carries the before/after due date whenever it actually
 * moves. This is the only source of schedule-slippage history in the product:
 * the tasks table stores the current due date, so without this the fact that a
 * date was pushed is lost the moment it is overwritten. The keys are omitted
 * entirely when the date did not change, which keeps the log readable and lets
 * a reader treat "absent" as "no schedule change" (see
 * `scheduleChangesFromActivity`).
 *
 * History only exists from the deploy that introduced this, so slippage for
 * anything earlier is unrecoverable — the intelligence layer reports low
 * confidence rather than claiming the schedule was stable.
 */
async function applyUpdate(
  tenant: TenantRequestContext,
  task: LoadedTask,
  taskId: string,
  input: TaskUpdateInput,
  requestedFields: string[],
) {
  const completedAtUpdate =
    input.status === undefined
      ? undefined
      : input.status === "DONE"
        ? task.completedAt ?? new Date()
        : null;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
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
      select: UPDATED_TASK_SELECT,
    });

    const dueDateChanged =
      (task.dueDate?.getTime() ?? null) !== (updated.dueDate?.getTime() ?? null);

    await tx.activityLog.create({
      data: {
        action:
          input.status && input.status !== task.status
            ? "task.status_changed"
            : "task.updated",
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
}

/**
 * Fire status-change automations for an already-committed update.
 *
 * Swallows everything: the executor is idempotent and does not throw by
 * design, but a bug in a rule must never surface as a failed task update the
 * user has already been told succeeded.
 */
async function dispatchStatusAutomations(
  tenant: TenantRequestContext,
  task: LoadedTask,
  updated: Awaited<ReturnType<typeof applyUpdate>>,
): Promise<void> {
  try {
    await runAutomationsForEvent(prisma, tenant.tenantId, tenant.user.id, {
      kind: "TASK_STATUS_CHANGED",
      task: {
        id: updated.id,
        title: updated.title,
        status: updated.status,
        priority: updated.priority,
        projectId: task.projectId,
        milestoneId: updated.milestoneId,
        dueDate: updated.dueDate,
      },
      fromStatus: task.status,
      toStatus: updated.status,
    });
  } catch (error) {
    console.error("Automation dispatch failed for task status change", error);
  }
}

/**
 * Apply a validated update to one tenant-scoped task.
 *
 * `input` must already have passed `taskUpdateSchema`; this function owns
 * authorization, referential validation, persistence and dispatch.
 */
export async function updateTaskForTenant(
  tenant: TenantRequestContext,
  taskId: string,
  input: TaskUpdateInput,
) {
  const task = await requireTaskForTenant(tenant.tenantId, taskId);
  const requestedFields = Object.keys(input);

  assertMayApply(tenant, task, requestedFields);
  await assertReferencesResolve(tenant, task, taskId, input);

  const updated = await applyUpdate(tenant, task, taskId, input, requestedFields);

  if (input.status !== undefined && input.status !== task.status) {
    await dispatchStatusAutomations(tenant, task, updated);
  }

  return updated;
}
