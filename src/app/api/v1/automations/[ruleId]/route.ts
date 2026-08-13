import { NextRequest } from "next/server";

import { ApiError, empty, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import type { RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { automationRuleUpdateSchema } from "@/lib/validators";

type Params = {
  ruleId: string;
};

// Kept local: Next.js only permits route handler exports from a route module.
const automationRuleSelect = {
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
} as const;

async function requireRuleForTenant(tenantId: string, ruleId: string) {
  const rule = await prisma.automationRule.findFirst({
    where: {
      id: ruleId,
      organizationId: tenantId,
    },
    select: { id: true },
  });

  if (!rule) {
    throw new ApiError(404, "automation_not_found", "Automation rule was not found.");
  }

  return rule;
}

export const PATCH = withTenantGuard<Params>(
  Permission.AutomationsManage,
  async (request: NextRequest, tenant, context: RouteContext<Params>) => {
    const { ruleId } = await context.params;
    const input = await parseJson(request, automationRuleUpdateSchema);

    await requireRuleForTenant(tenant.tenantId, ruleId);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.automationRule.updateMany({
        where: {
          id: ruleId,
          organizationId: tenant.tenantId,
        },
        data: {
          action: input.action,
          condition: input.condition,
          description: input.description,
          enabled: input.enabled,
          name: input.name,
          trigger: input.trigger,
        },
      });

      const record = await tx.automationRule.findFirstOrThrow({
        where: {
          id: ruleId,
          organizationId: tenant.tenantId,
        },
        select: automationRuleSelect,
      });

      await tx.activityLog.create({
        data: {
          action: "automation.updated",
          actorUserId: tenant.user.id,
          entityId: ruleId,
          entityType: "automation",
          metadata: {
            changedFields: Object.keys(input).join(","),
            enabled: record.enabled,
            trigger: record.trigger,
          },
          organizationId: tenant.tenantId,
        },
      });

      return record;
    });

    return json({ automationRule: updated });
  },
);

export const DELETE = withTenantGuard<Params>(
  Permission.AutomationsManage,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { ruleId } = await context.params;
    const rule = await prisma.automationRule.findFirst({
      where: {
        id: ruleId,
        organizationId: tenant.tenantId,
      },
      select: { id: true, name: true, trigger: true, action: true },
    });

    if (!rule) {
      throw new ApiError(404, "automation_not_found", "Automation rule was not found.");
    }

    await prisma.$transaction(async (tx) => {
      await tx.automationRule.deleteMany({
        where: {
          id: ruleId,
          organizationId: tenant.tenantId,
        },
      });

      await tx.activityLog.create({
        data: {
          action: "automation.deleted",
          actorUserId: tenant.user.id,
          entityId: ruleId,
          entityType: "automation",
          metadata: {
            name: rule.name,
            trigger: rule.trigger,
            action: rule.action,
          },
          organizationId: tenant.tenantId,
        },
      });
    });

    return empty();
  },
);
