/**
 * View engine — pure, deterministic filter / sort / group pipeline shared by
 * every view surface (board, list, table, timeline).
 *
 * No imports from Prisma, React or anything environment-specific: the same code
 * runs on the server (Date values) and in the browser (ISO strings), so a saved
 * view config always produces the same result on both sides.
 */

export type ViewType = "BOARD" | "LIST" | "TABLE" | "TIMELINE";

export type ViewTaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";

export type ViewTaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export type SortField =
  | "title"
  | "status"
  | "priority"
  | "dueDate"
  | "createdAt"
  | "assignee";

export type SortDirection = "asc" | "desc";

export type GroupBy =
  | "none"
  | "status"
  | "priority"
  | "assignee"
  | "milestone"
  | "dueDate";

export type ViewColumn =
  | "title"
  | "status"
  | "priority"
  | "assignee"
  | "dueDate"
  | "milestone";

/** Date values arrive as `Date` on the server and as ISO strings from the API. */
export type ViewDate = Date | string | null | undefined;

export type ViewTask = {
  id: string;
  title: string;
  description?: string | null;
  status: ViewTaskStatus;
  priority: ViewTaskPriority;
  dueDate?: ViewDate;
  createdAt?: ViewDate;
  assignedToUserId?: string | null;
  assignedTo?: { id: string; name: string } | null;
  milestoneId?: string | null;
  parentTaskId?: string | null;
};

export type TaskFilter = {
  status?: string[];
  priority?: string[];
  assigneeIds?: string[];
  milestoneIds?: string[];
  search?: string;
  overdueOnly?: boolean;
  includeSubtasks?: boolean;
};

export type ViewConfig = {
  filter: TaskFilter;
  sortField: SortField;
  sortDirection: SortDirection;
  groupBy: GroupBy;
  visibleColumns: string[];
};

export type ViewGroup<TTask extends ViewTask = ViewTask> = {
  key: string;
  label: string;
  tasks: TTask[];
};

/** Sentinel filter/group keys for "has no assignee" / "has no milestone". */
export const UNASSIGNED_KEY = "__unassigned__";
export const NO_MILESTONE_KEY = "__no_milestone__";

export const VIEW_TYPES: ViewType[] = ["BOARD", "LIST", "TABLE", "TIMELINE"];

export const VIEW_STATUSES: ViewTaskStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "BLOCKED",
  "DONE",
];

export const VIEW_PRIORITIES: ViewTaskPriority[] = [
  "URGENT",
  "HIGH",
  "MEDIUM",
  "LOW",
];

export const SORT_FIELDS: SortField[] = [
  "title",
  "status",
  "priority",
  "dueDate",
  "createdAt",
  "assignee",
];

export const GROUP_BY_OPTIONS: GroupBy[] = [
  "none",
  "status",
  "priority",
  "assignee",
  "milestone",
  "dueDate",
];

export const VIEW_COLUMNS: ViewColumn[] = [
  "title",
  "status",
  "priority",
  "assignee",
  "dueDate",
  "milestone",
];

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  filter: {
    status: [],
    priority: [],
    assigneeIds: [],
    milestoneIds: [],
    search: "",
    overdueOnly: false,
    includeSubtasks: true,
  },
  sortField: "createdAt",
  sortDirection: "desc",
  groupBy: "status",
  visibleColumns: [...VIEW_COLUMNS],
};

/** Workflow order: TODO < IN_PROGRESS < BLOCKED < DONE. */
const statusRank: Record<ViewTaskStatus, number> = {
  TODO: 0,
  IN_PROGRESS: 1,
  BLOCKED: 2,
  DONE: 3,
};

/** Severity order: URGENT > HIGH > MEDIUM > LOW (most severe first when `asc`). */
const priorityRank: Record<ViewTaskPriority, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const statusLabels: Record<ViewTaskStatus, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  BLOCKED: "Blocked",
  DONE: "Done",
};

const priorityLabels: Record<ViewTaskPriority, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

const dueDateBuckets: Array<{ key: string; label: string }> = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "later", label: "Later" },
  { key: "none", label: "No due date" },
];

const dayMs = 24 * 60 * 60 * 1000;

export function toDate(value: ViewDate): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

