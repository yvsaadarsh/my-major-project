import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { runScheduledAutomations } from "@/lib/automation/executor";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

/**
 * Manually trigger the batch/time-based automations for the active tenant.
 *
 * There is no background runner in this stage. This endpoint runs the same
 * idempotent scan a future scheduled task would poll (TASK_OVERDUE +
 * PROJECT_HEALTH_CHANGED). Re-running it is safe: the `AutomationRun` dedupe key
 * skips effects that already fired, so the summary reports how many were newly
 * fired vs. skipped.
 */
export const POST = withTenantGuard(Permission.AutomationsManage, async (_request, tenant) => {
  const summary = await runScheduledAutomations(prisma, tenant.tenantId);

  return json({ summary });
});
