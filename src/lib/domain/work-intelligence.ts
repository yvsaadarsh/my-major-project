type TaskLike = {
  id: string;
  title: string;
  description: string | null;
  status: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueDate: Date | null;
  assignedToUserId: string | null;
  projectId: string;
  milestoneId?: string | null;
  parentTaskId?: string | null;
  rating?: number | null;
};

type MilestoneLike = {
  id: string;
  projectId: string;
  name: string;
  dueDate: Date;
  status: "PLANNED" | "ON_TRACK" | "AT_RISK" | "MISSED" | "DONE";
};

// No `projectId`: dependencies are tenant-scoped, and this shape only ever needs
// the endpoints and the kind of link.
type DependencyLike = {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: "BLOCKS" | "DEPENDS_ON" | "RELATED_TO";
};

/**
 * `calculateProjectHealth` and its `ProjectHealth` type used to live here. They
 * were replaced in Stage 2 by `src/lib/domain/project-intelligence.ts`, which
 * fixes two defects in the old formula:
 *
 * 1. It deducted a flat 8 points per overdue task with no normalization, so 13
 *    overdue tasks scored 0 whether the project held 15 tasks or 500 — a
 *    200-task project with 13 late items was reported as Critical.
 * 2. Its `reasons` array always had four entries including non-reasons ("No
 *    overdue open tasks"), so it could not answer "why is this score low".
 *
 * The replacement also adds velocity, schedule slippage and a confidence signal.
 * Callers needing the old response shape use `legacyHealthView`, which is a
 * projection of the new engine's result rather than a second implementation.
 */

export type WorkloadBucket = {
  activeTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  urgentTasks: number;
};

const openStatuses = new Set(["TODO", "IN_PROGRESS", "BLOCKED"]);

export function isOverdue(task: TaskLike, now = new Date()) {
  return Boolean(task.dueDate && task.status !== "DONE" && task.dueDate.getTime() < now.getTime());
}

export function summarizeWorkload(tasks: TaskLike[]): Record<string, WorkloadBucket> {
  return tasks.reduce<Record<string, WorkloadBucket>>((acc, task) => {
    if (!task.assignedToUserId) {
      return acc;
    }

    const bucket = acc[task.assignedToUserId] ?? {
      activeTasks: 0,
      blockedTasks: 0,
      overdueTasks: 0,
      urgentTasks: 0,
    };

    bucket.activeTasks += openStatuses.has(task.status) ? 1 : 0;
    bucket.blockedTasks += task.status === "BLOCKED" ? 1 : 0;
    bucket.overdueTasks += isOverdue(task) ? 1 : 0;
    bucket.urgentTasks += task.priority === "URGENT" && task.status !== "DONE" ? 1 : 0;
    acc[task.assignedToUserId] = bucket;

    return acc;
  }, {});
}

export function milestoneCompletion(milestone: MilestoneLike, tasks: TaskLike[]) {
  const milestoneTasks = tasks.filter((task) => task.milestoneId === milestone.id);
  const completedTasks = milestoneTasks.filter((task) => task.status === "DONE").length;

  return {
    completedTasks,
    completion: milestoneTasks.length ? Math.round((completedTasks / milestoneTasks.length) * 100) : 0,
    totalTasks: milestoneTasks.length,
  };
}

export type SubtaskProgress = {
  total: number;
  completed: number;
  completion: number;
};

/**
 * Completion of the direct subtasks of a parent task. Pure and deterministic:
 * counts tasks whose `parentTaskId` equals the parent's id.
 */
export function subtaskProgress(
  parentId: string,
  tasks: Array<Pick<TaskLike, "parentTaskId" | "status">>,
): SubtaskProgress {
  const subtasks = tasks.filter((task) => task.parentTaskId === parentId);
  const completed = subtasks.filter((task) => task.status === "DONE").length;

  return {
    total: subtasks.length,
    completed,
    completion: subtasks.length ? Math.round((completed / subtasks.length) * 100) : 0,
  };
}

/**
 * Returns true if setting `newParentId` as the parent of `childId` would create a
 * cycle in the subtask tree — i.e. `newParentId` is the child itself or a
 * descendant of the child. Walks the `parentTaskId` chain upward from the
 * proposed parent; if that walk reaches `childId`, the child would become its own
 * ancestor. Guards against corrupt/cyclic data by tracking visited nodes.
 */
export function wouldCreateSubtaskCycle(
  childId: string,
  newParentId: string,
  tasks: Array<Pick<TaskLike, "id" | "parentTaskId">>,
): boolean {
  if (childId === newParentId) {
    return true;
  }

  const parentOf = new Map<string, string | null>();
  tasks.forEach((task) => parentOf.set(task.id, task.parentTaskId ?? null));

  const visited = new Set<string>();
  let cursor: string | null | undefined = newParentId;

  while (cursor) {
    if (cursor === childId) {
      return true;
    }
    if (visited.has(cursor)) {
      break;
    }
    visited.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }

  return false;
}

export function dependencyImpact(taskId: string, dependencies: DependencyLike[]) {
  const downstream = new Set<string>();
  const walk = (id: string) => {
    dependencies
      .filter((dependency) => dependency.sourceTaskId === id && dependency.type === "BLOCKS")
      .forEach((dependency) => {
        if (!downstream.has(dependency.targetTaskId)) {
          downstream.add(dependency.targetTaskId);
          walk(dependency.targetTaskId);
        }
      });
  };

  walk(taskId);
  return downstream.size;
}

export function rankSearchResult(text: string, query: string) {
  const needle = query.trim().toLowerCase();
  const haystack = text.toLowerCase();

  if (!needle) return 0;
  if (haystack === needle) return 100;
  if (haystack.startsWith(needle)) return 82;
  if (haystack.includes(needle)) return 56;

  return needle.split(/\s+/).reduce((total, part) => total + (haystack.includes(part) ? 14 : 0), 0);
}