export function assigneeIdOf(task: ViewTask): string | null {
  return task.assignedToUserId ?? task.assignedTo?.id ?? null;
}

export function assigneeNameOf(task: ViewTask): string | null {
  return task.assignedTo?.name ?? null;
}

export function statusLabel(status: ViewTaskStatus) {
  return statusLabels[status];
}

export function priorityLabel(priority: ViewTaskPriority) {
  return priorityLabels[priority];
}

export function viewTypeLabel(viewType: ViewType) {
  return {
    BOARD: "Board",
    LIST: "List",
    TABLE: "Table",
    TIMELINE: "Timeline",
  }[viewType];
}

export function sortFieldLabel(field: SortField) {
  return {
    title: "Title",
    status: "Status",
    priority: "Priority",
    dueDate: "Due date",
    createdAt: "Created",
    assignee: "Assignee",
  }[field];
}

export function groupByLabel(groupBy: GroupBy) {
  return {
    none: "No grouping",
    status: "Status",
    priority: "Priority",
    assignee: "Assignee",
    milestone: "Milestone",
    dueDate: "Due date",
  }[groupBy];
}

export function columnLabel(column: string) {
  return (
    {
      title: "Title",
      status: "Status",
      priority: "Priority",
      assignee: "Assignee",
      dueDate: "Due date",
      milestone: "Milestone",
    }[column] ?? column
  );
}

export function isViewType(value: unknown): value is ViewType {
  return typeof value === "string" && (VIEW_TYPES as string[]).includes(value);
}

/**
 * Same overdue rule as `isOverdue` in `work-intelligence.ts`: a task is overdue
 * when it has a due date in the past and is not DONE. Replicated (rather than
 * imported) because view tasks carry dates as `Date` *or* ISO string.
 */
export function isTaskOverdue(task: ViewTask, now: Date = new Date()) {
  const dueDate = toDate(task.dueDate);

  return Boolean(dueDate && task.status !== "DONE" && dueDate.getTime() < now.getTime());
}

export function filterTasks<TTask extends ViewTask>(
  tasks: TTask[],
  filter: TaskFilter = {},
  now: Date = new Date(),
): TTask[] {
  const statuses = filter.status ?? [];
  const priorities = filter.priority ?? [];
  const assigneeIds = filter.assigneeIds ?? [];
  const milestoneIds = filter.milestoneIds ?? [];
  const search = (filter.search ?? "").trim().toLowerCase();

  return tasks.filter((task) => {
    if (statuses.length && !statuses.includes(task.status)) {
      return false;
    }

    if (priorities.length && !priorities.includes(task.priority)) {
      return false;
    }

    if (assigneeIds.length) {
      const assigneeId = assigneeIdOf(task);
      const matches = assigneeId
        ? assigneeIds.includes(assigneeId)
        : assigneeIds.includes(UNASSIGNED_KEY);

      if (!matches) {
        return false;
      }
    }

    if (milestoneIds.length) {
      const milestoneId = task.milestoneId ?? null;
      const matches = milestoneId
        ? milestoneIds.includes(milestoneId)
        : milestoneIds.includes(NO_MILESTONE_KEY);

      if (!matches) {
        return false;
      }
    }

    if (search) {
      const haystack = `${task.title} ${task.description ?? ""}`.toLowerCase();

      if (!haystack.includes(search)) {
        return false;
      }
    }

    if (filter.overdueOnly && !isTaskOverdue(task, now)) {
      return false;
    }

    if (filter.includeSubtasks === false && task.parentTaskId) {
      return false;
    }

    return true;
  });
}

/**
 * Stable sort (ties keep their original relative order). Missing values —
 * `null` due dates and unassigned tasks — always sort last, regardless of
 * direction, so "empty" rows never hide the meaningful ones at the top.
 */
export function sortTasks<TTask extends ViewTask>(
  tasks: TTask[],
  field: SortField,
  direction: SortDirection,
): TTask[] {
  const factor = direction === "desc" ? -1 : 1;

  return tasks
    .map((task, index) => ({ task, index }))
    .sort((left, right) => {
      const comparison = compareTasks(left.task, right.task, field, factor);

      return comparison !== 0 ? comparison : left.index - right.index;
    })
    .map((entry) => entry.task);
}

