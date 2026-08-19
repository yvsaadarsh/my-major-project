/**
 * Project health intelligence.
 *
 * Pure, deterministic, dependency-free. No Prisma, no React, no network, no
 * model provider. Given already-fetched rows for one tenant, it produces a
 * health score that a human can fully reconstruct from the output.
 *
 * Why this is deterministic rather than model-generated
 * -----------------------------------------------------
 * The product requirement is "human-readable explanations, not black-box
 * scores". A language model would move in the wrong direction: the same project
 * would get differently-worded justifications on two runs, the number itself
 * would not be reproducible, and no reviewer could verify the arithmetic. Here
 * every point deducted belongs to exactly one named signal, each signal exposes
 * the raw counts behind it, and the deductions sum to the score by construction.
 * The output is auditable by inspection.
 *
 * What this fixes versus the previous `calculateProjectHealth`
 * -----------------------------------------------------------
 * 1. **Size normalization.** The old formula did `score -= overdueTasks * 8`,
 *    so 13 overdue tasks scored 0 whether the project held 15 tasks or 500. A
 *    200-task project with 13 overdue is healthy; it was being called Critical.
 *    Every signal here is a *ratio* of the relevant population.
 * 2. **Ranked, real reasons.** The old `reasons[]` was a fixed four-element
 *    array that always included non-reasons ("No overdue open tasks"). Factors
 *    here are only present when they cost points, ordered by cost.
 * 3. **Velocity and schedule slippage** are now inputs, not just overdue counts.
 * 4. **Confidence.** A 2-task project no longer reports a score as confidently
 *    as a 500-task one.
 */

import { buildRecommendations, buildSummary } from "./intelligence-narrative";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type IntelTaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export type IntelTaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export type IntelTask = {
  id: string;
  title: string;
  status: IntelTaskStatus;
  priority: IntelTaskPriority;
  dueDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  assignedToUserId: string | null;
};

export type IntelMilestone = {
  id: string;
  name: string;
  dueDate: Date;
  status: "PLANNED" | "ON_TRACK" | "AT_RISK" | "MISSED" | "DONE";
};

export type IntelProject = {
  id: string;
  name: string;
  status: "ACTIVE" | "COMPLETED" | "ARCHIVED";
  startDate: Date | null;
  endDate: Date | null;
};

/**
 * One recorded change to a task's due date.
 *
 * Derived from the activity log — see `scheduleChangesFromActivity`. Note that
 * this history only exists from the moment the application began recording
 * before/after due dates; anything earlier is unrecoverable. Callers must
 * surface that via `confidence`, not silently report zero slippage as if the
 * schedule had been stable.
 */
export type ScheduleChange = {
  taskId: string;
  changedAt: Date;
  fromDueDate: Date | null;
  toDueDate: Date | null;
};

