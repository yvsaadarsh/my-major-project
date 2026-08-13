import { NextRequest } from "next/server";

import { json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { automationRuleCreateSchema } from "@/lib/validators";

export const GET = withTenantGuard(Permission.AutomationsRead, async (_request, tenant) => {
  const automationRules = await prisma.automationRule.findMany({
    where: { organizationId: tenant.tenantId },
    orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      description: true,
      enabled: true,
      trigger: true,
      condition: true,
      action: true,
      runsThisMonth: true,
      lastRunAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return json({ automationRules });
});

export const POST = withTenantGuard(
  Permission.AutomationsManage,
  async (request: NextRequest, tenant) => {
    const input = await parseJson(request, automationRuleCreateSchema);

    const automationRule = await prisma.$transaction(async (tx) => {
      const created = await tx.automationRule.create({
        data: {
          ...input,
          createdByUserId: tenant.user.id,
          organizationId: tenant.tenantId,
        },
        select: {
          id: true,
          name: true,
          description: true,
          enabled: true,
          trigger: true,
          condition: true,
          action: true,
          runsThisMonth: true,
          lastRunAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.activityLog.create({
        data: {
          action: "automation.created",
          actorUserId: tenant.user.id,
          entityId: created.id,
          entityType: "automation",
          metadata: {
            action: created.action,
            trigger: created.trigger,
          },
          organizationId: tenant.tenantId,
        },
      });

      return created;
    });

    return json({ automationRule }, 201);
  },
);
