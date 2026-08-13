/**
 * Automation engine — pure, deterministic domain layer.
 *
 * NO AI. NO prisma/react imports. This module decides *what* an automation rule
 * should do; the infra/route layer performs the database writes. Everything here
 * is trivially unit-testable: given a rule + an event it returns a plan.
 *
 * Two responsibilities:
 *  1. A tiny, safe condition DSL (`field op value [and ...]`) — no `eval()`.
 *  2. Trigger matching + deterministic dedupe keys + action planning.
 */
import type { HealthBand } from "@/lib/domain/project-intelligence";

export type AutomationTrigger =
  | "TASK_OVERDUE"
  | "TASK_STATUS_CHANGED"
  | "PROJECT_HEALTH_CHANGED";

export type AutomationAction =
  | "NOTIFY_MANAGER"
  | "UPDATE_MILESTONE_PROGRESS"
  | "WRITE_AUDIT_EVENT";

export type TaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
/** Health band names, re-exported so rule authors have one vocabulary. */
export type HealthStatus = HealthBand;

export type AutomationRuleLike = {
  id: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  condition: string;
};

// ---------------------------------------------------------------------------
// Condition DSL
// ---------------------------------------------------------------------------

const CONDITION_FIELDS = ["status", "priority"] as const;
type ConditionField = (typeof CONDITION_FIELDS)[number];

const FIELD_MEMBERS: Record<ConditionField, readonly string[]> = {
  status: ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"],
  priority: ["LOW", "MEDIUM", "HIGH", "URGENT"],
};

export type ConditionClause =
  | { field: ConditionField; op: "=="; value: string }
  | { field: ConditionField; op: "!="; value: string }
  | { field: ConditionField; op: "in"; values: string[] };

export type ParsedCondition = {
  /** Blank/empty condition — always evaluates true. */
  alwaysTrue: boolean;
  clauses: ConditionClause[];
  /** Non-null when the condition string is malformed. */
  error: string | null;
};

export type ConditionContext = {
  priority: string;
  status: string;
};

function isConditionField(value: string): value is ConditionField {
  return (CONDITION_FIELDS as readonly string[]).includes(value);
}

/**
 * Parses the mini condition grammar. Supported (case-insensitive keywords/fields):
 *   status == DONE
 *   priority != LOW
 *   priority in (HIGH, URGENT)
 *   status == DONE and priority in (HIGH, URGENT)
 * Blank => alwaysTrue. Anything malformed => `error` set and no usable clauses.
 */
export function parseCondition(condition: string): ParsedCondition {
  const trimmed = condition.trim();

  if (!trimmed) {
    return { alwaysTrue: true, clauses: [], error: null };
  }

  const segments = trimmed.split(/\s+and\s+/i).map((part) => part.trim());
  const clauses: ConditionClause[] = [];

  for (const segment of segments) {
    if (!segment) {
      return { alwaysTrue: false, clauses: [], error: `Empty clause in "${condition}".` };
    }

    const inMatch = segment.match(/^(\w+)\s+in\s+\(([^)]*)\)$/i);
    if (inMatch) {
      const field = inMatch[1].toLowerCase();
      if (!isConditionField(field)) {
        return { alwaysTrue: false, clauses: [], error: `Unknown field "${inMatch[1]}".` };
      }

      const values = inMatch[2]
        .split(",")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => value.length > 0);

      if (values.length === 0) {
        return { alwaysTrue: false, clauses: [], error: `Empty value list for "${field}".` };
      }

      const invalid = values.find((value) => !FIELD_MEMBERS[field].includes(value));
      if (invalid) {
        return { alwaysTrue: false, clauses: [], error: `Invalid ${field} value "${invalid}".` };
      }

      clauses.push({ field, op: "in", values });
      continue;
    }

    const binaryMatch = segment.match(/^(\w+)\s*(==|!=)\s*(\S+)$/);
    if (binaryMatch) {
      const field = binaryMatch[1].toLowerCase();
      if (!isConditionField(field)) {
        return { alwaysTrue: false, clauses: [], error: `Unknown field "${binaryMatch[1]}".` };
      }

      const op = binaryMatch[2] as "==" | "!=";
      const value = binaryMatch[3].toUpperCase();

      if (!FIELD_MEMBERS[field].includes(value)) {
        return { alwaysTrue: false, clauses: [], error: `Invalid ${field} value "${value}".` };
      }

      clauses.push({ field, op, value });
      continue;
    }

    return { alwaysTrue: false, clauses: [], error: `Could not parse clause "${segment}".` };
  }

  return { alwaysTrue: false, clauses, error: null };
}

