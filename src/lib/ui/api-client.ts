import type { ViewConfig, ViewType } from "@/lib/domain/view-engine";
import type { Role } from "@/lib/ui/permissions";

// The view engine is pure and framework-agnostic, so the client re-uses its
// types verbatim rather than mirroring a second, drift-prone copy.
export type {
  GroupBy,
  SortDirection,
  SortField,
  TaskFilter,
  ViewColumn,
  ViewConfig,
  ViewGroup,
  ViewTask,
  ViewType,
} from "@/lib/domain/view-engine";

export type ApiUser = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiOrganization = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiMembership = {
  id: string;
  organizationId: string;
  role: Role;
  status: string;
  createdAt: string;
  updatedAt: string;
  organization: ApiOrganization;
};

export type AuthMe = {
  activeOrganizationId: string | null;
  memberships: ApiMembership[];
  user: ApiUser;
};

export type Project = {
  id: string;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  status: "ACTIVE" | "COMPLETED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  _count?: { tasks: number };
  createdBy?: Pick<ApiUser, "id" | "name" | "email">;
};

export type TaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";

export type Subtask = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  assignedTo?: Pick<ApiUser, "id" | "name"> | null;
};

export type Task = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueDate: string | null;
  assignedToUserId?: string | null;
  milestoneId?: string | null;
  parentTaskId?: string | null;
  rating?: number | null;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  assignedTo?: Pick<ApiUser, "id" | "name" | "email"> | null;
  createdBy?: Pick<ApiUser, "id" | "name" | "email">;
  project?: { id: string; name: string };
  milestone?: { id: string; name: string } | null;
  parentTask?: { id: string; title: string; status: TaskStatus } | null;
  subtasks?: Subtask[];
  comments?: Array<{
    id: string;
    body: string;
    createdAt: string;
    author: Pick<ApiUser, "id" | "name" | "email">;
  }>;
};

export type DependencyType = "BLOCKS" | "DEPENDS_ON" | "RELATED_TO";

export type DependencyEndpoint = {
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  project: { id: string; name: string };
};

/**
 * A dependency edge. Tenant-scoped, so the two endpoints may sit in different
 * projects — `direction` says how the edge relates to the project being viewed:
 *
 *  - `internal`  — both endpoints inside it
 *  - `outbound`  — this project's task blocks work elsewhere
 *  - `inbound`   — work elsewhere blocks this project
 *
 * Inbound edges are the ones that used to be invisible, and they need a
 * different response from the viewer than outbound ones, which is why the two
 * are distinguished rather than both labelled "cross-project".
 */
export type Dependency = {
  id: string;
  type: DependencyType;
  createdAt: string;
  crossProject: boolean;
  direction: "internal" | "inbound" | "outbound";
  sourceTask: DependencyEndpoint;
  targetTask: DependencyEndpoint;
};

export type ActivityEvent = {
  id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
};

export type Milestone = {
  id: string;
  name: string;
  description: string | null;
  dueDate: string;
  status: "PLANNED" | "ON_TRACK" | "AT_RISK" | "MISSED" | "DONE";
  taskTotal: number;
  taskCompleted: number;
  completion: number;
};

export type SavedView = {
  id: string;
  name: string;
  viewType: ViewType;
  projectId: string | null;
  ownerUserId: string;
  isShared: boolean;
  config: ViewConfig;
  createdAt: string;
  updatedAt: string;
  owner?: { id: string; name: string } | null;
};

export type Member = {
  id: string;
  role: Role;
  status: string;
  createdAt: string;
  updatedAt: string;
  user: Pick<ApiUser, "id" | "name" | "email">;
};

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export type NotificationType =
  | "general"
  | "task.status_changed"
  | "task.overdue"
  | "project.health_changed";

export type AppNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string;
  priority: Priority;
  readAt: string | null;
  createdAt: string;
};

export type NotificationPreference = {
  inAppEnabled: boolean;
  emailEnabled: boolean;
  mutedTypes: string[];
};

