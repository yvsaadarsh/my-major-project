import { NextRequest } from "next/server";

import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

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
 * Lists the caller's own notifications inside the active tenant, newest first.
 * Always scoped by `recipientUserId = tenant.user.id`, so a user can never read
 * another member's notifications. `?unread=1` restricts to unread; `unreadCount`
 * is always returned for the header badge.
 */
export const GET = withTenantGuard(
  Permission.NotificationsRead,
  async (request: NextRequest, tenant) => {
    const unreadOnly = request.nextUrl.searchParams.get("unread") === "1";

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: {
          organizationId: tenant.tenantId,
          recipientUserId: tenant.user.id,
          ...(unreadOnly ? { readAt: null } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: notificationSelect,
      }),
      prisma.notification.count({
        where: {
          organizationId: tenant.tenantId,
          recipientUserId: tenant.user.id,
          readAt: null,
        },
      }),
    ]);

    return json({ notifications, unreadCount });
  },
);