/**
 * Evaluates a parsed condition against a context. Clauses are joined by AND.
 * Malformed conditions evaluate to `false` (the caller can read `error` from the
 * parse result to record a reason).
 */
export function evaluateCondition(parsed: ParsedCondition, ctx: ConditionContext): boolean {
  if (parsed.error) {
    return false;
  }

  if (parsed.alwaysTrue) {
    return true;
  }

  return parsed.clauses.every((clause) => {
    const actual = (clause.field === "status" ? ctx.status : ctx.priority).toUpperCase();

    if (clause.op === "in") {
      return clause.values.includes(actual);
    }

    if (clause.op === "==") {
      return actual === clause.value;
    }

    return actual !== clause.value;
  });
}

// ---------------------------------------------------------------------------
// Trigger matching + action planning
// ---------------------------------------------------------------------------

export type EventTaskContext = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  milestoneId: string | null;
  dueDate: Date | null;
};

export type EventProjectContext = {
  id: string;
  name: string;
};

export type AutomationEvent =
  | {
      kind: "TASK_STATUS_CHANGED";
      task: EventTaskContext;
      fromStatus: TaskStatus;
      toStatus: TaskStatus;
    }
  | {
      kind: "TASK_OVERDUE";
      task: EventTaskContext;
      now: Date;
    }
  | {
      kind: "PROJECT_HEALTH_CHANGED";
      project: EventProjectContext;
      previousStatus: HealthStatus;
      newStatus: HealthStatus;
    };

export type PlannedAction =
  | {
      kind: "NOTIFY_MANAGER";
      type: string;
      title: string;
      body: string;
      href: string;
      priority: TaskPriority;
      dedupeKey: string;
    }
  | {
      kind: "UPDATE_MILESTONE_PROGRESS";
      milestoneId: string;
    }
  | {
      kind: "WRITE_AUDIT_EVENT";
      action: string;
      entityType: string;
      entityId: string;
      metadata: Record<string, unknown>;
    };

export type TriggerMatch = {
  /** True when the rule's trigger applies to this event/entity. */
  fires: boolean;
  dedupeKey: string;
  entityType: string;
  entityId: string;
  ctx: ConditionContext;
};

const EMPTY_MATCH: TriggerMatch = {
  fires: false,
  dedupeKey: "",
  entityType: "",
  entityId: "",
  ctx: { priority: "", status: "" },
};

function dueDateBucket(dueDate: Date | null): string {
  return dueDate ? dueDate.toISOString() : "none";
}

/**
 * Pure trigger matcher: does this rule fire for this event, and what is the
 * deterministic dedupe key that makes re-runs idempotent?
 */
export function matchTrigger(rule: AutomationRuleLike, event: AutomationEvent): TriggerMatch {
  if (rule.trigger !== event.kind) {
    return EMPTY_MATCH;
  }

  if (event.kind === "TASK_STATUS_CHANGED") {
    return {
      fires: event.fromStatus !== event.toStatus,
      dedupeKey: `task_status:${event.task.id}:${event.toStatus}`,
      entityType: "task",
      entityId: event.task.id,
      ctx: { priority: event.task.priority, status: event.toStatus },
    };
  }

  if (event.kind === "TASK_OVERDUE") {
    const overdue = Boolean(
      event.task.dueDate &&
        event.task.status !== "DONE" &&
        event.task.dueDate.getTime() < event.now.getTime(),
    );

    return {
      fires: overdue,
      dedupeKey: `task_overdue:${event.task.id}:${dueDateBucket(event.task.dueDate)}`,
      entityType: "task",
      entityId: event.task.id,
      ctx: { priority: event.task.priority, status: event.task.status },
    };
  }

  return {
    fires: event.previousStatus !== event.newStatus,
    dedupeKey: `project_health:${event.project.id}:${event.newStatus}`,
    entityType: "project",
    entityId: event.project.id,
    ctx: { priority: "", status: "" },
  };
}

