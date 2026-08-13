import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";
import { analyzePortfolioDependencyRisk } from "@/lib/domain/dependency-risk";
import {
  analyzeProjectHealth,
  blockerIdsFrom,
  scheduleChangesFromActivity,
  summarizePortfolio,
} from "@/lib/domain/project-intelligence";
import {
  DEPENDENCY_SCOPE_SELECT,
  edgesForProject,
  flattenDependencies,
} from "@/lib/dependencies/scope";

/** Findings surfaced per project in the portfolio roll-up. */
const FINDINGS_PER_PROJECT = 2;

/**
 * Portfolio-wide health intelligence.
 *
 * Read-only. Fetches every project in the tenant plus their tasks, milestones
 * and dependencies in four queries, then partitions in memory rather than
 * issuing per-project round trips — a tenant with 40 projects would otherwise
 * cost 160 queries.
 *
 * Tenant isolation is enforced by `withTenantGuard` (organization resolved from
 * the session, `dashboard:read` required) and by an `organizationId` filter on
 * every query. Nothing here accepts an organization id from the caller.
 */
export const GET = withTenantGuard(
  Permission.DashboardRead,
  async (_request, tenant) => {
    const organizationId = tenant.tenantId;
    const now = new Date();

    const [projects, tasks, milestones, dependencies, activity] = await Promise.all([
      prisma.project.findMany({
        where: { organizationId },
        select: { id: true, name: true, status: true, startDate: true, endDate: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.task.findMany({
        where: { organizationId },
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          dueDate: true,
          completedAt: true,
          createdAt: true,
          assignedToUserId: true,
          projectId: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.milestone.findMany({
        where: { organizationId },
        select: { id: true, name: true, dueDate: true, status: true, projectId: true },
      }),
      prisma.taskDependency.findMany({
        where: { organizationId },
        select: DEPENDENCY_SCOPE_SELECT,
      }),
      prisma.activityLog.findMany({
        where: {
          organizationId,
          entityType: "task",
          action: { in: ["task.updated", "task.status_changed"] },
        },
        select: { entityType: true, entityId: true, action: true, createdAt: true, metadata: true },
        orderBy: { createdAt: "desc" },
        take: 5000,
      }),
    ]);

    // Index by project once, so each project's analysis is a map lookup rather
    // than a full scan of every collection.
    const tasksByProject = new Map<string, typeof tasks>();
    for (const task of tasks) {
      const bucket = tasksByProject.get(task.projectId);
      if (bucket === undefined) {
        tasksByProject.set(task.projectId, [task]);
      } else {
        bucket.push(task);
      }
    }

    const milestonesByProject = new Map<string, typeof milestones>();
    for (const milestone of milestones) {
      const bucket = milestonesByProject.get(milestone.projectId);
      if (bucket === undefined) {
        milestonesByProject.set(milestone.projectId, [milestone]);
      } else {
        bucket.push(milestone);
      }
    }

    // Dependencies are tenant-wide, so an edge can be relevant to two projects
    // at once. It is therefore indexed into both buckets rather than one.
    const scopedDependencies = flattenDependencies(dependencies);
    const dependenciesByProject = new Map<string, typeof scopedDependencies>();
    for (const project of projects) {
      dependenciesByProject.set(project.id, edgesForProject(scopedDependencies, project.id));
    }

    const allChanges = scheduleChangesFromActivity(activity);
    const changesByTask = new Map<string, typeof allChanges>();
    for (const change of allChanges) {
      const bucket = changesByTask.get(change.taskId);
      if (bucket === undefined) {
        changesByTask.set(change.taskId, [change]);
      } else {
        bucket.push(change);
      }
    }

    const analyses = [];

    for (const project of projects) {
      const projectTasks = tasksByProject.get(project.id) ?? [];
      const projectDependencies = dependenciesByProject.get(project.id) ?? [];
      const openTaskIds = new Set(
        projectTasks.filter((task) => task.status !== "DONE").map((task) => task.id),
      );

      const projectChanges = projectTasks.flatMap((task) => changesByTask.get(task.id) ?? []);
      const blockerIds = blockerIdsFrom(projectDependencies, openTaskIds);

      // Health stays strictly per project: its signals are ratios over the
      // project's own task population.
      analyses.push(
        analyzeProjectHealth(
          project,
          projectTasks,
          milestonesByProject.get(project.id) ?? [],
          projectChanges,
          blockerIds,
          now,
        ),
      );
    }

    // Dependency risk, by contrast, is analysed ONCE over the whole tenant.
    //
    // Running it per project would defeat the point of cross-project edges: a
    // chain that leaves a project and returns would be seen as two short chains,
    // and a cycle spanning three projects would be invisible to all three
    // per-project checks because no single subgraph contains a loop. The graph is
    // global; only the presentation is per project.
    const risk = analyzePortfolioDependencyRisk(
      tasks,
      scopedDependencies,
      projects.map((project) => ({ id: project.id, name: project.name })),
      now,
      { bottleneckLimit: 12 },
    );

    // Only projects that actually have something to say, so this reads as a
    // worklist rather than a wall of "no risks".
    const riskByProject = risk.byProject
      .filter(
        (entry) =>
          entry.findings.length > 0 ||
          entry.inboundCrossProject > 0 ||
          entry.outboundCrossProject > 0,
      )
      .map((entry) => ({ ...entry, findings: entry.findings.slice(0, FINDINGS_PER_PROJECT) }));

    // Worst first, so the top of the list is where attention is needed.
    riskByProject.sort(
      (a, b) =>
        b.cycleCount - a.cycleCount ||
        b.bottleneckCount - a.bottleneckCount ||
        b.inboundCrossProject - a.inboundCrossProject ||
        a.projectName.localeCompare(b.projectName),
    );

    return json({
      // Tenant-wide graph findings — cycles and bottlenecks that span projects
      // live here, because they belong to no single project.
      dependencyRisk: {
        blockingEdgeCount: risk.blockingEdgeCount,
        bottlenecks: risk.bottlenecks.filter((entry) => entry.crossProject),
        crossProjectEdgeCount: risk.crossProjectEdgeCount,
        crossProjectEdges: risk.crossProjectEdges,
        cycles: risk.cycles,
        findings: risk.findings,
        headline: risk.headline,
        longestChain: risk.longestChain,
      },
      generatedAt: now.toISOString(),
      portfolio: summarizePortfolio(analyses),
      projects: analyses,
      readOnly: true,
      risk: riskByProject,
      scheduleHistory: {
        changesConsidered: allChanges.length,
        truncated: activity.length >= 5000,
      },
    });
  },
);