export type AutomationTrigger =
  | "TASK_OVERDUE"
  | "TASK_STATUS_CHANGED"
  | "PROJECT_HEALTH_CHANGED";

export type AutomationAction =
  | "NOTIFY_MANAGER"
  | "UPDATE_MILESTONE_PROGRESS"
  | "WRITE_AUDIT_EVENT";

export type AutomationRule = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: AutomationTrigger;
  condition: string;
  action: AutomationAction;
  runsThisMonth: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * The original natural-language policy text that produced this rule via the
   * /automations/interpret endpoint. Null when the rule was created directly.
   */
  sourcePolicy: string | null;
};

export type AutomationRunStatus = "SUCCESS" | "FAILED" | "SKIPPED";

export type AutomationRun = {
  id: string;
  ruleId: string;
  dedupeKey: string;
  status: AutomationRunStatus;
  detail: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};

export type AutomationRunSummary = {
  evaluated: number;
  fired: number;
  skipped: number;
  failed: number;
};

// ─── What-If Simulation types — Feature 1 ────────────────────────────────────
//
// TypeScript equivalents of the Zod schemas in src/lib/validators.ts and the
// result types from src/lib/domain/simulation/engine.ts. Pure types — no Zod
// dependency — so they are safe to import from client components.

/** Discriminated union over all 8 supported simulation change types. */
export type SimulationChange =
  | {
      type: "task_status";
      taskId: string;
      status: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
    }
  | {
      type: "task_reassign";
      taskId: string;
      /** null → unassign */
      assignedToUserId: string | null;
    }
  | {
      type: "task_due_date";
      taskId: string;
      /** null → remove due date */
      dueDate: string | null;
    }
  | {
      type: "task_add";
      title: string;
      status: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
      priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
      dueDate?: string | null;
      assignedToUserId?: string | null;
      milestoneId?: string | null;
    }
  | { type: "task_remove"; taskId: string }
  | { type: "milestone_date"; milestoneId: string; dueDate: string }
  | {
      type: "dependency_add";
      sourceTaskId: string;
      targetTaskId: string;
      depType: "BLOCKS" | "DEPENDS_ON" | "RELATED_TO";
    }
  | { type: "dependency_remove"; dependencyId: string };

/** Project health band — matches HealthBand in src/lib/domain/project-intelligence.ts */
export type HealthBand = "Healthy" | "Watch" | "At risk" | "Critical";

/** Per-signal health contribution change between baseline and modified states. */
export type SignalChange = {
  name: string;
  before: number;
  after: number;
  /** Positive = improvement (fewer points deducted); negative = degradation. */
  delta: number;
};

export type SimulationSeverity = "none" | "low" | "medium" | "high" | "critical";
export type SimulationVerdict = "safe" | "watch" | "block";

/**
 * Full diff produced by the simulation engine.
 * Returned inside SimulateResult when status === "simulated".
 */
export type SimulationDiff = {
  baseline: { score: number; band: HealthBand };
  modified: { score: number; band: HealthBand };
  /** Positive = improvement; negative = degradation. */
  healthDelta: number;
  severity: SimulationSeverity;
  verdict: SimulationVerdict;
  bandChanged: boolean;
  affectedTaskCount: number;
  signalChanges: SignalChange[];
};

/**
 * Success response from POST /api/v1/intelligence/projects/:id/simulate.
 * status === "needs_clarification" means the AI needs more detail from the
 * user before it can map the scenario to a concrete change.
 */
/** One labelled parameter of the change, as the server described it. */
export type ChangeField = { label: string; value: string };

/**
 * The server's rendering of the structured change.
 *
 * Shown in the review panel so the user approves the validated payload rather
 * than only the AI's prose. It is descriptive: the mutation is determined by
 * `change`, which Apply re-validates independently.
 */
export type ChangeDescription = {
  action: string;
  fields: ChangeField[];
};

