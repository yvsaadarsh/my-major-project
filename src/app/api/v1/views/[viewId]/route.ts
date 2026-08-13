import { NextRequest } from "next/server";

import type { MembershipRole } from "@/generated/prisma/client";
import { ApiError, empty, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { hasPermission, Permission } from "@/lib/rbac";
import { requireSavedViewForTenant } from "@/lib/tenant/queries";
import { savedViewUpdateSchema } from "@/lib/validators";

type Params = {
  viewId: string;
};

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
 * A saved view is managed by its owner. Curators (roles holding
 * `projects:update`) may additionally manage *shared* views, because those are
 * organization-wide artifacts rather than personal presets.
 */
function assertCanManageView(
  view: { ownerUserId: string; isShared: boolean },
  tenant: { role: MembershipRole; user: { id: string } },
) {
  const isOwner = view.ownerUserId === tenant.user.id;
  const isCurator =
    view.isShared && hasPermission(tenant.role, Permission.ProjectsUpdate);

  if (!isOwner && !isCurator) {
    throw new ApiError(
      403,
      "forbidden",
      "You can only manage saved views you own, or shared views you curate.",
    );
  }
}

export const PATCH = withTenantGuard<Params>(
  Permission.ProjectsRead,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { viewId } = await context.params;
    const input = await parseJson(request, savedViewUpdateSchema);
    const view = await requireSavedViewForTenant(tenant.tenantId, viewId);

    assertCanManageView(view, tenant);

    if (
      input.isShared !== undefined &&
      input.isShared !== view.isShared &&
      !hasPermission(tenant.role, Permission.ProjectsUpdate)
    ) {
      throw new ApiError(
        403,
        "forbidden",
        "Your role does not allow sharing views with the organization.",
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.savedView.updateMany({
        where: {
          id: viewId,
          organizationId: tenant.tenantId,
        },
        data: {
          config: input.config,
          isShared: input.isShared,
          name: input.name,
          viewType: input.viewType,
        },
      });

      const record = await tx.savedView.findFirstOrThrow({
        where: {
          id: viewId,
          organizationId: tenant.tenantId,
        },
        select: savedViewSelect,
      });

      await tx.activityLog.create({
        data: {
          action: "view.updated",
          actorUserId: tenant.user.id,
          entityId: viewId,
          entityType: "saved_view",
          metadata: {
            changedFields: Object.keys(input).join(","),
            isShared: record.isShared,
            viewType: record.viewType,
          },
          organizationId: tenant.tenantId,
        },
      });

      return record;
    });

    return json({ view: updated });
  },
);

export const DELETE = withTenantGuard<Params>(
  Permission.ProjectsRead,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { viewId } = await context.params;
    const view = await requireSavedViewForTenant(tenant.tenantId, viewId);

    assertCanManageView(view, tenant);

    await prisma.$transaction(async (tx) => {
      await tx.savedView.deleteMany({
        where: {
          id: viewId,
          organizationId: tenant.tenantId,
        },
      });

      await tx.activityLog.create({
        data: {
          action: "view.deleted",
          actorUserId: tenant.user.id,
          entityId: viewId,
          entityType: "saved_view",
          metadata: {
            name: view.name,
            projectId: view.projectId,
            viewType: view.viewType,
          },
          organizationId: tenant.tenantId,
        },
      });
    });

    return empty();
  },
);
