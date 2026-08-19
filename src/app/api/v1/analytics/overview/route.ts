import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import {
  agingBuckets,
  cycleTimeStats,
  milestonePerformance,
  milestoneSummary,
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
  edgesForProject,
  flattenDependencies,
} from "@/lib/dependencies/scope";

/**
 * Org-wide analytics overview. Everything here is tenant-scoped by the guard and
 * computed by the pure analytics domain layer — the route only fetches and shapes.
 */
export const GET = withTenantGuard(Permission.DashboardRead, async (_request, tenant) => {
  const organizationId = tenant.tenantId;

  const [projects, tasks, milestones, dependencies, members, scheduleActivity] =
    await Promise.all([
    prisma.project.findMany({
      where: { organizationId },
      orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        startDate: true,
        endDate: true,
        _count: { select: { tasks: true } },
      },
    }),
    prisma.task.findMany({
      where: { organizationId },
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
      where: { organizationId },
      select: { id: true, projectId: true, name: true, dueDate: true, status: true },
    }),
    prisma.taskDependency.findMany({
      where: { organizationId },
      select: DEPENDENCY_SCOPE_SELECT,
    }),
    prisma.organizationMember.findMany({
      where: { organizationId, status: "ACTIVE" },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: { role: true, user: { select: { id: true, name: true } } },
    }),
    // Due-date history for the slippage signal. See the note in
    // work-os/overview: this is deliberately not gated on audit:read, so a
    // project's health score does not change with the viewer's role.
    prisma.activityLog.findMany({
      where: {
        organizationId,
        entityType: "task",
        action: { in: ["task.updated", "task.status_changed"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5000,
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

  // One engine, per-project inputs. The previous scorer was handed every task
  // in the tenant and filtered internally, so its ratios used the wrong
  // denominator as soon as a tenant had more than one project.
  const allScheduleChanges = scheduleChangesFromActivity(scheduleActivity);

  // Dependencies are tenant-wide now, so an edge is relevant to a project when
  // EITHER endpoint sits inside it.
  const scopedDependencies = flattenDependencies(dependencies);

  const health = projects
    .map((project) => {
      const projectTasks = analyticsTasks.filter((task) => task.projectId === project.id);
      const projectMilestones = analyticsMilestones.filter((m) => m.projectId === project.id);
      const projectDependencies = edgesForProject(scopedDependencies, project.id);
      const projectTaskIds = new Set(projectTasks.map((task) => task.id));
      const openTaskIds = new Set(
        projectTasks.filter((task) => task.status !== "DONE").map((task) => task.id),
      );

      const analysis = analyzeProjectHealth(
        project,
        projectTasks,
        projectMilestones,
        allScheduleChanges.filter((change) => projectTaskIds.has(change.taskId)),
        blockerIdsFrom(projectDependencies, openTaskIds),
        now,
      );

      return {
        id: project.id,
        name: project.name,
        status: project.status,
        taskCount: project._count.tasks,
        intelligence: analysis,
      };
    })
    .sort((a, b) => a.intelligence.score - b.intelligence.score); // most at-risk first

  return json({
    generatedAt: now.toISOString(),
    metrics: workMetrics(analyticsTasks, now),
    statusDistribution: statusDistribution(analyticsTasks),
    priorityDistribution: priorityDistribution(analyticsTasks),
    throughput: throughputByWeek(analyticsTasks, 8, now),
    cycleTime: cycleTimeStats(analyticsTasks),
    aging: agingBuckets(analyticsTasks, now),
    milestoneSummary: milestoneSummary(analyticsMilestones),
    milestonePerformance: milestonePerformance(analyticsMilestones, analyticsTasks, now).slice(0, 8),
    teamWorkload: teamWorkload(analyticsTasks, analyticsMembers, now),
    projectHealth: health,
  });
});
