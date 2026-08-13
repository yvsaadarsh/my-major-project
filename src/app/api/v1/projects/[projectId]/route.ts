import { NextRequest } from "next/server";

import { empty, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { requireProjectForTenant } from "@/lib/tenant/queries";
import { projectUpdateSchema } from "@/lib/validators";

type Params = {
  projectId: string;
};

export const GET = withTenantGuard<Params>(
  Permission.ProjectsRead,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        organizationId: tenant.tenantId,
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

    if (!project) {
      await requireProjectForTenant(tenant.tenantId, projectId);
    }

    return json({ project });
  },
);

export const PATCH = withTenantGuard<Params>(
  Permission.ProjectsUpdate,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;
    const input = await parseJson(request, projectUpdateSchema);

    await requireProjectForTenant(tenant.tenantId, projectId);

    await prisma.project.updateMany({
      where: {
        id: projectId,
        organizationId: tenant.tenantId,
      },
      data: input,
    });

    const project = await prisma.project.findFirstOrThrow({
      where: {
        id: projectId,
        organizationId: tenant.tenantId,
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

    return json({ project });
  },
);

export const DELETE = withTenantGuard<Params>(
  Permission.ProjectsDelete,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { projectId } = await context.params;

    await requireProjectForTenant(tenant.tenantId, projectId);
    await prisma.project.deleteMany({
      where: {
        id: projectId,
        organizationId: tenant.tenantId,
      },
    });

    return empty();
  },
);
