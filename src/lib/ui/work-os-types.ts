/**
 * Response shapes for `GET /api/v1/work-os/overview`.
 *
 * Kept beside the other UI types rather than inside the page, so the page file
 * is markup and the contract with the route is stated in one place. These
 * deliberately describe *that endpoint's* projection — it returns milestones
 * with a `progress` block and dependencies with `downstreamImpact`, neither of
 * which matches the shared shapes in `api-client.ts`. Where a shape *does*
 * match, the shared type is reused rather than copied.
 */

// `DependencyEndpoint` is imported (not just re-exported) because `Dependency`
// below references it: `export … from` forwards a name without binding it in
// this module's scope.
import type {
  AutomationRule as SharedAutomationRule,
  DependencyEndpoint,
} from "@/lib/ui/api-client";
import type { ApiProjectIntelligence, Band } from "@/lib/ui/intelligence-types";

export type HealthProject = {
  id: string;
  name: string;
  status: string;
  _count: { tasks: number };
  /** The full analysis. Band, score, ranked factors and confidence all live here. */
  intelligence: ApiProjectIntelligence;
};

export type Milestone = {
  id: string;
  name: string;
  dueDate: string;
  status: string;
  project: { id: string; name: string };
  progress: { completedTasks: number; completion: number; totalTasks: number };
};

/**
 * Re-exported rather than redeclared: the overview route selects exactly the
 * endpoint shape `api-client.ts` already describes, and the local copy that
 * used to live here had weakened `status` from `TaskStatus` to `string`.
 */
export type { DependencyEndpoint };

/**
 * The overview route's projection of an automation rule.
 *
 * Derived from the shared type minus the two timestamps its `select` omits, so
 * the union on `trigger`/`action` is preserved and the response cannot claim
 * fields it never sends.
 */
export type AutomationRule = Omit<SharedAutomationRule, "createdAt" | "updatedAt">;

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

export function healthColor(band: Band) {
  return {
    "At risk": "border-amber-300/30 bg-amber-300/10 text-amber-100",
    Critical: "border-red-300/30 bg-red-400/10 text-red-100",
    Healthy: "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
    Watch: "border-blue-300/30 bg-blue-300/10 text-blue-100",
  }[band];
}

export function shortDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Not run";
}
