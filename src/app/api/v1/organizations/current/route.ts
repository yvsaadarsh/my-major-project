import { NextRequest } from "next/server";

import { withTenantGuard } from "@/lib/api/tenant-guard";
import { json, parseJson } from "@/lib/api/http";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { organizationUpdateSchema } from "@/lib/validators";

export const GET = withTenantGuard(Permission.OrganizationRead, async (_request, tenant) => {
  return json({
    membership: tenant.membership,
    organization: tenant.organization,
  });
});

export const PATCH = withTenantGuard(
  Permission.OrganizationUpdate,
  async (request: NextRequest, tenant) => {
    const input = await parseJson(request, organizationUpdateSchema);

    const organization = await prisma.organization.update({
      where: { id: tenant.tenantId },
      data: {
        name: input.name,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return json({ organization });
  },
);