/**
 * Pure action planner. Returns a typed description of the side effects the infra
 * layer should perform; performs no I/O itself.
 */
export function planActions(
  rule: AutomationRuleLike,
  event: AutomationEvent,
  match: TriggerMatch,
): PlannedAction[] {
  if (rule.action === "WRITE_AUDIT_EVENT") {
    return [
      {
        kind: "WRITE_AUDIT_EVENT",
        action: "automation.fired",
        entityType: match.entityType,
        entityId: match.entityId,
        metadata: {
          ruleId: rule.id,
          trigger: rule.trigger,
          dedupeKey: match.dedupeKey,
        },
      },
    ];
  }

  if (rule.action === "UPDATE_MILESTONE_PROGRESS") {
    const milestoneId =
      event.kind === "PROJECT_HEALTH_CHANGED" ? null : event.task.milestoneId;

    if (!milestoneId) {
      return [];
    }

    return [{ kind: "UPDATE_MILESTONE_PROGRESS", milestoneId }];
  }

  // NOTIFY_MANAGER
  if (event.kind === "TASK_STATUS_CHANGED") {
    return [
      {
        kind: "NOTIFY_MANAGER",
        type: "task.status_changed",
        title: "Task status changed",
        body: `"${event.task.title}" moved to ${event.toStatus.replace(/_/g, " ").toLowerCase()}.`,
        href: `/tasks/${event.task.id}`,
        priority: event.task.priority,
        dedupeKey: match.dedupeKey,
      },
    ];
  }

  if (event.kind === "TASK_OVERDUE") {
    return [
      {
        kind: "NOTIFY_MANAGER",
        type: "task.overdue",
        title: "Task overdue",
        body: `"${event.task.title}" is overdue and still open.`,
        href: `/tasks/${event.task.id}`,
        priority: event.task.priority,
        dedupeKey: match.dedupeKey,
      },
    ];
  }

  return [
    {
      kind: "NOTIFY_MANAGER",
      type: "project.health_changed",
      title: "Project health changed",
      body: `"${event.project.name}" health is now ${event.newStatus} (was ${event.previousStatus}).`,
      href: "/work-os",
      priority: "HIGH",
      dedupeKey: match.dedupeKey,
    },
  ];
}

export type AutomationPlan = {
  fires: boolean;
  dedupeKey: string;
  entityType: string;
  entityId: string;
  conditionError: string | null;
  conditionMet: boolean;
  actions: PlannedAction[];
};

/**
 * Convenience orchestrator combining matcher + condition + planning into one
 * pure result. The executor consumes this and decides how to persist the run.
 */
export function planAutomation(
  rule: AutomationRuleLike,
  event: AutomationEvent,
): AutomationPlan {
  const match = matchTrigger(rule, event);

  if (!match.fires) {
    return {
      fires: false,
      dedupeKey: match.dedupeKey,
      entityType: match.entityType,
      entityId: match.entityId,
      conditionError: null,
      conditionMet: false,
      actions: [],
    };
  }

  const parsed = parseCondition(rule.condition);
  const conditionMet = evaluateCondition(parsed, match.ctx);

  return {
    fires: true,
    dedupeKey: match.dedupeKey,
    entityType: match.entityType,
    entityId: match.entityId,
    conditionError: parsed.error,
    conditionMet,
    actions: conditionMet && !parsed.error ? planActions(rule, event, match) : [],
  };
}
