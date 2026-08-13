import { NextRequest } from "next/server";

import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { hasPermission, Permission } from "@/lib/rbac";
import { requireProjectForTenant } from "@/lib/tenant/queries";
import { savedViewCreateSchema } from "@/lib/validators";

// Kept local: Next.js only permits route handler exports from a route module.
const savedViewSelect = {
  id: true,
  name: true,
  viewType: true,
  projectId: true,
  ownerUserId: true,
  isShared: true,
  config: true,
  createdAt: true,
  updatedAt: true,
  owner: {
    select: {
      id: true,
      name: true,
    },
  },
} as const;

/**
 * Lists the saved views the caller may see inside the active tenant: their own
 * views plus every shared view. When `?projectId=` is supplied, org-level views
 * (`projectId: null`) are included too because they apply to any project.
 */
export const GET = withTenantGuard(
  Permission.ProjectsRead,
  async (request: NextRequest, tenant) => {
    const requestedProjectId = request.nextUrl.searchParams.get("projectId")?.trim() ?? "";

    if (requestedProjectId) {
      await requireProjectForTenant(tenant.tenantId, requestedProjectId);
    }

    const views = await prisma.savedView.findMany({
      where: {
        organizationId: tenant.tenantId,
        AND: [
          { OR: [{ ownerUserId: tenant.user.id }, { isShared: true }] },
          ...(requestedProjectId
            ? [{ OR: [{ projectId: requestedProjectId }, { projectId: null }] }]
            : []),
        ],
      },
      orderBy: [{ name: "asc" }],
      select: savedViewSelect,
    });

    return json({ views });
  },
);

export const POST = withTenantGuard(
  Permission.ProjectsRead,
  async (request: NextRequest, tenant) => {
    const input = await parseJson(request, savedViewCreateSchema);

    if (input.isShared && !hasPermission(tenant.role, Permission.ProjectsUpdate)) {
      throw new ApiError(
        403,
        "forbidden",
        "Your role does not allow sharing views with the organization.",
      );
    }

    if (input.projectId) {
      await requireProjectForTenant(tenant.tenantId, input.projectId);
    }

    const view = await prisma.$transaction(async (tx) => {
      const created = await tx.savedView.create({
        data: {
          config: input.config,
          isShared: input.isShared,
          name: input.name,
          organizationId: tenant.tenantId,
          ownerUserId: tenant.user.id,
          projectId: input.projectId ?? null,
          viewType: input.viewType,
        },
        select: savedViewSelect,
      });

      await tx.activityLog.create({
        data: {
          action: "view.created",
          actorUserId: tenant.user.id,
          entityId: created.id,
          entityType: "saved_view",
          metadata: {
            isShared: created.isShared,
            projectId: created.projectId,
            viewType: created.viewType,
          },
          organizationId: tenant.tenantId,
        },
      });

      return created;
    });

    return json({ view }, 201);
  },
);