function compareTasks(
  left: ViewTask,
  right: ViewTask,
  field: SortField,
  factor: number,
): number {
  switch (field) {
    case "title":
      return factor * left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    case "status":
      return factor * (statusRank[left.status] - statusRank[right.status]);
    case "priority":
      return factor * (priorityRank[left.priority] - priorityRank[right.priority]);
    case "createdAt": {
      const leftTime = toDate(left.createdAt)?.getTime() ?? null;
      const rightTime = toDate(right.createdAt)?.getTime() ?? null;

      return compareNullable(leftTime, rightTime, factor);
    }
    case "dueDate": {
      const leftTime = toDate(left.dueDate)?.getTime() ?? null;
      const rightTime = toDate(right.dueDate)?.getTime() ?? null;

      return compareNullable(leftTime, rightTime, factor);
    }
    case "assignee": {
      const leftName = assigneeNameOf(left) ?? assigneeIdOf(left);
      const rightName = assigneeNameOf(right) ?? assigneeIdOf(right);

      if (leftName === null && rightName === null) {
        return 0;
      }
      if (leftName === null) {
        return 1;
      }
      if (rightName === null) {
        return -1;
      }

      return factor * leftName.localeCompare(rightName, undefined, { sensitivity: "base" });
    }
    default:
      return 0;
  }
}

/** Compares two nullable numbers; `null` is always ordered last. */
function compareNullable(left: number | null, right: number | null, factor: number) {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }

  return factor * (left - right);
}

/** Calendar bucket for a due date, relative to `now`. Purely date-based. */
export function dueDateBucketKey(value: ViewDate, now: Date = new Date()): string {
  const dueDate = toDate(value);

  if (!dueDate) {
    return "none";
  }

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + dayMs;
  const dueTime = dueDate.getTime();

  if (dueTime < startOfToday) {
    return "overdue";
  }
  if (dueTime < endOfToday) {
    return "today";
  }
  if (dueTime < endOfToday + 7 * dayMs) {
    return "week";
  }

  return "later";
}

/**
 * Groups tasks into an ordered list of groups. Fixed-domain groupings (status,
 * priority, due date) always emit every bucket — including empty ones — so board
 * columns stay stable. Dynamic groupings (assignee, milestone) only emit groups
 * that contain tasks, ordered by label with the "empty" bucket last.
 */
export function groupTasks<TTask extends ViewTask>(
  tasks: TTask[],
  groupBy: GroupBy,
  now: Date = new Date(),
): Array<ViewGroup<TTask>> {
  if (groupBy === "none") {
    return [{ key: "all", label: "All tasks", tasks: [...tasks] }];
  }

  if (groupBy === "status") {
    return VIEW_STATUSES.map((status) => ({
      key: status,
      label: statusLabels[status],
      tasks: tasks.filter((task) => task.status === status),
    }));
  }

  if (groupBy === "priority") {
    return VIEW_PRIORITIES.map((priority) => ({
      key: priority,
      label: priorityLabels[priority],
      tasks: tasks.filter((task) => task.priority === priority),
    }));
  }

  if (groupBy === "dueDate") {
    return dueDateBuckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      tasks: tasks.filter((task) => dueDateBucketKey(task.dueDate, now) === bucket.key),
    }));
  }

  const emptyKey = groupBy === "assignee" ? UNASSIGNED_KEY : NO_MILESTONE_KEY;
  const emptyLabel = groupBy === "assignee" ? "Unassigned" : "No milestone";
  const buckets = new Map<string, ViewGroup<TTask>>();

  tasks.forEach((task) => {
    const key =
      groupBy === "assignee"
        ? assigneeIdOf(task) ?? emptyKey
        : task.milestoneId ?? emptyKey;
    const label =
      key === emptyKey
        ? emptyLabel
        : groupBy === "assignee"
          ? assigneeNameOf(task) ?? key
          : key;
    const bucket = buckets.get(key) ?? { key, label, tasks: [] };

    bucket.tasks.push(task);
    buckets.set(key, bucket);
  });

  return [...buckets.values()].sort((left, right) => {
    if (left.key === emptyKey) return 1;
    if (right.key === emptyKey) return -1;

    return left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
  });
}

