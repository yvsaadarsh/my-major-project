/**
 * Loads everything the per-project intelligence analysis needs, in one place.
 *
 * This is the impure adapter that sits between Prisma and the pure engines in
 * `src/lib/domain/**`. It exists because two routes now need the identical
 * snapshot — the JSON endpoint and the AI narrative endpoint — and the queries
 * involved are subtle enough that a second hand-written copy would drift:
 *
 * - The dependency `where` is two-sided (`scope.ts`). Filtering one side returns
 *   a plausible-looking list that silently omits inbound cross-project
 *   constraints.
 * - Health and risk are deliberately fed **different** task sets. Health gets
 *   only this project's tasks (its signals are ratios over the project's own
 *   population); risk additionally gets the external endpoints of cross-project
 *   edges, or it under-counts what a bottleneck blocks.
 * - The activity query is organization-wide and must be filtered to this
 *   project's task ids afterwards, because `activity_logs` has no `projectId`.
 *
 * Each of those failures produces a smaller, believable number rather than an
 * error, which is exactly why they should not be reimplemented per caller.
 *
 * Read-only: this issues SELECTs and nothing else.
 */

import { prisma } from "@/lib/db";
import { requireProjectForTenant } from "@/lib/tenant/queries";
import {
  DEPENDENCY_SCOPE_SELECT,
  dependenciesRelevantToProject,
  flattenDependencies,
} from "@/lib/dependencies/scope";
import { analyzeDependencyRisk } from "@/lib/domain/dependency-risk";
import {
  analyzeProjectHealth,
  blockerIdsFrom,
  scheduleChangesFromActivity,
  type ScheduleChange,
} from "@/lib/domain/project-intelligence";

/**
 * Cap on activity rows read per project.
 *
 * Slippage is a trailing indicator, so the most recent changes are the ones that
 * matter. Callers surface `activityTruncated` rather than silently analysing a
 * partial window.
 */
export const ACTIVITY_READ_CAP = 2000;

export type ProjectIntelligenceSnapshot = Awaited<
  ReturnType<typeof loadProjectIntelligenceSnapshot>
>;

export async function loadProjectIntelligenceSnapshot(
  organizationId: string,
  projectId: string,
  now: Date,
) {
  // 404s for another tenant's project, so a guessed id is indistinguishable
  // from a nonexistent one.
  const project = await requireProjectForTenant(organizationId, projectId);

  const [tasks, milestones, dependencies, activity] = await Promise.all([
    prisma.task.findMany({
      where: { organizationId, projectId },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        completedAt: true,
        createdAt: true,
        assignedToUserId: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.milestone.findMany({
      where: { organizationId, projectId },
      select: { id: true, name: true, dueDate: true, status: true },
      orderBy: { dueDate: "asc" },
    }),
    // Either endpoint inside this project. An edge from another project that
    // blocks work in here is this project's problem too, and dropping it would
    // make the bottleneck list quietly wrong.
    prisma.taskDependency.findMany({
      where: dependenciesRelevantToProject(organizationId, projectId),
      select: DEPENDENCY_SCOPE_SELECT,
    }),
    // Due-date history for slippage. Scoped to this project's tasks via the id
    // list rather than a join, because activity_logs is keyed by a generic
    // (entityType, entityId) pair and has no projectId column of its own.
    prisma.activityLog.findMany({
      where: {
        organizationId,
        entityType: "task",
        action: { in: ["task.updated", "task.status_changed"] },
      },
      select: {
        entityType: true,
        entityId: true,
        action: true,
        createdAt: true,
        metadata: true,
      },
      orderBy: { createdAt: "asc" },
      take: ACTIVITY_READ_CAP,
    }),
  ]);

  const taskIds = new Set(tasks.map((task) => task.id));
  const openTaskIds = new Set(
    tasks.filter((task) => task.status !== "DONE").map((task) => task.id),
  );

  // The activity query is organization-wide, so drop rows for tasks outside
  // this project before deriving slippage.
  const scheduleChanges: ScheduleChange[] = scheduleChangesFromActivity(activity).filter(
    (change) => taskIds.has(change.taskId),
  );

  const scopedDependencies = flattenDependencies(dependencies);
  const blockerIds = blockerIdsFrom(scopedDependencies, openTaskIds);

  const health = analyzeProjectHealth(
    project,
    tasks,
    milestones,
    scheduleChanges,
    blockerIds,
    now,
  );

  const externalTaskIds = [
    ...new Set(
      scopedDependencies
        .flatMap((edge) => [edge.sourceTaskId, edge.targetTaskId])
        .filter((id) => !taskIds.has(id)),
    ),
  ];

  const externalTasks =
    externalTaskIds.length === 0
      ? []
      : await prisma.task.findMany({
          // Still tenant-scoped: an id harvested from an edge is only usable if
          // it belongs to this organization.
          where: { id: { in: externalTaskIds }, organizationId },
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            dueDate: true,
            assignedToUserId: true,
            projectId: true,
            project: { select: { id: true, name: true } },
          },
        });

  const risk = analyzeDependencyRisk(
    [...tasks, ...externalTasks],
    scopedDependencies,
    now,
    { bottleneckLimit: 10 },
  );

  return {
    activityTruncated: activity.length >= ACTIVITY_READ_CAP,
    blockerIds,
    externalTasks,
    health,
    openTaskIds,
    project,
    risk,
    scheduleChanges,
    scopedDependencies,
    taskIds,
    tasks,
  };
}
