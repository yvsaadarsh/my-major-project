import { json } from "@/lib/api/http";
import { withTenantGuard, type RouteContext } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { requireProjectForTenant } from "@/lib/tenant/queries";
import {
  agingBuckets,
  cycleTimeStats,
  milestonePerformance,
  priorityDistribution,
  statusDistribution,
  teamWorkload,
  throughputByWeek,
  workMetrics,
  type AnalyticsMember,
} from "@/lib/domain/analytics";
import {
  analyzeProjectHealth,
  blockerIdsFrom,
  scheduleChangesFromActivity,
} from "@/lib/domain/project-intelligence";
import {
  DEPENDENCY_SCOPE_SELECT,
  dependenciesRelevantToProject,
  flattenDependencies,
} from "@/lib/dependencies/scope";

/**
 * Analytics scoped to a single project. Same domain functions as the org
 * overview, but the task/milestone/dependency sets are project-filtered first.
 */
export const GET = withTenantGuard<{ projectId: string }>(
  Permission.DashboardRead,
  async (_request, tenant, context: RouteContext<{ projectId: string }>) => {
    const { projectId } = await context.params;
    const organizationId = tenant.tenantId;

    const project = await requireProjectForTenant(organizationId, projectId);

    const [tasks, milestones, dependencies, members, scheduleActivity] = await Promise.all([
      prisma.task.findMany({
        where: { organizationId, projectId },
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          dueDate: true,
          completedAt: true,
          createdAt: true,
          assignedToUserId: true,
          projectId: true,
          milestoneId: true,
        },
      }),
      prisma.milestone.findMany({
        where: { organizationId, projectId },
        select: { id: true, projectId: true, name: true, dueDate: true, status: true },
      }),
      // Either endpoint inside this project — an inbound edge from another
      // project is a constraint on this one and must not be dropped.
      prisma.taskDependency.findMany({
        where: dependenciesRelevantToProject(organizationId, projectId),
        select: DEPENDENCY_SCOPE_SELECT,
      }),
      prisma.organizationMember.findMany({
        where: { organizationId, status: "ACTIVE" },
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        select: { role: true, user: { select: { id: true, name: true } } },
      }),
      // Due-date history for the slippage signal. Not gated on audit:read, so a
      // project's health does not change with the viewer's role.
      prisma.activityLog.findMany({
        where: {
          organizationId,
          entityType: "task",
          action: { in: ["task.updated", "task.status_changed"] },
        },
        orderBy: { createdAt: "desc" },
        take: 2000,
        select: {
          entityType: true,
          entityId: true,
          action: true,
          createdAt: true,
          metadata: true,
        },
      }),
    ]);

    const now = new Date();
    // Raw rows include title/description, so they satisfy both the analytics
    // (AnalyticsTask) and work-intelligence (TaskLike) parameter shapes.
    const analyticsTasks = tasks;
    const analyticsMilestones = milestones;
    const analyticsMembers: AnalyticsMember[] = members.map((member) => ({
      userId: member.user.id,
      name: member.user.name ?? "Unknown",
      role: member.role,
    }));

    // Only surface members who actually hold work in this project.
    const contributors = teamWorkload(analyticsTasks, analyticsMembers, now).filter(
      (row) => row.openTasks > 0 || row.completedTasks > 0,
    );

    // Rows are already project-scoped by the queries above, so no extra
    // filtering is needed before scoring.
    const openTaskIds = new Set(
      analyticsTasks.filter((task) => task.status !== "DONE").map((task) => task.id),
    );
    const projectTaskIds = new Set(analyticsTasks.map((task) => task.id));

    const projectAnalysis = analyzeProjectHealth(
      project,
      analyticsTasks,
      analyticsMilestones,
      scheduleChangesFromActivity(scheduleActivity).filter((change) =>
        projectTaskIds.has(change.taskId),
      ),
      blockerIdsFrom(flattenDependencies(dependencies), openTaskIds),
      now,
    );

    return json({
      generatedAt: now.toISOString(),
      project: { id: project.id, name: project.name, status: project.status },
      intelligence: projectAnalysis,
      metrics: workMetrics(analyticsTasks, now),
      statusDistribution: statusDistribution(analyticsTasks),
      priorityDistribution: priorityDistribution(analyticsTasks),
      throughput: throughputByWeek(analyticsTasks, 8, now),
      cycleTime: cycleTimeStats(analyticsTasks),
      aging: agingBuckets(analyticsTasks, now),
      milestonePerformance: milestonePerformance(analyticsMilestones, analyticsTasks, now),
      contributors,
    });
  },
);
