import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

/**
 * Marks every one of the caller's unread notifications as read in the active
 * tenant. Always scoped by `recipientUserId = tenant.user.id`. Returns how many
 * rows were flipped.
 */
export const POST = withTenantGuard(Permission.NotificationsRead, async (_request, tenant) => {
  const result = await prisma.notification.updateMany({
    where: {
      organizationId: tenant.tenantId,
      recipientUserId: tenant.user.id,
      readAt: null,
    },
    data: {
      readAt: new Date(),
    },
  });

  return json({ updated: result.count });
});