/** filter → sort → group. The single entry point every view renders from. */
export function applyView<TTask extends ViewTask>(
  tasks: TTask[],
  config: ViewConfig,
  now: Date = new Date(),
): Array<ViewGroup<TTask>> {
  const filtered = filterTasks(tasks, config.filter, now);
  const sorted = sortTasks(filtered, config.sortField, config.sortDirection);

  return groupTasks(sorted, config.groupBy, now);
}

/** Flattens groups back into a single ordered task list. */
export function flattenGroups<TTask extends ViewTask>(
  groups: Array<ViewGroup<TTask>>,
): TTask[] {
  return groups.flatMap((group) => group.tasks);
}

/** Normalizes an arbitrary stored config (e.g. from JSON) into a full config. */
export function normalizeViewConfig(value: unknown): ViewConfig {
  const candidate = (value ?? {}) as Partial<ViewConfig>;
  const filter = (candidate.filter ?? {}) as TaskFilter;

  return {
    filter: {
      status: toStringArray(filter.status),
      priority: toStringArray(filter.priority),
      assigneeIds: toStringArray(filter.assigneeIds),
      milestoneIds: toStringArray(filter.milestoneIds),
      search: typeof filter.search === "string" ? filter.search : "",
      overdueOnly: filter.overdueOnly === true,
      includeSubtasks: filter.includeSubtasks !== false,
    },
    sortField: SORT_FIELDS.includes(candidate.sortField as SortField)
      ? (candidate.sortField as SortField)
      : DEFAULT_VIEW_CONFIG.sortField,
    sortDirection: candidate.sortDirection === "asc" || candidate.sortDirection === "desc"
      ? candidate.sortDirection
      : DEFAULT_VIEW_CONFIG.sortDirection,
    groupBy: GROUP_BY_OPTIONS.includes(candidate.groupBy as GroupBy)
      ? (candidate.groupBy as GroupBy)
      : DEFAULT_VIEW_CONFIG.groupBy,
    visibleColumns: Array.isArray(candidate.visibleColumns) && candidate.visibleColumns.length
      ? candidate.visibleColumns.filter((column): column is string => typeof column === "string")
      : [...VIEW_COLUMNS],
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}

export type TimelineBar = {
  end: Date;
  offsetPercent: number;
  start: Date;
  task: ViewTask;
  widthPercent: number;
};

export type TimelineLayout = {
  bars: TimelineBar[];
  rangeEnd: Date | null;
  rangeStart: Date | null;
  totalDays: number;
};

/**
 * Computes a horizontal timeline layout: every dated task becomes a bar
 * positioned as a percentage of the overall range. A task's bar spans from its
 * creation date (or due date when missing) to its due date.
 */
export function buildTimelineLayout(
  tasks: ViewTask[],
  minimumBarPercent = 2,
): TimelineLayout {
  const dated = tasks
    .map((task) => {
      const due = toDate(task.dueDate);
      const created = toDate(task.createdAt);

      if (!due && !created) {
        return null;
      }

      const end = due ?? created;
      const start = created && due && created.getTime() < due.getTime() ? created : end;

      return end && start ? { end, start, task } : null;
    })
    .filter((entry): entry is { end: Date; start: Date; task: ViewTask } => entry !== null)
    .filter((entry) => toDate(entry.task.dueDate) !== null);

  if (!dated.length) {
    return { bars: [], rangeEnd: null, rangeStart: null, totalDays: 0 };
  }

  const minTime = Math.min(...dated.map((entry) => entry.start.getTime()));
  const maxTime = Math.max(...dated.map((entry) => entry.end.getTime()));
  const span = Math.max(maxTime - minTime, dayMs);

  const bars = dated.map((entry) => {
    const offsetPercent = ((entry.start.getTime() - minTime) / span) * 100;
    const rawWidth = ((entry.end.getTime() - entry.start.getTime()) / span) * 100;
    const widthPercent = Math.min(100 - offsetPercent, Math.max(minimumBarPercent, rawWidth));

    return {
      end: entry.end,
      offsetPercent,
      start: entry.start,
      task: entry.task,
      widthPercent,
    };
  });

  return {
    bars,
    rangeEnd: new Date(maxTime),
    rangeStart: new Date(minTime),
    totalDays: Math.max(1, Math.round(span / dayMs)),
  };
}
