import { NextRequest } from "next/server";

import { json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { notificationPreferenceSchema } from "@/lib/validators";

const preferenceSelect = {
  inAppEnabled: true,
  emailEnabled: true,
  mutedTypes: true,
} as const;

// Sane defaults mirror the schema-level column defaults, so a caller who has
// never saved preferences still gets a well-formed shape.
const defaultPreference = {
  inAppEnabled: true,
  emailEnabled: false,
  mutedTypes: [] as string[],
};

/**
 * Returns the caller's notification preferences for the active tenant, or the
 * defaults when none have been saved yet. Always scoped by
 * `(organizationId, userId = tenant.user.id)`.
 */
export const GET = withTenantGuard(Permission.NotificationsRead, async (_request, tenant) => {
  const preference = await prisma.notificationPreference.findUnique({
    where: {
      organizationId_userId: {
        organizationId: tenant.tenantId,
        userId: tenant.user.id,
      },
    },
    select: preferenceSelect,
  });

  return json({ preference: preference ?? defaultPreference });
});

/**
 * Upserts the caller's own notification preferences. Users only ever manage their
 * own row — the composite unique key is derived from the tenant context, never
 * from the request body.
 */
export const PUT = withTenantGuard(
  Permission.NotificationsRead,
  async (request: NextRequest, tenant) => {
    const input = await parseJson(request, notificationPreferenceSchema);

    const preference = await prisma.notificationPreference.upsert({
      where: {
        organizationId_userId: {
          organizationId: tenant.tenantId,
          userId: tenant.user.id,
        },
      },
      create: {
        organizationId: tenant.tenantId,
        userId: tenant.user.id,
        inAppEnabled: input.inAppEnabled ?? defaultPreference.inAppEnabled,
        emailEnabled: input.emailEnabled ?? defaultPreference.emailEnabled,
        mutedTypes: input.mutedTypes ?? defaultPreference.mutedTypes,
      },
      update: {
        inAppEnabled: input.inAppEnabled,
        emailEnabled: input.emailEnabled,
        mutedTypes: input.mutedTypes,
      },
      select: preferenceSelect,
    });

    return json({ preference });
  },
);