const OPEN_STATUSES = new Set<IntelTaskStatus>(["TODO", "IN_PROGRESS", "BLOCKED"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function isTaskOpen(task: IntelTask): boolean {
  return OPEN_STATUSES.has(task.status);
}

export function isTaskOverdue(task: IntelTask, now: Date): boolean {
  return Boolean(task.dueDate && task.status !== "DONE" && task.dueDate.getTime() < now.getTime());
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalKey =
  | "overdue"
  | "blocked"
  | "slippage"
  | "velocity"
  | "milestone"
  | "deadline";

/**
 * Maximum points each signal can remove.
 *
 * These deliberately sum to 100, so "score" reads as "percentage of health
 * retained" and a reader can see at a glance that overdue work can cost at most
 * 26 points. Changing a weight changes the published policy, which is why they
 * live here as named constants rather than inline literals.
 */
export const SIGNAL_WEIGHTS: Record<SignalKey, number> = {
  overdue: 26,
  blocked: 22,
  slippage: 18,
  velocity: 14,
  milestone: 12,
  deadline: 8,
};

export type SignalSeverity = "ok" | "low" | "medium" | "high" | "critical";

export type HealthSignal = {
  key: SignalKey;
  /** Short label, e.g. "Overdue work". */
  label: string;
  /** Full sentence with the actual numbers in it. */
  detail: string;
  /** 0..1 — how bad this dimension is. */
  ratio: number;
  /** Points removed from 100 by this signal. */
  points: number;
  /** Ceiling for this signal, so `points` is readable in context. */
  maxPoints: number;
  severity: SignalSeverity;
  /** Raw numbers, for a UI that wants to render its own breakdown. */
  evidence: Record<string, number>;
};

function severityFromRatio(ratio: number): SignalSeverity {
  if (ratio <= 0) {
    return "ok";
  }
  if (ratio < 0.2) {
    return "low";
  }
  if (ratio < 0.45) {
    return "medium";
  }
  if (ratio < 0.7) {
    return "high";
  }
  return "critical";
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ---------------------------------------------------------------------------
// Velocity
// ---------------------------------------------------------------------------

export type VelocityTrend = {
  /** Tasks completed in the trailing `windowWeeks`. */
  recentCompleted: number;
  /** Tasks completed in the window before that, for comparison. */
  priorCompleted: number;
  /** Completions per week across the recent window. */
  recentPerWeek: number;
  priorPerWeek: number;
  /**
   * Fractional change, e.g. -0.5 means throughput halved. Null when the prior
   * window has no completions, because "infinite improvement" is not a number
   * worth showing and dividing by zero would produce one.
   */
  changeRatio: number | null;
  /**
   * `stalled` is reserved for projects that *were* delivering and stopped.
   * A project that has never completed a single task is `noDeliveries`, which
   * is a weaker signal: we genuinely cannot tell "not delivering" from "team
   * is not updating task status", and treating the two identically would brand
   * every quiet-but-fine project as critical.
   */
  direction: "improving" | "steady" | "declining" | "stalled" | "noDeliveries" | "unknown";
  /** Completions across the project's whole history, not just the windows. */
  totalCompleted: number;
  /** Weeks of history actually available, capped at 2 × windowWeeks. */
  weeksObserved: number;
};

export const VELOCITY_WINDOW_WEEKS = 4;

/**
 * Compare recent completion throughput against the preceding equivalent window.
 *
 * "Stalled" is reported separately from "declining": zero completions recently
 * after real activity before is a different situation from a gentle slowdown,
 * and a manager should read them differently.
 */
export function velocityTrend(
  tasks: IntelTask[],
  now: Date,
  windowWeeks = VELOCITY_WINDOW_WEEKS,
): VelocityTrend {
  const windowMs = windowWeeks * WEEK_MS;
  const recentStart = now.getTime() - windowMs;
  const priorStart = recentStart - windowMs;

  let recentCompleted = 0;
  let priorCompleted = 0;
  let totalCompleted = 0;
  let earliestActivity: number | null = null;

  for (const task of tasks) {
    const created = task.createdAt.getTime();
    if (earliestActivity === null || created < earliestActivity) {
      earliestActivity = created;
    }

    if (task.status !== "DONE" || !task.completedAt) {
      continue;
    }

    totalCompleted += 1;
    const completed = task.completedAt.getTime();

    if (completed >= recentStart && completed <= now.getTime()) {
      recentCompleted += 1;
    } else if (completed >= priorStart && completed < recentStart) {
      priorCompleted += 1;
    }
  }

  const observedMs = earliestActivity === null ? 0 : now.getTime() - earliestActivity;
  const weeksObserved = Math.min(round(observedMs / WEEK_MS), windowWeeks * 2);

  const recentPerWeek = round(recentCompleted / windowWeeks, 2);
  const priorPerWeek = round(priorCompleted / windowWeeks, 2);

  let changeRatio: number | null = null;
  let direction: VelocityTrend["direction"] = "unknown";

  if (priorCompleted === 0 && recentCompleted === 0) {
    if (weeksObserved < windowWeeks) {
      direction = "unknown";
    } else if (totalCompleted === 0) {
      // Nothing has ever been completed, so there is no throughput to have
      // stopped. Weaker signal — see the `direction` docs.
      direction = "noDeliveries";
    } else {
      direction = "stalled";
    }
  } else if (priorCompleted === 0) {
    direction = "improving";
  } else {
    changeRatio = round((recentCompleted - priorCompleted) / priorCompleted, 2);

    if (recentCompleted === 0) {
      direction = "stalled";
    } else if (changeRatio <= -0.25) {
      direction = "declining";
    } else if (changeRatio >= 0.25) {
      direction = "improving";
    } else {
      direction = "steady";
    }
  }

  return {
    changeRatio,
    direction,
    priorCompleted,
    priorPerWeek,
    recentCompleted,
    recentPerWeek,
    totalCompleted,
    weeksObserved,
  };
}

/**
 * Weight applied to a project that has never completed anything.
 *
 * Half, not full: the data cannot distinguish "genuinely not delivering" from
 * "delivering but not updating task status", so this flags a concern without
 * asserting a confirmed stall.
 */
export const NO_DELIVERIES_RATIO = 0.5;

// ---------------------------------------------------------------------------
// Schedule slippage
// ---------------------------------------------------------------------------

export type SlippageStats = {
  /** Changes that pushed a due date later. */
  pushCount: number;
  /** Changes that pulled a due date earlier. */
  pullCount: number;
  /** Distinct tasks whose due date moved later at least once. */
  tasksPushed: number;
  /** Total days added across all pushes. */
  totalDaysPushed: number;
  /** Mean days added per push. */
  averageDaysPerPush: number;
  /** Worst single push, in days. */
  worstPushDays: number;
  /** Pushes on tasks that block other work — slippage that propagates. */
  blockerPushCount: number;
  /** True when no due-date history is available at all. */
  noHistory: boolean;
};

/**
 * Aggregate due-date churn.
 *
 * Only pushes (dates moving later) count against health. Pulling a date earlier
 * is a team tightening its own schedule, which is not a risk signal. A task
 * gaining a due date where it previously had none is also not slippage — there
 * was no commitment to slip from.
 *
 * `blockerIds` lets pushes on gating tasks be weighted higher, because a blocker
 * slipping moves everything behind it. That is the "dependency slippage" the
 * score cares about, as distinct from an isolated task moving.
 */
export function slippageStats(
  changes: ScheduleChange[],
  blockerIds: Set<string>,
): SlippageStats {
  let pushCount = 0;
  let pullCount = 0;
  let totalDaysPushed = 0;
  let worstPushDays = 0;
  let blockerPushCount = 0;
  const pushedTasks = new Set<string>();

  for (const change of changes) {
    // No previous commitment, or the date was cleared: not slippage.
    if (change.fromDueDate === null || change.toDueDate === null) {
      continue;
    }

    const deltaDays = (change.toDueDate.getTime() - change.fromDueDate.getTime()) / DAY_MS;

    if (deltaDays > 0) {
      pushCount += 1;
      totalDaysPushed += deltaDays;
      pushedTasks.add(change.taskId);
      worstPushDays = Math.max(worstPushDays, deltaDays);

      if (blockerIds.has(change.taskId)) {
        blockerPushCount += 1;
      }
    } else if (deltaDays < 0) {
      pullCount += 1;
    }
  }

  return {
    averageDaysPerPush: pushCount === 0 ? 0 : round(totalDaysPushed / pushCount),
    blockerPushCount,
    noHistory: changes.length === 0,
    pullCount,
    pushCount,
    tasksPushed: pushedTasks.size,
    totalDaysPushed: round(totalDaysPushed),
    worstPushDays: round(worstPushDays),
  };
}

/** Days of push, per open task, at which the slippage signal saturates. */
export const SLIPPAGE_SATURATION_DAYS_PER_TASK = 10;

/** One task's due-date history, for the slippage retrospective. */
export type TaskSlippage = {
  taskId: string;
  title: string;
  /** Number of times the due date moved later. */
  pushes: number;
  /** Total days added across those pushes. */
  totalDaysPushed: number;
  /** Largest single push, in days. */
  worstPushDays: number;
  /** Whether this task blocks other open work, so its slips propagate. */
  isBlocker: boolean;
  /** Original committed date, before any recorded push. */
  originalDueDate: Date | null;
  /** Most recent date after the last recorded change. */
  currentDueDate: Date | null;
  firstChangedAt: Date;
  lastChangedAt: Date;
};

/**
 * Per-task slippage, worst first.
 *
 * Answers "which commitments keep moving?", which the aggregate cannot. A single
 * task re-dated six times is a very different problem from six tasks each moved
 * once, and the totals look identical.
 *
 * Only pushes are counted, for the same reason as `slippageStats`: pulling a date
 * earlier is a team tightening its own schedule, not a risk.
 */
export function slippageByTask(
  changes: ScheduleChange[],
  titleOf: (taskId: string) => string,
  blockerIds: Set<string>,
  limit = 20,
): TaskSlippage[] {
  const byTask = new Map<string, ScheduleChange[]>();

  for (const change of changes) {
    if (change.fromDueDate === null || change.toDueDate === null) {
      continue;
    }
    if (change.toDueDate.getTime() <= change.fromDueDate.getTime()) {
      continue;
    }

    const bucket = byTask.get(change.taskId);
    if (bucket === undefined) {
      byTask.set(change.taskId, [change]);
    } else {
      bucket.push(change);
    }
  }

  const rows: TaskSlippage[] = [];

  for (const [taskId, taskChanges] of byTask) {
    // Chronological, so "original" and "current" are the true endpoints even if
    // the caller passed them unsorted.
    const ordered = [...taskChanges].sort(
      (a, b) => a.changedAt.getTime() - b.changedAt.getTime(),
    );

    let totalDaysPushed = 0;
    let worstPushDays = 0;

    for (const change of ordered) {
      const days =
        (change.toDueDate!.getTime() - change.fromDueDate!.getTime()) / DAY_MS;
      totalDaysPushed += days;
      worstPushDays = Math.max(worstPushDays, days);
    }

    rows.push({
      currentDueDate: ordered[ordered.length - 1].toDueDate,
      firstChangedAt: ordered[0].changedAt,
      isBlocker: blockerIds.has(taskId),
      lastChangedAt: ordered[ordered.length - 1].changedAt,
      originalDueDate: ordered[0].fromDueDate,
      pushes: ordered.length,
      taskId,
      title: titleOf(taskId),
      totalDaysPushed: round(totalDaysPushed),
      worstPushDays: round(worstPushDays),
    });
  }

  // Total ordering: most days lost first, then most re-dated, then stable keys.
  rows.sort(
    (a, b) =>
      b.totalDaysPushed - a.totalDaysPushed ||
      b.pushes - a.pushes ||
      a.title.localeCompare(b.title) ||
      a.taskId.localeCompare(b.taskId),
  );

  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

export type ConfidenceLevel = "high" | "medium" | "low" | "insufficient";

export type HealthConfidence = {
  level: ConfidenceLevel;
  /** Plain-language notes about what limits the reading. */
  caveats: string[];
};

/** Below this many tasks, a percentage-based score is mostly noise. */
export const MIN_TASKS_FOR_CONFIDENCE = 8;
/** Below this many completions, velocity is not meaningful. */
export const MIN_COMPLETIONS_FOR_VELOCITY = 5;

function assessConfidence(
  taskCount: number,
  completedCount: number,
  velocity: VelocityTrend,
  slippage: SlippageStats,
  milestoneCount: number,
): HealthConfidence {
  const caveats: string[] = [];
  let penalty = 0;

  if (taskCount === 0) {
    return {
      caveats: ["This project has no tasks yet, so there is nothing to assess."],
      level: "insufficient",
    };
  }

  if (taskCount < MIN_TASKS_FOR_CONFIDENCE) {
    penalty += 2;
    caveats.push(
      `Only ${plural(taskCount, "task")} — with so few, one task changes the score a lot.`,
    );
  }

  if (completedCount < MIN_COMPLETIONS_FOR_VELOCITY) {
    penalty += 1;
    caveats.push(
      `Velocity is based on ${plural(completedCount, "completed task")}, which is too few to show a reliable trend.`,
    );
  }

  if (velocity.weeksObserved < VELOCITY_WINDOW_WEEKS) {
    penalty += 1;
    caveats.push(
      `The project is about ${plural(Math.max(1, Math.round(velocity.weeksObserved)), "week")} old, so there is no earlier period to compare against.`,
    );
  }

  if (slippage.noHistory) {
    penalty += 1;
    caveats.push(
      "No due-date history has been recorded yet, so schedule slippage reads as zero. " +
        "This metric becomes meaningful after a few weeks of use.",
    );
  }

  if (milestoneCount === 0) {
    caveats.push("No milestones are defined, so milestone risk contributes nothing.");
  }

  const level: ConfidenceLevel =
    penalty === 0 ? "high" : penalty <= 1 ? "high" : penalty <= 2 ? "medium" : "low";

  return { caveats, level };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthBand = "Healthy" | "Watch" | "At risk" | "Critical";

export type ProjectIntelligence = {
  projectId: string;
  projectName: string;
  /** 0..100. Equals 100 minus the sum of every signal's points. */
  score: number;
  band: HealthBand;
  /** Percentage of tasks done. */
  completion: number;
  /** Signals that cost points, worst first. */
  factors: HealthSignal[];
  /** Signals that cost nothing, so a reader can see what was checked. */
  healthy: HealthSignal[];
  confidence: HealthConfidence;
  velocity: VelocityTrend;
  slippage: SlippageStats;
  /** One-paragraph plain-language summary built from the ranked factors. */
  summary: string;
  /** Read-only suggestions, most valuable first. Never applied automatically. */
  recommendations: string[];
  counts: {
    total: number;
    open: number;
    done: number;
    overdue: number;
    blocked: number;
    unassignedOpen: number;
    milestones: number;
    milestonesAtRisk: number;
  };
};

export const BAND_THRESHOLDS = { atRisk: 45, healthy: 82, watch: 66 } as const;

export function bandForScore(score: number): HealthBand {
  if (score >= BAND_THRESHOLDS.healthy) {
    return "Healthy";
  }
  if (score >= BAND_THRESHOLDS.watch) {
    return "Watch";
  }
  if (score >= BAND_THRESHOLDS.atRisk) {
    return "At risk";
  }
  return "Critical";
}

/**
 * Score one project's health.
 *
 * All arrays must already be filtered to this project and this tenant by the
 * caller. This function does no filtering by `projectId` on purpose: silently
 * accepting foreign rows and filtering them here would make it impossible to
 * tell a caller bug from correct behaviour.
 *
 * @param blockerIds ids of tasks that block other open work — from
 *   `dependency-risk`. Used to weight slippage on gating tasks.
 */
export function analyzeProjectHealth(
  project: IntelProject,
  tasks: IntelTask[],
  milestones: IntelMilestone[],
  scheduleChanges: ScheduleChange[],
  blockerIds: Set<string>,
  now: Date,
): ProjectIntelligence {
  const total = tasks.length;
  const openTasks = tasks.filter(isTaskOpen);
  const doneCount = tasks.filter((task) => task.status === "DONE").length;
  const openCount = openTasks.length;

  const overdueTasks = tasks.filter((task) => isTaskOverdue(task, now));
  const blockedTasks = openTasks.filter((task) => task.status === "BLOCKED");
  const unassignedOpen = openTasks.filter((task) => task.assignedToUserId === null).length;

  const milestonesAtRisk = milestones.filter(
    (milestone) => milestone.status === "AT_RISK" || milestone.status === "MISSED",
  ).length;

  const velocity = velocityTrend(tasks, now);
  const slippage = slippageStats(scheduleChanges, blockerIds);

  const completion =
    total === 0 ? (project.status === "COMPLETED" ? 100 : 0) : Math.round((doneCount / total) * 100);

  const signals: HealthSignal[] = [];

  // ── Overdue ───────────────────────────────────────────────────────────────
  // Normalized against OPEN tasks, not all tasks: a project that finished 400
  // tasks late but has 2 open ones on schedule is currently healthy.
  {
    const ratio = openCount === 0 ? 0 : clamp01(overdueTasks.length / openCount);
    const points = Math.round(ratio * SIGNAL_WEIGHTS.overdue);

    signals.push({
      detail:
        overdueTasks.length === 0
          ? openCount === 0
            ? "No open tasks, so nothing can be overdue."
            : `None of the ${plural(openCount, "open task")} are past their due date.`
          : `${overdueTasks.length} of ${plural(openCount, "open task")} ${
              overdueTasks.length === 1 ? "is" : "are"
            } past their due date (${Math.round(ratio * 100)}%).`,
      evidence: { openTasks: openCount, overdueTasks: overdueTasks.length },
      key: "overdue",
      label: "Overdue work",
      maxPoints: SIGNAL_WEIGHTS.overdue,
      points,
      ratio: round(ratio, 3),
      severity: severityFromRatio(ratio),
    });
  }

  // ── Blocked ───────────────────────────────────────────────────────────────
  {
    const ratio = openCount === 0 ? 0 : clamp01(blockedTasks.length / openCount);
    const points = Math.round(ratio * SIGNAL_WEIGHTS.blocked);

    signals.push({
      detail:
        blockedTasks.length === 0
          ? "No open tasks are marked blocked."
          : `${blockedTasks.length} of ${plural(openCount, "open task")} ${
              blockedTasks.length === 1 ? "is" : "are"
            } blocked (${Math.round(ratio * 100)}%).`,
      evidence: { blockedTasks: blockedTasks.length, openTasks: openCount },
      key: "blocked",
      label: "Blocked work",
      maxPoints: SIGNAL_WEIGHTS.blocked,
      points,
      ratio: round(ratio, 3),
      severity: severityFromRatio(ratio),
    });
  }

  // ── Slippage ──────────────────────────────────────────────────────────────
  // Days pushed per open task, so a big project is not penalised for having
  // more absolute churn. Pushes on blocking tasks count double, because they
  // move every task behind them too.
  {
    const weightedDays =
      slippage.totalDaysPushed +
      slippage.blockerPushCount * slippage.averageDaysPerPush;
    const perTask = openCount === 0 ? 0 : weightedDays / openCount;
    const ratio = clamp01(perTask / SLIPPAGE_SATURATION_DAYS_PER_TASK);
    const points = Math.round(ratio * SIGNAL_WEIGHTS.slippage);

    let detail: string;
    if (slippage.noHistory) {
      detail =
        "No due-date changes have been recorded yet. This reads as no slippage, but the history only " +
        "starts from when recording began — treat it as unknown rather than good.";
    } else if (slippage.pushCount === 0) {
      detail = "No due date has been pushed later.";
    } else {
      detail =
        `${plural(slippage.pushCount, "due-date push")} across ${plural(slippage.tasksPushed, "task")}, ` +
        `adding ${plural(Math.round(slippage.totalDaysPushed), "day")} in total ` +
        `(worst single slip ${plural(Math.round(slippage.worstPushDays), "day")})` +
        (slippage.blockerPushCount > 0
          ? `. ${plural(slippage.blockerPushCount, "push")} landed on tasks that block other work, so the delay propagated.`
          : ".");
    }

    signals.push({
      detail,
      evidence: {
        blockerPushes: slippage.blockerPushCount,
        daysPushed: Math.round(slippage.totalDaysPushed),
        pushes: slippage.pushCount,
        tasksPushed: slippage.tasksPushed,
      },
      key: "slippage",
      label: "Schedule slippage",
      maxPoints: SIGNAL_WEIGHTS.slippage,
      points,
      ratio: round(ratio, 3),
      severity: severityFromRatio(ratio),
    });
  }

  // ── Velocity ──────────────────────────────────────────────────────────────
  {
    let ratio = 0;

    if (velocity.direction === "stalled") {
      ratio = 1;
    } else if (velocity.direction === "noDeliveries") {
      ratio = NO_DELIVERIES_RATIO;
    } else if (velocity.direction === "declining" && velocity.changeRatio !== null) {
      // A 25% drop is the threshold for "declining"; a 100% drop is stalled.
      ratio = clamp01(Math.abs(velocity.changeRatio));
    }

    // An unknown trend must not be scored as a problem. A brand-new project
    // has no history, and penalising it for that would make every new project
    // look unhealthy on day one.
    const points = velocity.direction === "unknown" ? 0 : Math.round(ratio * SIGNAL_WEIGHTS.velocity);

    const detail = (() => {
      switch (velocity.direction) {
        case "unknown":
          return "Not enough history yet to compare throughput against an earlier period.";
        case "stalled":
          return `Nothing has been completed in the last ${VELOCITY_WINDOW_WEEKS} weeks, after ${plural(velocity.priorCompleted, "completion")} in the ${VELOCITY_WINDOW_WEEKS} weeks before.`;
        case "noDeliveries":
          return `No task has ever been marked done on this project, over about ${plural(Math.max(1, Math.round(velocity.weeksObserved)), "week")}. This may mean work is not progressing, or simply that statuses are not being updated — counted at half weight because the data cannot tell those apart.`;
        case "declining":
          return `Throughput fell from ${velocity.priorCompleted} to ${velocity.recentCompleted} completions (${Math.round((velocity.changeRatio ?? 0) * 100)}%) versus the previous ${VELOCITY_WINDOW_WEEKS} weeks.`;
        case "improving":
          return `Throughput rose from ${velocity.priorCompleted} to ${velocity.recentCompleted} completions versus the previous ${VELOCITY_WINDOW_WEEKS} weeks.`;
        default:
          return `Throughput is steady at about ${velocity.recentPerWeek} tasks per week.`;
      }
    })();

    signals.push({
      detail,
      evidence: {
        priorCompleted: velocity.priorCompleted,
        recentCompleted: velocity.recentCompleted,
        weeksObserved: velocity.weeksObserved,
      },
      key: "velocity",
      label: "Delivery velocity",
      maxPoints: SIGNAL_WEIGHTS.velocity,
      points,
      ratio: round(ratio, 3),
      severity: severityFromRatio(ratio),
    });
  }

  // ── Milestones ────────────────────────────────────────────────────────────
  {
    const ratio = milestones.length === 0 ? 0 : clamp01(milestonesAtRisk / milestones.length);
    const points = Math.round(ratio * SIGNAL_WEIGHTS.milestone);

    signals.push({
      detail:
        milestones.length === 0
          ? "No milestones are defined for this project."
          : milestonesAtRisk === 0
            ? `All ${plural(milestones.length, "milestone")} are on track.`
            : `${milestonesAtRisk} of ${plural(milestones.length, "milestone")} ${
                milestonesAtRisk === 1 ? "is" : "are"
              } at risk or missed.`,
      evidence: { atRisk: milestonesAtRisk, milestones: milestones.length },
      key: "milestone",
      label: "Milestone risk",
      maxPoints: SIGNAL_WEIGHTS.milestone,
      points,
      ratio: round(ratio, 3),
      severity: severityFromRatio(ratio),
    });
  }

  // ── Deadline ──────────────────────────────────────────────────────────────
  {
    const past =
      project.endDate !== null &&
      project.status !== "COMPLETED" &&
      project.endDate.getTime() < now.getTime();
    const daysOver = past && project.endDate ? Math.floor((now.getTime() - project.endDate.getTime()) / DAY_MS) : 0;
    const ratio = past ? 1 : 0;

    signals.push({
      detail: past
        ? `The project end date passed ${plural(daysOver, "day")} ago with ${plural(openCount, "task")} still open.`
        : project.endDate === null
          ? "No project end date is set."
          : "The project end date has not passed.",
      evidence: { daysOverdue: daysOver, openTasks: openCount },
      key: "deadline",
      label: "Project deadline",
      maxPoints: SIGNAL_WEIGHTS.deadline,
      points: Math.round(ratio * SIGNAL_WEIGHTS.deadline),
      ratio,
      severity: past ? "critical" : "ok",
    });
  }

  const deducted = signals.reduce((sum, signal) => sum + signal.points, 0);
  const score = Math.max(0, Math.min(100, 100 - deducted));

  // Factors are the signals that actually cost something, worst first. A total
  // ordering (points, then ratio, then key) keeps the list stable across runs.
  const factors = signals
    .filter((signal) => signal.points > 0)
    .sort((a, b) => b.points - a.points || b.ratio - a.ratio || a.key.localeCompare(b.key));

  const healthy = signals
    .filter((signal) => signal.points === 0)
    .sort((a, b) => a.key.localeCompare(b.key));

  const confidence = assessConfidence(
    total,
    doneCount,
    velocity,
    slippage,
    milestones.length,
  );

  const band = bandForScore(score);

  return {
    band,
    completion,
    confidence,
    counts: {
      blocked: blockedTasks.length,
      done: doneCount,
      milestones: milestones.length,
      milestonesAtRisk,
      open: openCount,
      overdue: overdueTasks.length,
      total,
      unassignedOpen,
    },
    factors,
    healthy,
    projectId: project.id,
    projectName: project.name,
    recommendations: buildRecommendations(factors, {
      blockedCount: blockedTasks.length,
      overdueCount: overdueTasks.length,
      slippage,
      unassignedOpen,
      velocity,
    }),
    score,
    slippage,
    summary: buildSummary(project.name, score, band, completion, factors, confidence),
    velocity,
  };
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export type PortfolioSummary = {
  projectCount: number;
  averageScore: number;
  worstScore: number;
  bandCounts: Record<HealthBand, number>;
  /** Projects needing attention, worst first. */
  attentionOrder: Array<{ projectId: string; projectName: string; score: number; band: HealthBand }>;
  headline: string;
};

/** Roll several project analyses into one portfolio view. */
export function summarizePortfolio(analyses: ProjectIntelligence[]): PortfolioSummary {
  const bandCounts: Record<HealthBand, number> = {
    "At risk": 0,
    Critical: 0,
    Healthy: 0,
    Watch: 0,
  };

  for (const analysis of analyses) {
    bandCounts[analysis.band] += 1;
  }

  const ranked = [...analyses].sort(
    (a, b) => a.score - b.score || a.projectName.localeCompare(b.projectName) || a.projectId.localeCompare(b.projectId),
  );

  const total = analyses.reduce((sum, analysis) => sum + analysis.score, 0);
  const averageScore = analyses.length === 0 ? 0 : Math.round(total / analyses.length);
  const needsAttention = ranked.filter(
    (analysis) => analysis.band === "At risk" || analysis.band === "Critical",
  );

  const headline =
    analyses.length === 0
      ? "No projects to assess yet."
      : needsAttention.length === 0
        ? `All ${plural(analyses.length, "project")} are healthy or on watch, averaging ${averageScore}/100.`
        : `${plural(needsAttention.length, "project")} of ${analyses.length} need attention, starting with ${needsAttention[0].projectName} at ${needsAttention[0].score}/100.`;

  return {
    attentionOrder: ranked.map((analysis) => ({
      band: analysis.band,
      projectId: analysis.projectId,
      projectName: analysis.projectName,
      score: analysis.score,
    })),
    averageScore,
    bandCounts,
    headline,
    projectCount: analyses.length,
    worstScore: ranked.length === 0 ? 0 : ranked[0].score,
  };
}

// ---------------------------------------------------------------------------
// Activity log adapter
// ---------------------------------------------------------------------------

/** Shape of the activity rows this module can read. */
export type ActivityRowLike = {
  entityType: string;
  entityId: string;
  action: string;
  createdAt: Date;
  metadata: unknown;
};

function parseDateish(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Extract due-date changes from activity log rows.
 *
 * Tolerant by design: rows written before due-date recording existed have no
 * `fromDueDate`/`toDueDate` keys and are skipped rather than throwing. The
 * metadata column is `Json`, so its contents are genuinely `unknown` at compile
 * time and every field must be checked before use.
 */
export function scheduleChangesFromActivity(rows: ActivityRowLike[]): ScheduleChange[] {
  const changes: ScheduleChange[] = [];

  for (const row of rows) {
    if (row.entityType !== "task") {
      continue;
    }
    if (row.action !== "task.updated" && row.action !== "task.status_changed") {
      continue;
    }
    if (row.metadata === null || typeof row.metadata !== "object") {
      continue;
    }

    const metadata = row.metadata as Record<string, unknown>;

    // Absent keys mean this row predates due-date recording.
    if (!("fromDueDate" in metadata) && !("toDueDate" in metadata)) {
      continue;
    }

    const from = parseDateish(metadata.fromDueDate);
    const to = parseDateish(metadata.toDueDate);

    if (from === null && to === null) {
      continue;
    }

    changes.push({
      changedAt: row.createdAt,
      fromDueDate: from,
      taskId: row.entityId,
      toDueDate: to,
    });
  }

  // Oldest first, with id as a tiebreaker so equal timestamps do not reorder.
  changes.sort(
    (a, b) => a.changedAt.getTime() - b.changedAt.getTime() || a.taskId.localeCompare(b.taskId),
  );

  return changes;
}

/**
 * Ids of tasks that block at least one other open task.
 *
 * Kept here rather than importing from `dependency-risk` so this module stays
 * standalone; the caller may pass a richer set computed there instead.
 */
export function blockerIdsFrom(
  dependencies: Array<{ sourceTaskId: string; targetTaskId: string; type: string }>,
  openTaskIds: Set<string>,
): Set<string> {
  const blockers = new Set<string>();

  for (const dependency of dependencies) {
    if (dependency.type === "RELATED_TO") {
      continue;
    }

    const blocker =
      dependency.type === "BLOCKS" ? dependency.sourceTaskId : dependency.targetTaskId;
    const blocked =
      dependency.type === "BLOCKS" ? dependency.targetTaskId : dependency.sourceTaskId;

    if (blocker !== blocked && openTaskIds.has(blocked)) {
      blockers.add(blocker);
    }
  }

  return blockers;
}
