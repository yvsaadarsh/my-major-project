import { NextRequest } from "next/server";

import { json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { requireTaskForTenant } from "@/lib/tenant/queries";
import { taskCommentCreateSchema } from "@/lib/validators";

type Params = {
  taskId: string;
};

export const POST = withTenantGuard<Params>(
  Permission.TasksComment,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { taskId } = await context.params;
    const input = await parseJson(request, taskCommentCreateSchema);

    await requireTaskForTenant(tenant.tenantId, taskId);

    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.taskComment.create({
        data: {
          authorUserId: tenant.user.id,
          body: input.body,
          organizationId: tenant.tenantId,
          taskId,
        },
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
      });

      await tx.activityLog.create({
        data: {
          action: "task.comment_created",
          actorUserId: tenant.user.id,
          entityId: taskId,
          entityType: "task",
          metadata: {
            commentId: created.id,
          },
          organizationId: tenant.tenantId,
        },
      });

      return created;
    });

    return json({ comment }, 201);
  },
);
