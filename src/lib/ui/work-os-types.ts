/**
 * Response shapes for `GET /api/v1/work-os/overview`.
 *
 * Kept beside the other UI types rather than inside the page, so the page file
 * is markup and the contract with the route is stated in one place. These
 * deliberately describe *that endpoint's* projection — it returns health as the
 * legacy view and milestones with a `progress` block, which is narrower than
 * the shared `Milestone` in `api-client.ts`, so they are not interchangeable.
 */

export type HealthProject = {
  id: string;
  name: string;
  status: string;
  _count: { tasks: number };
  health: {
    blockedTasks: number;
    completion: number;
    milestoneRisk: number;
    overdueTasks: number;
    reasons: string[];
    score: number;
    status: "Healthy" | "Watch" | "At risk" | "Critical";
  };
};

export type Milestone = {
  id: string;
  name: string;
  dueDate: string;
  status: string;
  project: { id: string; name: string };
  progress: { completedTasks: number; completion: number; totalTasks: number };
};

export type DependencyEndpoint = {
  id: string;
  title: string;
  status: string;
  projectId: string;
  project: { id: string; name: string };
};

export type Dependency = {
  id: string;
  type: string;
  downstreamImpact: number;
  /** True when the two endpoints live in different projects. */
  crossProject: boolean;
  // The edge itself no longer has a project — each endpoint carries its own,
  // which is what makes a boundary crossing visible.
  sourceTask: DependencyEndpoint;
  targetTask: DependencyEndpoint;
};

export type MemberWorkload = {
  role: string;
  user: { id: string; name: string; email: string };
  workload: {
    activeTasks: number;
    blockedTasks: number;
    overdueTasks: number;
    urgentTasks: number;
  };
};

export type NotificationItem = {
  id: string;
  title: string;
  body: string;
  priority: string;
  readAt: string | null;
  createdAt: string;
};

export type AutomationRule = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: string;
  condition: string;
  action: string;
  runsThisMonth: number;
  lastRunAt: string | null;
};

export type ActivityLog = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  actor: { id: string; name: string; email: string };
};

export type Overview = {
  activityLogs: ActivityLog[];
  automationRules: AutomationRule[];
  dependencies: Dependency[];
  health: HealthProject[];
  members: MemberWorkload[];
  milestones: Milestone[];
  notifications: NotificationItem[];
};

export function healthColor(status: HealthProject["health"]["status"]) {
  return {
    "At risk": "border-amber-300/30 bg-amber-300/10 text-amber-100",
    Critical: "border-red-300/30 bg-red-400/10 text-red-100",
    Healthy: "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
    Watch: "border-blue-300/30 bg-blue-300/10 text-blue-100",
  }[status];
}

export function shortDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Not run";
}
