"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  BotOff,
  CalendarClock,
  GitBranch,
  Gauge,
  LockKeyhole,
  Plus,
  RefreshCw,
  Route,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import { AppShell, RoleNotice } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import { apiRequest, formatStatus } from "@/lib/ui/api-client";
import { can } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";

type HealthProject = {
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

type Milestone = {
  id: string;
  name: string;
  dueDate: string;
  status: string;
  project: { id: string; name: string };
  progress: { completedTasks: number; completion: number; totalTasks: number };
};

type DependencyEndpoint = {
  id: string;
  title: string;
  status: string;
  projectId: string;
  project: { id: string; name: string };
};

type Dependency = {
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

type MemberWorkload = {
  role: string;
  user: { id: string; name: string; email: string };
  workload: {
    activeTasks: number;
    blockedTasks: number;
    overdueTasks: number;
    urgentTasks: number;
  };
};

type NotificationItem = {
  id: string;
  title: string;
  body: string;
  priority: string;
  readAt: string | null;
  createdAt: string;
};

type AutomationRule = {
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

type ActivityLog = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  actor: { id: string; name: string; email: string };
};

type Overview = {
  activityLogs: ActivityLog[];
  automationRules: AutomationRule[];
  dependencies: Dependency[];
  health: HealthProject[];
  members: MemberWorkload[];
  milestones: Milestone[];
  notifications: NotificationItem[];
};

const triggerOptions = [
  ["TASK_OVERDUE", "Task overdue"],
  ["TASK_STATUS_CHANGED", "Task status changed"],
  ["PROJECT_HEALTH_CHANGED", "Project health changed"],
];

const actionOptions = [
  ["NOTIFY_MANAGER", "Notify manager"],
  ["UPDATE_MILESTONE_PROGRESS", "Update milestone"],
  ["WRITE_AUDIT_EVENT", "Write audit event"],
];

function healthColor(status: HealthProject["health"]["status"]) {
  return {
    "At risk": "border-amber-300/30 bg-amber-300/10 text-amber-100",
    Critical: "border-red-300/30 bg-red-400/10 text-red-100",
    Healthy: "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
    Watch: "border-blue-300/30 bg-blue-300/10 text-blue-100",
  }[status];
}

function shortDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString() : "Not run";
}

export default function WorkOsPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automationName, setAutomationName] = useState("");
  const [automationCondition, setAutomationCondition] = useState("Open task due date is before today");
  const [automationTrigger, setAutomationTrigger] = useState("TASK_OVERDUE");
  const [automationAction, setAutomationAction] = useState("NOTIFY_MANAGER");

  const topHealth = useMemo(
    () => overview?.health.slice().sort((a, b) => a.health.score - b.health.score) ?? [],
    [overview],
  );

  async function loadOverview() {
    setError(null);
    setLoading(true);

    try {
      const response = await apiRequest<Overview>("/api/v1/work-os/overview");
      setOverview(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Work OS.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (organization) {
      void loadOverview();
    }
  }, [organization]);

  async function createAutomation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!can(role, "automations:manage") || !automationName.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest("/api/v1/automations", {
        body: {
          action: automationAction,
          condition: automationCondition,
          description: "Created from the Work OS automation console.",
          enabled: true,
          name: automationName,
          trigger: automationTrigger,
        },
        method: "POST",
      });
      setAutomationName("");
      await loadOverview();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create automation.");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  type MetricTuple = [string, number, typeof Gauge];
  const metricCards: MetricTuple[] = [
    ["Projects monitored", overview?.health.length ?? 0, Gauge],
    ["Milestones", overview?.milestones.length ?? 0, CalendarClock],
    ["Dependencies", overview?.dependencies.length ?? 0, GitBranch],
    ["Unread notices", overview?.notifications?.filter((n) => !n.readAt).length ?? 0, Bell],
  ];

  return (
    <AppShell
      eyebrow="Work graph"
      organizationName={organization?.name}
      role={role}
      title="Plan, risk, access, and operations in one tenant-safe control room."
      description="Northstar connects projects, milestones, tasks, dependencies, notifications, automations, and audit history without adding any AI layer."
    >
      {error && <InlineError message={error} />}

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-2 rounded-2xl border border-teal-300/20 bg-teal-300/10 px-4 py-3 text-sm font-medium text-teal-100">
            <ShieldCheck size={17} />
            Server-enforced tenant scope
          </span>
          <span className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-slate-300">
            <BotOff size={17} />
            Deterministic, non-AI analytics
          </span>
        </div>
        <button
          className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white transition-all hover:bg-white/[0.1]"
          onClick={() => void loadOverview()}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {loading ? (
        <LoadingState label="Loading tenant work graph..." />
      ) : (
        <div className="grid gap-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {metricCards.map(([label, value, MetricIcon]) => (
              <SectionCard key={label} className="min-h-36">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-400">{label}</p>
                  <MetricIcon className="text-teal-300" size={20} />
                </div>
                <p className="mt-5 text-4xl font-semibold text-white">{value}</p>
              </SectionCard>
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
            <SectionCard>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-white">Project health</h2>
                  <p className="mt-1 text-sm text-slate-400">
                    Transparent scoring from overdue work, blockers, milestones, and deadlines.
                  </p>
                </div>
                <Gauge className="text-teal-300" size={24} />
              </div>

              <div className="mt-6 space-y-4">
                {topHealth.length ? (
                  topHealth.map((project) => (
                    <div
                      className="rounded-3xl border border-white/10 bg-white/[0.035] p-4"
                      key={project.id}
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="text-base font-semibold text-white">{project.name}</p>
                          <p className="mt-1 text-sm text-slate-400">
                            {formatStatus(project.status)} / {project._count.tasks} tasks / {project.health.completion}% complete
                          </p>
                        </div>
                        <span className={`rounded-2xl border px-3 py-2 text-sm font-semibold ${healthColor(project.health.status)}`}>
                          {project.health.status} {project.health.score}
                        </span>
                      </div>
                      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-teal-300"
                          style={{ width: `${project.health.completion}%` }}
                        />
                      </div>
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        {project.health.reasons.map((reason) => (
                          <p
                            className="rounded-2xl bg-white/[0.04] px-3 py-2 text-xs leading-5 text-slate-300"
                            key={reason}
                          >
                            {reason}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <EmptyState title="No projects to monitor" description="Create a project to start health tracking." />
                )}
              </div>
            </SectionCard>

            <SectionCard>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-white">Automation rules</h2>
                  <p className="mt-1 text-sm text-slate-400">Deterministic triggers, conditions, actions, and audit logs.</p>
                </div>
                <Workflow className="text-teal-300" size={24} />
              </div>

              <form className="mt-5 space-y-3" onSubmit={createAutomation}>
                <input
                  className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                  disabled={!can(role, "automations:manage")}
                  onChange={(event) => setAutomationName(event.target.value)}
                  placeholder="Rule name"
                  value={automationName}
                />
                <select
                  className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                  disabled={!can(role, "automations:manage")}
                  onChange={(event) => setAutomationTrigger(event.target.value)}
                  value={automationTrigger}
                >
                  {triggerOptions.map(([value, label]) => (
                    <option className="bg-slate-950 text-white" key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                  disabled={!can(role, "automations:manage")}
                  onChange={(event) => setAutomationCondition(event.target.value)}
                  placeholder="Condition"
                  value={automationCondition}
                />
                <select
                  className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                  disabled={!can(role, "automations:manage")}
                  onChange={(event) => setAutomationAction(event.target.value)}
                  value={automationAction}
                >
                  {actionOptions.map(([value, label]) => (
                    <option className="bg-slate-950 text-white" key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <PermissionAction permission="automations:manage" role={role} type="submit">
                  <Plus size={16} />
                  {saving ? "Saving..." : "Create rule"}
                </PermissionAction>
              </form>

              {!can(role, "automations:manage") && (
                <div className="mt-4">
                  <RoleNotice text="Automation management is available to admins and managers." />
                </div>
              )}

              <div className="mt-5 space-y-3">
                {overview?.automationRules.length ? (
                  overview.automationRules.map((rule) => (
                    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4" key={rule.id}>
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-semibold text-white">{rule.name}</p>
                        <span className={`rounded-full px-2 py-1 text-xs ${rule.enabled ? "bg-emerald-300/10 text-emerald-200" : "bg-white/10 text-slate-400"}`}>
                          {rule.enabled ? "Enabled" : "Paused"}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-400">{formatStatus(rule.trigger)} then {formatStatus(rule.action)}</p>
                      <p className="mt-2 text-xs text-slate-500">{rule.runsThisMonth} runs this month / last {shortDate(rule.lastRunAt)}</p>
                    </div>
                  ))
                ) : (
                  <EmptyState title="No automation rules" description="Create deterministic rules for overdue work, health changes, and milestone updates." />
                )}
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <SectionCard>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                <CalendarClock className="text-teal-300" size={20} />
                Milestones
              </h2>
              <div className="mt-5 space-y-3">
                {overview?.milestones.length ? (
                  overview.milestones.slice(0, 6).map((milestone) => (
                    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4" key={milestone.id}>
                      <p className="text-sm font-semibold text-white">{milestone.name}</p>
                      <p className="mt-1 text-xs text-slate-500">{milestone.project.name} / due {shortDate(milestone.dueDate)}</p>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-blue-300" style={{ width: `${milestone.progress.completion}%` }} />
                      </div>
                      <p className="mt-2 text-xs text-slate-400">{milestone.progress.completedTasks}/{milestone.progress.totalTasks} tasks complete</p>
                    </div>
                  ))
                ) : (
                  <EmptyState title="No milestones" description="Milestones create meaningful planning checkpoints across project tasks." />
                )}
              </div>
            </SectionCard>

            <SectionCard>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                <Route className="text-teal-300" size={20} />
                Dependencies
              </h2>
              <div className="mt-5 space-y-3">
                {overview?.dependencies.length ? (
                  overview.dependencies.slice(0, 6).map((dependency) => (
                    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4" key={dependency.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">{formatStatus(dependency.type)}</p>
                        {dependency.crossProject && (
                          <span
                            className="rounded-full border border-violet-300/30 bg-violet-300/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-violet-200"
                            title={`${dependency.sourceTask.project.name} → ${dependency.targetTask.project.name}`}
                          >
                            Cross-project
                          </span>
                        )}
                      </div>
                      <p className="mt-2 text-sm font-semibold text-white">{dependency.sourceTask.title}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        Impacts {dependency.targetTask.title}
                        {dependency.crossProject && (
                          <span className="text-violet-200"> in {dependency.targetTask.project.name}</span>
                        )}
                      </p>
                      <p className="mt-3 text-xs text-amber-200">{dependency.downstreamImpact} downstream task{dependency.downstreamImpact === 1 ? "" : "s"}</p>
                    </div>
                  ))
                ) : (
                  <EmptyState title="No dependency graph" description="Connect blocking work to expose bottlenecks and downstream impact." />
                )}
              </div>
            </SectionCard>

            <SectionCard>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                <Bell className="text-teal-300" size={20} />
                Notifications
              </h2>
              <div className="mt-5 space-y-3">
                {overview?.notifications.length ? (
                  overview.notifications.map((item) => (
                    <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4" key={item.id}>
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-semibold text-white">{item.title}</p>
                        {!item.readAt && <span className="h-2 w-2 rounded-full bg-teal-300" />}
                      </div>
                      <p className="mt-2 text-xs leading-5 text-slate-400">{item.body}</p>
                    </div>
                  ))
                ) : (
                  <EmptyState title="No notifications" description="In-app notifications are tenant-scoped and recipient-specific." />
                )}
              </div>
            </SectionCard>
          </div>

          <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
            <SectionCard>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                <LockKeyhole className="text-teal-300" size={20} />
                Workload
              </h2>
              <div className="mt-5 space-y-3">
                {overview?.members.map((member) => (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4" key={member.user.id}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white">{member.user.name}</p>
                        <p className="mt-1 text-xs text-slate-500">{formatStatus(member.role)}</p>
                      </div>
                      <p className="text-2xl font-semibold text-white">{member.workload.activeTasks}</p>
                    </div>
                    <p className="mt-3 text-xs text-slate-400">
                      {member.workload.urgentTasks} urgent / {member.workload.blockedTasks} blocked / {member.workload.overdueTasks} overdue
                    </p>
                  </div>
                ))}
              </div>
            </SectionCard>

            <SectionCard>
              <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
                <Activity className="text-teal-300" size={20} />
                Audit history
              </h2>
              {can(role, "audit:read") ? (
                <div className="mt-5 space-y-3">
                  {overview?.activityLogs.length ? (
                    overview.activityLogs.map((event) => (
                      <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4" key={event.id}>
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                          <p className="text-sm font-semibold text-white">{event.action}</p>
                          <p className="text-xs text-slate-500">{shortDate(event.createdAt)}</p>
                        </div>
                        <p className="mt-2 text-xs text-slate-400">
                          {event.actor.name} changed {event.entityType} {event.entityId}
                        </p>
                      </div>
                    ))
                  ) : (
                    <EmptyState title="No audit events yet" description="Important mutations will appear here with actor, resource, and metadata." />
                  )}
                </div>
              ) : (
                <div className="mt-5">
                  <RoleNotice text="Audit history is visible to organization admins." />
                </div>
              )}
            </SectionCard>
          </div>
        </div>
      )}
    </AppShell>
  );
}
