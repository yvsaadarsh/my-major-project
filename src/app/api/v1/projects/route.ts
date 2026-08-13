import { NextRequest } from "next/server";

import { json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { projectCreateSchema } from "@/lib/validators";

export const GET = withTenantGuard(Permission.ProjectsRead, async (_request, tenant) => {
  const projects = await prisma.project.findMany({
    where: {
      organizationId: tenant.tenantId,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      description: true,
      status: true,
      startDate: true,
      endDate: true,
      createdAt: true,
      updatedAt: true,
      createdBy: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      _count: {
        select: {
          tasks: true,
        },
      },
    },
  });

  return json({ projects });
});

export const POST = withTenantGuard(
  Permission.ProjectsCreate,
  async (request: NextRequest, tenant) => {
    const input = await parseJson(request, projectCreateSchema);

    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          createdByUserId: tenant.user.id,
          description: input.description,
          name: input.name,
          organizationId: tenant.tenantId,
          status: input.status,
          startDate: input.startDate,
          endDate: input.endDate,
        },
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          startDate: true,
          endDate: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.activityLog.create({
        data: {
          action: "project.created",
          actorUserId: tenant.user.id,
          entityId: created.id,
          entityType: "project",
          metadata: {
            name: created.name,
            status: created.status,
          },
          organizationId: tenant.tenantId,
        },
      });

      return created;
    });

    return json({ project }, 201);
  },
);
