import { NextRequest } from "next/server";
import { z } from "zod";

import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

type Params = {
  notificationId: string;
};

const markReadSchema = z.object({
  read: z.boolean(),
});

const notificationSelect = {
  id: true,
  type: true,
  title: true,
  body: true,
  href: true,
  priority: true,
  readAt: true,
  createdAt: true,
} as const;

/**
 * Marks one of the caller's own notifications read/unread. The recipient check is
 * enforced server-side: a member may only mutate notifications addressed to them,
 * even inside the same tenant (403 otherwise).
 */
export const PATCH = withTenantGuard<Params>(
  Permission.NotificationsRead,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { notificationId } = await context.params;
    const input = await parseJson(request, markReadSchema);

    const notification = await prisma.notification.findFirst({
      where: {
        id: notificationId,
        organizationId: tenant.tenantId,
      },
      select: { id: true, recipientUserId: true },
    });

    if (!notification) {
      throw new ApiError(404, "notification_not_found", "Notification was not found.");
    }

    if (notification.recipientUserId !== tenant.user.id) {
      throw new ApiError(
        403,
        "forbidden",
        "You can only update your own notifications.",
      );
    }

    await prisma.notification.updateMany({
      where: {
        id: notificationId,
        organizationId: tenant.tenantId,
        recipientUserId: tenant.user.id,
      },
      data: {
        readAt: input.read ? new Date() : null,
      },
    });

    const updated = await prisma.notification.findFirstOrThrow({
      where: {
        id: notificationId,
        organizationId: tenant.tenantId,
        recipientUserId: tenant.user.id,
      },
      select: notificationSelect,
    });

    return json({ notification: updated });
  },
);
