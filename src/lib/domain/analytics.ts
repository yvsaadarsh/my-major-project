/**
 * Analytics domain layer — pure, deterministic, side-effect-free.
 *
 * Every function here takes plain data (already tenant-scoped by the caller) and
 * returns plain numbers/objects. No Prisma, no React, no AI, no randomness, no
 * hidden time source (the "now" is always injectable so results are reproducible
 * and testable). The same code can run on the server (API routes) or the client.
 *
 * The guiding rule for this file: **no mystery scores**. Anything surfaced to a
 * user is either a raw count, a plain ratio, or a value with an accompanying
 * explanation the caller can render.
 */

export type AnalyticsTask = {
  id: string;
  status: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  assignedToUserId: string | null;
  projectId: string;
  milestoneId?: string | null;
};

export type AnalyticsMilestone = {
  id: string;
  projectId: string;
  name: string;
  dueDate: Date;
  status: "PLANNED" | "ON_TRACK" | "AT_RISK" | "MISSED" | "DONE";
};

export type AnalyticsMember = {
  userId: string;
  name: string;
  role: "ADMIN" | "MANAGER" | "MEMBER";
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const OPEN_STATUSES = new Set(["TODO", "IN_PROGRESS", "BLOCKED"]);

function round(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isTaskOverdue(task: AnalyticsTask, now: Date): boolean {
  return Boolean(task.dueDate && task.status !== "DONE" && task.dueDate.getTime() < now.getTime());
}

// ---------------------------------------------------------------------------
// Status & priority distributions
// ---------------------------------------------------------------------------

export type StatusDistribution = {
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
  total: number;
};

export function statusDistribution(tasks: AnalyticsTask[]): StatusDistribution {
  const dist: StatusDistribution = { todo: 0, inProgress: 0, blocked: 0, done: 0, total: tasks.length };
  for (const task of tasks) {
    if (task.status === "TODO") dist.todo += 1;
    else if (task.status === "IN_PROGRESS") dist.inProgress += 1;
    else if (task.status === "BLOCKED") dist.blocked += 1;
    else if (task.status === "DONE") dist.done += 1;
  }
  return dist;
}

export type PriorityDistribution = {
  low: number;
  medium: number;
  high: number;
  urgent: number;
  total: number;
};

/** Distribution of *open* work by priority (DONE tasks are excluded — this is a
 * picture of what remains, not history). */
export function priorityDistribution(tasks: AnalyticsTask[]): PriorityDistribution {
  const dist: PriorityDistribution = { low: 0, medium: 0, high: 0, urgent: 0, total: 0 };
  for (const task of tasks) {
    if (task.status === "DONE") continue;
    dist.total += 1;
    if (task.priority === "LOW") dist.low += 1;
    else if (task.priority === "MEDIUM") dist.medium += 1;
    else if (task.priority === "HIGH") dist.high += 1;
    else if (task.priority === "URGENT") dist.urgent += 1;
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Throughput — completions per week
// ---------------------------------------------------------------------------

export type ThroughputBucket = {
  /** ISO date (UTC midnight) of the Monday that starts the week. */
  weekStart: string;
  /** Human label like "Aug 4". */
  label: string;
  completed: number;
};

/** Returns UTC-midnight Monday for the week containing `date`. */
function startOfWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sun … 6 = Sat
  const diff = (day + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Tasks completed per week for the trailing `weeks` window (default 8),
 * including empty weeks so a chart never has gaps. Ordered oldest → newest.
 */
export function throughputByWeek(tasks: AnalyticsTask[], weeks = 8, now = new Date()): ThroughputBucket[] {
  const currentWeekStart = startOfWeek(now);
  const buckets: ThroughputBucket[] = [];
  const index = new Map<number, ThroughputBucket>();

  for (let i = weeks - 1; i >= 0; i -= 1) {
    const ws = new Date(currentWeekStart.getTime() - i * WEEK_MS);
    const bucket: ThroughputBucket = {
      weekStart: ws.toISOString().slice(0, 10),
      label: `${MONTHS[ws.getUTCMonth()]} ${ws.getUTCDate()}`,
      completed: 0,
    };
    buckets.push(bucket);
    index.set(ws.getTime(), bucket);
  }

  const windowStart = currentWeekStart.getTime() - (weeks - 1) * WEEK_MS;
  for (const task of tasks) {
    if (task.status !== "DONE" || !task.completedAt) continue;
    const ws = startOfWeek(task.completedAt).getTime();
    if (ws < windowStart || ws > currentWeekStart.getTime()) continue;
    const bucket = index.get(ws);
    if (bucket) bucket.completed += 1;
  }

  return buckets;
}

// ---------------------------------------------------------------------------
// Cycle time — created → completed
// ---------------------------------------------------------------------------

export type CycleTimeStats = {
  /** Number of completed tasks that had a usable created→completed span. */
  sampleSize: number;
  averageDays: number;
  medianDays: number;
  fastestDays: number;
  slowestDays: number;
};

export function cycleTimeStats(tasks: AnalyticsTask[]): CycleTimeStats {
  const spans: number[] = [];
  for (const task of tasks) {
    if (task.status !== "DONE" || !task.completedAt) continue;
    const ms = task.completedAt.getTime() - task.createdAt.getTime();
    if (ms < 0) continue; // guard against dirty data
    spans.push(ms / DAY_MS);
  }

  if (spans.length === 0) {
    return { sampleSize: 0, averageDays: 0, medianDays: 0, fastestDays: 0, slowestDays: 0 };
  }

  spans.sort((a, b) => a - b);
  const sum = spans.reduce((total, value) => total + value, 0);
  const mid = Math.floor(spans.length / 2);
  const median = spans.length % 2 === 0 ? (spans[mid - 1] + spans[mid]) / 2 : spans[mid];

  return {
    sampleSize: spans.length,
    averageDays: round(sum / spans.length, 1),
    medianDays: round(median, 1),
    fastestDays: round(spans[0], 1),
    slowestDays: round(spans[spans.length - 1], 1),
  };
}

// ---------------------------------------------------------------------------
// Headline org / project metrics
// ---------------------------------------------------------------------------

export type WorkMetrics = {
  totalTasks: number;
  openTasks: number;
  completedTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  urgentOpenTasks: number;
  unassignedOpenTasks: number;
  completionRate: number; // % of all tasks that are DONE
  overdueRate: number; // % of OPEN tasks that are overdue
};

export function workMetrics(tasks: AnalyticsTask[], now = new Date()): WorkMetrics {
  let open = 0;
  let completed = 0;
  let overdue = 0;
  let blocked = 0;
  let urgentOpen = 0;
  let unassignedOpen = 0;

  for (const task of tasks) {
    const isOpen = OPEN_STATUSES.has(task.status);
    if (task.status === "DONE") completed += 1;
    if (isOpen) open += 1;
    if (isTaskOverdue(task, now)) overdue += 1;
    if (task.status === "BLOCKED") blocked += 1;
    if (isOpen && task.priority === "URGENT") urgentOpen += 1;
    if (isOpen && !task.assignedToUserId) unassignedOpen += 1;
  }

  return {
    totalTasks: tasks.length,
    openTasks: open,
    completedTasks: completed,
    overdueTasks: overdue,
    blockedTasks: blocked,
    urgentOpenTasks: urgentOpen,
    unassignedOpenTasks: unassignedOpen,
    completionRate: tasks.length ? round((completed / tasks.length) * 100) : 0,
    overdueRate: open ? round((overdue / open) * 100) : 0,
  };
}

// ---------------------------------------------------------------------------
// Team workload (with names + a plain, explained load level)
// ---------------------------------------------------------------------------

export type MemberWorkload = {
  userId: string;
  name: string;
  role: "ADMIN" | "MANAGER" | "MEMBER";
  openTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  urgentTasks: number;
  completedTasks: number;
  /** A transparent bucket derived only from open-task count + overdue count. */
  loadLevel: "Idle" | "Steady" | "Busy" | "Overloaded";
};

export function teamWorkload(
  tasks: AnalyticsTask[],
  members: AnalyticsMember[],
  now = new Date(),
): MemberWorkload[] {
  const rows = new Map<string, MemberWorkload>();
  for (const member of members) {
    rows.set(member.userId, {
      userId: member.userId,
      name: member.name,
      role: member.role,
      openTasks: 0,
      overdueTasks: 0,
      blockedTasks: 0,
      urgentTasks: 0,
      completedTasks: 0,
      loadLevel: "Idle",
    });
  }

  for (const task of tasks) {
    if (!task.assignedToUserId) continue;
    const row = rows.get(task.assignedToUserId);
    if (!row) continue; // assignee is not an active member — skip
    if (task.status === "DONE") {
      row.completedTasks += 1;
      continue;
    }
    if (OPEN_STATUSES.has(task.status)) row.openTasks += 1;
    if (task.status === "BLOCKED") row.blockedTasks += 1;
    if (task.priority === "URGENT") row.urgentTasks += 1;
    if (isTaskOverdue(task, now)) row.overdueTasks += 1;
  }

  for (const row of rows.values()) {
    row.loadLevel = deriveLoadLevel(row.openTasks, row.overdueTasks);
  }

  // Busiest first, then name for stable ordering.
  return [...rows.values()].sort(
    (a, b) => b.openTasks - a.openTasks || a.name.localeCompare(b.name),
  );
}

function deriveLoadLevel(openTasks: number, overdueTasks: number): MemberWorkload["loadLevel"] {
  if (openTasks === 0) return "Idle";
  if (openTasks >= 8 || overdueTasks >= 3) return "Overloaded";
  if (openTasks >= 4 || overdueTasks >= 1) return "Busy";
  return "Steady";
}

// ---------------------------------------------------------------------------
// Milestone performance
// ---------------------------------------------------------------------------

export type MilestonePerformance = {
  id: string;
  name: string;
  projectId: string;
  status: AnalyticsMilestone["status"];
  dueDate: string;
  totalTasks: number;
  completedTasks: number;
  completion: number;
  overdue: boolean;
  daysToDue: number;
};

export function milestonePerformance(
  milestones: AnalyticsMilestone[],
  tasks: AnalyticsTask[],
  now = new Date(),
): MilestonePerformance[] {
  return milestones
    .map((milestone) => {
      const scoped = tasks.filter((task) => task.milestoneId === milestone.id);
      const completed = scoped.filter((task) => task.status === "DONE").length;
      const completion = scoped.length ? round((completed / scoped.length) * 100) : 0;
      const daysToDue = Math.ceil((milestone.dueDate.getTime() - now.getTime()) / DAY_MS);
      return {
        id: milestone.id,
        name: milestone.name,
        projectId: milestone.projectId,
        status: milestone.status,
        dueDate: milestone.dueDate.toISOString().slice(0, 10),
        totalTasks: scoped.length,
        completedTasks: completed,
        completion,
        overdue: milestone.status !== "DONE" && milestone.dueDate.getTime() < now.getTime(),
        daysToDue,
      };
    })
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

export type MilestoneSummary = {
  total: number;
  onTrack: number;
  atRisk: number;
  missed: number;
  done: number;
  planned: number;
};

export function milestoneSummary(milestones: AnalyticsMilestone[]): MilestoneSummary {
  const summary: MilestoneSummary = { total: milestones.length, onTrack: 0, atRisk: 0, missed: 0, done: 0, planned: 0 };
  for (const milestone of milestones) {
    if (milestone.status === "ON_TRACK") summary.onTrack += 1;
    else if (milestone.status === "AT_RISK") summary.atRisk += 1;
    else if (milestone.status === "MISSED") summary.missed += 1;
    else if (milestone.status === "DONE") summary.done += 1;
    else if (milestone.status === "PLANNED") summary.planned += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Aging — how long open tasks have been sitting
// ---------------------------------------------------------------------------

export type AgingBuckets = {
  /** Open tasks by age since creation. */
  freshUnderWeek: number; // < 7 days
  oneToTwoWeeks: number; // 7–13 days
  twoToFourWeeks: number; // 14–27 days
  overMonth: number; // >= 28 days
  oldestOpenDays: number;
};

export function agingBuckets(tasks: AnalyticsTask[], now = new Date()): AgingBuckets {
  const result: AgingBuckets = {
    freshUnderWeek: 0,
    oneToTwoWeeks: 0,
    twoToFourWeeks: 0,
    overMonth: 0,
    oldestOpenDays: 0,
  };

  for (const task of tasks) {
    if (!OPEN_STATUSES.has(task.status)) continue;
    const ageDays = (now.getTime() - task.createdAt.getTime()) / DAY_MS;
    if (ageDays > result.oldestOpenDays) result.oldestOpenDays = round(ageDays);
    if (ageDays < 7) result.freshUnderWeek += 1;
    else if (ageDays < 14) result.oneToTwoWeeks += 1;
    else if (ageDays < 28) result.twoToFourWeeks += 1;
    else result.overMonth += 1;
  }

  return result;
}
