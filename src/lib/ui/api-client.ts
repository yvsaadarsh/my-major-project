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
