import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import {
  dependencyImpact,
  milestoneCompletion,
  summarizeWorkload,
} from "@/lib/domain/work-intelligence";
import {
  analyzeProjectHealth,
  blockerIdsFrom,
  legacyHealthView,
  scheduleChangesFromActivity,
} from "@/lib/domain/project-intelligence";
import { edgesForProject, flattenDependencies } from "@/lib/dependencies/scope";
import { prisma } from "@/lib/db";
import { hasPermission, Permission } from "@/lib/rbac";

export const GET = withTenantGuard(Permission.DashboardRead, async (_request, tenant) => {
  const organizationId = tenant.tenantId;

  const [
    projects,
    tasks,
    milestones,
    dependencies,
    members,
    notifications,
    automationRules,
    activityLogs,
    scheduleActivity,
  ] = await Promise.all([
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
        updatedAt: true,
        _count: { select: { tasks: true } },
      },
    }),
    prisma.task.findMany({
      where: { organizationId },
      orderBy: [{ priority: "desc" }, { dueDate: "asc" }, { updatedAt: "desc" }],
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        dueDate: true,
        assignedToUserId: true,
        projectId: true,
        milestoneId: true,
        rating: true,
        // Needed by the intelligence engine for velocity (created → completed).
        completedAt: true,
        createdAt: true,
        project: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.milestone.findMany({
      where: { organizationId },
      orderBy: [{ dueDate: "asc" }],
      select: {
        id: true,
        projectId: true,
        name: true,
        description: true,
        dueDate: true,
        status: true,
        project: { select: { id: true, name: true } },
      },
    }),
    prisma.taskDependency.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        sourceTaskId: true,
        targetTaskId: true,
        type: true,
        // The edge has no project of its own any more, so each endpoint carries
        // its own — that is also what makes a crossing visible in the UI.
        sourceTask: {
          select: {
            id: true,
            title: true,
            status: true,
            projectId: true,
            project: { select: { id: true, name: true } },
          },
        },
        targetTask: {
          select: {
            id: true,
            title: true,
            status: true,
            projectId: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.organizationMember.findMany({
      where: { organizationId, status: "ACTIVE" },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
      select: {
        role: true,
        user: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.notification.findMany({
      where: { organizationId, recipientUserId: tenant.user.id },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        title: true,
        body: true,
        priority: true,
        href: true,
        readAt: true,
        createdAt: true,
      },
    }),
    prisma.automationRule.findMany({
      where: { organizationId },
      orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
      take: 8,
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
      },
    }),
    hasPermission(tenant.role, Permission.AuditRead)
      ? prisma.activityLog.findMany({
          where: { organizationId },
          orderBy: { createdAt: "desc" },
          take: 12,
          select: {
            id: true,
            action: true,
            entityType: true,
            entityId: true,
            metadata: true,
            createdAt: true,
            actor: { select: { id: true, name: true, email: true } },
          },
        })
      : Promise.resolve([]),
    // Due-date history for the slippage signal.
    //
    // Fetched separately and WITHOUT the audit:read gate on purpose. The
    // activity feed above is privileged (it names actors across the whole
    // tenant); this query reads only the before/after due dates of tasks the
    // caller can already see, and reveals nothing new. Reusing the gated fetch
    // would make health scores depend on the viewer's role — the same project
    // would score differently for an Admin and a Manager, which is indefensible
    // for a shared metric.
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

  // Health now comes from the single intelligence engine. Rows are partitioned
  // per project first — the old scorer took every task in the tenant and
  // filtered internally, which meant its "overdue" ratios were computed against
  // the wrong denominator once a tenant had more than one project.
  const now = new Date();
  const scheduleChanges = scheduleChangesFromActivity(scheduleActivity);
  // Edges are tenant-wide, so one can be relevant to two projects at once.
  const scopedDependencies = flattenDependencies(dependencies);

  const health = projects.map((project) => {
    const projectTasks = tasks.filter((task) => task.projectId === project.id);
    const projectMilestones = milestones.filter((m) => m.projectId === project.id);
    const projectDependencies = edgesForProject(scopedDependencies, project.id);
    const projectTaskIds = new Set(projectTasks.map((task) => task.id));
    const openTaskIds = new Set(
      projectTasks.filter((task) => task.status !== "DONE").map((task) => task.id),
    );

    const analysis = analyzeProjectHealth(
      project,
      projectTasks,
      projectMilestones,
      scheduleChanges.filter((change) => projectTaskIds.has(change.taskId)),
      blockerIdsFrom(projectDependencies, openTaskIds),
      now,
    );

    return {
      ...project,
      // Legacy projection keeps the current Work OS page rendering unchanged
      // while it migrates to `intelligence` below. Same engine, one number.
      health: legacyHealthView(analysis),
      intelligence: analysis,
    };
  });

  const workload = summarizeWorkload(tasks);

  return json({
    activityLogs,
    automationRules,
    dependencies: dependencies.map((dependency) => ({
      ...dependency,
      // Flagged so the UI can mark a link that leaves its project — previously
      // impossible to express, and the reason this feature exists.
      crossProject: dependency.sourceTask.projectId !== dependency.targetTask.projectId,
      downstreamImpact: dependencyImpact(dependency.sourceTaskId, scopedDependencies),
    })),
    health,
    members: members.map((member) => ({
      ...member,
      workload: workload[member.user.id] ?? {
        activeTasks: 0,
        blockedTasks: 0,
        overdueTasks: 0,
        urgentTasks: 0,
      },
    })),
    milestones: milestones.map((milestone) => ({
      ...milestone,
      progress: milestoneCompletion(milestone, tasks),
    })),
    notifications,
  });
});