export type SimulateResult =
  | {
      status: "simulated";
      interpretedIntent: string;
      /**
       * The Zod-validated change the server simulated, including any schema
       * defaults it filled in. Send this object back to Apply so what is
       * applied is exactly what was reviewed.
       */
      change: SimulationChange;
      changeDescription: ChangeDescription;
      diff: SimulationDiff;
      narration: string;
      /**
       * Fingerprint of the state the diff was computed from — derived by the
       * server, never from anything the client supplied.
       */
      snapshotToken: string;
    }
  | {
      status: "needs_clarification";
      clarificationQuestion: string;
    };

/**
 * Success response from POST /api/v1/intelligence/projects/:id/apply.
 * On a 409 the server returns { error: "snapshot_stale", message, currentToken }.
 */
export type ApplyResult = {
  applied: true;
  changeType: string;
  newSnapshotToken: string;
};

// ─── Policy Interpretation types — Feature 2 ─────────────────────────────────
//
// TypeScript equivalents of the types in src/lib/domain/policy-conflict.ts and
// the response shape from src/app/api/v1/automations/interpret/route.ts.

/**
 * Conflict severity classification returned by the policy conflict detector.
 * Matches ConflictKind in src/lib/domain/policy-conflict.ts exactly.
 */
export type ConflictKind =
  | "CONFIRMED_DUPLICATE"     // same trigger, action, and condition — redundant rule
  | "CONFIRMED_UNCONDITIONAL" // same trigger and action, both always fire
  | "POSSIBLE_OVERLAP";       // same trigger and action, conditions intersect on some inputs

/** A single conflict warning returned by the /automations/interpret endpoint. */
export type PolicyConflict = {
  kind: ConflictKind;
  conflictingRuleId: string;
  message: string;
};

/**
 * The structured draft rule extracted from the manager's natural-language policy.
 * Matches the `draft` field in the /automations/interpret response.
 */
export type PolicyDraft = {
  name: string;
  trigger: AutomationTrigger;
  condition: string;
  action: AutomationAction;
};

/**
 * Full success response from POST /api/v1/automations/interpret.
 * On 422 the server returns { error: "unsupported", message }.
 * On 501 the server returns { error: "ai_not_configured", message } — the same
 * shape the simulate route uses, meaning AI is switched off for this
 * deployment rather than failing, so retrying will not help.
 * On 502 the server returns { error: "ai_error", message } — a genuine
 * upstream failure, which may succeed on retry.
 */
export type InterpretResult = {
  draft: PolicyDraft;
  conflicts: PolicyConflict[];
  /** Echo of the original NL policy — pass as sourcePolicy when saving. */
  sourcePolicy: string;
};

type ApiErrorBody = {
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class ClientApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /**
     * Structured payload from the server, when the error carries one.
     *
     * Used by the auth screens to render every password problem at once, and to
     * read `retryAfterSeconds` off a 423 lockout, instead of showing only the
     * first sentence the API happened to put in `message`.
     */
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(
  path: string,
  options: Omit<RequestInit, "body"> & { body?: BodyInit | object | null } = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body;

  if (body && typeof body === "object" && !(body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  const response = await fetch(path, {
    ...options,
    body: body as BodyInit | null | undefined,
    credentials: "include",
    headers,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const data = (await response.json().catch(() => ({}))) as ApiErrorBody | T;

  if (!response.ok) {
    const error = data as ApiErrorBody;

    throw new ClientApiError(
      response.status,
      error.error?.code ?? "request_failed",
      error.error?.message ?? "Request failed.",
      error.error?.details,
    );
  }

  return data as T;
}

export function formatStatus(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

export function activeMembership(auth: AuthMe | null) {
  if (!auth?.activeOrganizationId) {
    return null;
  }

  return (
    auth.memberships.find(
      (membership) => membership.organizationId === auth.activeOrganizationId,
    ) ?? null
  );
}
