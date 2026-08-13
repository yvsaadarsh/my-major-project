import { NextRequest } from "next/server";

import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { requireProjectForTenant } from "@/lib/tenant/queries";
import { dependencyCreateSchema } from "@/lib/validators";
import { wouldCreateCycle } from "@/lib/domain/dependency-risk";

type Params = {
  projectId: string;
};

/**
 * Edges relevant to a project.
 *
 * Since dependencies became tenant-scoped rather than project-scoped, "this
 * project's dependencies" means an edge with EITHER endpoint in the project.
 * Filtering on one side only would hide inbound constraints from other projects
 * — the precise blindness cross-project dependencies were added to remove.
 */
const relevantToProject = (organizationId: string, projectId: string) => ({
  organizationId,
  OR: [{ sourceTask: { projectId } }, { targetTask: { projectId } }],
});

/** Both endpoints, with their project, so the UI can label crossings. */
const EDGE_SELECT = {
  id: true,
  type: true,
  createdAt: true,
  sourceTask: {
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      project: { select: { id: true, name: true } },
    },
  },
  targetTask: {
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      project: { select: { id: true, name: true } },
    },
  },
} as const;

export const GET = withTenantGuard<Params>(
  Permission.TasksRead,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;

    await requireProjectForTenant(tenant.tenantId, projectId);

    const rows = await prisma.taskDependency.findMany({
      where: relevantToProject(tenant.tenantId, projectId),
      orderBy: { createdAt: "desc" },
      select: EDGE_SELECT,
    });

    // Classify each edge relative to *this* project, so the UI can distinguish
    // "we are blocking someone else" from "someone else is blocking us" — the
    // two need different actions from the viewer.
    const dependencies = rows.map((row) => {
      const sourceInside = row.sourceTask.projectId === projectId;
      const targetInside = row.targetTask.projectId === projectId;

      return {
        ...row,
        crossProject: !sourceInside || !targetInside,
        direction: sourceInside && targetInside ? "internal" : sourceInside ? "outbound" : "inbound",
      };
    });

    return json({
      dependencies,
      summary: {
        inbound: dependencies.filter((d) => d.direction === "inbound").length,
        internal: dependencies.filter((d) => d.direction === "internal").length,
        outbound: dependencies.filter((d) => d.direction === "outbound").length,
        total: dependencies.length,
      },
    });
  },
);

export const POST = withTenantGuard<Params>(
  Permission.TasksUpdate,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;
    const input = await parseJson(request, dependencyCreateSchema);

    await requireProjectForTenant(tenant.tenantId, projectId);

    // Both tasks must be in the tenant; they no longer need to share a project.
    // Fetched rather than counted so the error can say which project each task
    // is actually in, and so at least one can be confirmed to be in the project
    // being edited.
    const endpoints = await prisma.task.findMany({
      where: {
        id: { in: [input.sourceTaskId, input.targetTaskId] },
        organizationId: tenant.tenantId,
      },
      select: { id: true, projectId: true, title: true },
    });

    if (endpoints.length !== 2) {
      throw new ApiError(
        422,
        "invalid_dependency_tasks",
        "Both tasks must exist in this organization.",
      );
    }

    // Anchor the edge to the project being edited. Without this, this endpoint
    // would let a caller create a dependency between two tasks in two *other*
    // projects while nominally posting to this one — surprising, and it would
    // make the audit trail misleading about where the change originated.
    if (!endpoints.some((task) => task.projectId === projectId)) {
      throw new ApiError(
        422,
        "dependency_outside_project",
        "At least one of the two tasks must belong to the project you are editing.",
      );
    }

    // `BLOCKS` reads source → target; `DEPENDS_ON` is the same relation stated
    // from the other end. Normalize before the cycle check so both forms are
    // tested against the same direction.
    const blockerTaskId = input.type === "DEPENDS_ON" ? input.targetTaskId : input.sourceTaskId;
    const blockedTaskId = input.type === "DEPENDS_ON" ? input.sourceTaskId : input.targetTaskId;

    // RELATED_TO carries no ordering, so it cannot create a deadlock and is not
    // cycle-checked. The previous implementation checked it, which meant merely
    // marking two tasks as related could be rejected as circular.
    if (input.type !== "RELATED_TO") {
      // Tenant-wide, not project-scoped: a chain can leave this project and come
      // back, so a project-scoped check would miss the loop entirely.
      const allDependencies = await prisma.taskDependency.findMany({
        where: { organizationId: tenant.tenantId },
        select: { id: true, sourceTaskId: true, targetTaskId: true, type: true },
      });

      if (wouldCreateCycle(blockerTaskId, blockedTaskId, allDependencies)) {
        throw new ApiError(
          409,
          "circular_dependency",
          "This dependency would create a circular dependency chain.",
        );
      }
    }

    const dependency = await prisma.$transaction(async (tx) => {
      const created = await tx.taskDependency.create({
        data: {
          createdByUserId: tenant.user.id,
          organizationId: tenant.tenantId,
          sourceTaskId: input.sourceTaskId,
          targetTaskId: input.targetTaskId,
          type: input.type,
        },
        select: EDGE_SELECT,
      });

      await tx.activityLog.create({
        data: {
          action: "dependency.created",
          actorUserId: tenant.user.id,
          entityId: created.id,
          entityType: "dependency",
          metadata: {
            // The project the edit was made from, plus both endpoints' projects,
            // so a cross-project link is legible in the audit trail without
            // re-querying the tasks.
            crossProject: created.sourceTask.projectId !== created.targetTask.projectId,
            editedFromProjectId: projectId,
            sourceProjectId: created.sourceTask.projectId,
            sourceTaskId: input.sourceTaskId,
            targetProjectId: created.targetTask.projectId,
            targetTaskId: input.targetTaskId,
            type: created.type,
          },
          organizationId: tenant.tenantId,
        },
      });

      return created;
    });

    return json(
      {
        dependency: {
          ...dependency,
          crossProject: dependency.sourceTask.projectId !== dependency.targetTask.projectId,
        },
      },
      201,
    );
  },
);
