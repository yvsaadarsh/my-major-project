"use client";

import { Activity, Bell, CalendarClock, LockKeyhole, Route } from "lucide-react";

import { RoleNotice } from "@/components/app-shell";
import { EmptyState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { formatStatus } from "@/lib/ui/api-client";
import { can, type Role } from "@/lib/ui/permissions";
import {
  shortDate,
  type ActivityLog,
  type Dependency,
  type MemberWorkload,
  type Milestone,
  type NotificationItem,
} from "@/lib/ui/work-os-types";

/** The six highest-priority milestones across the tenant. */
export function MilestonesPanel({ milestones }: { milestones: Milestone[] | undefined }) {
  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <CalendarClock className="text-teal-300" size={20} />
        Milestones
      </h2>
      <div className="mt-5 space-y-3">
        {milestones?.length ? (
          milestones.slice(0, 6).map((milestone) => (
            <div
              className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"
              key={milestone.id}
            >
              <p className="text-sm font-semibold text-white">{milestone.name}</p>
              <p className="mt-1 text-xs text-slate-500">
                {milestone.project.name} / due {shortDate(milestone.dueDate)}
              </p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-blue-300"
                  style={{ width: `${milestone.progress.completion}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-slate-400">
                {milestone.progress.completedTasks}/{milestone.progress.totalTasks} tasks complete
              </p>
            </div>
          ))
        ) : (
          <EmptyState
            title="No milestones"
            description="Milestones create meaningful planning checkpoints across project tasks."
          />
        )}
      </div>
    </SectionCard>
  );
}

export function DependenciesPanel({
  dependencies,
}: {
  dependencies: Dependency[] | undefined;
}) {
  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Route className="text-teal-300" size={20} />
        Dependencies
      </h2>
      <div className="mt-5 space-y-3">
        {dependencies?.length ? (
          dependencies.slice(0, 6).map((dependency) => (
            <div
              className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"
              key={dependency.id}
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {formatStatus(dependency.type)}
                </p>
                {dependency.crossProject && (
                  <span
                    className="rounded-full border border-violet-300/30 bg-violet-300/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-violet-200"
                    title={`${dependency.sourceTask.project.name} → ${dependency.targetTask.project.name}`}
                  >
                    Cross-project
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm font-semibold text-white">
                {dependency.sourceTask.title}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Impacts {dependency.targetTask.title}
                {dependency.crossProject && (
                  <span className="text-violet-200">
                    {" "}
                    in {dependency.targetTask.project.name}
                  </span>
                )}
              </p>
              <p className="mt-3 text-xs text-amber-200">
                {dependency.downstreamImpact} downstream task
                {dependency.downstreamImpact === 1 ? "" : "s"}
              </p>
            </div>
          ))
        ) : (
          <EmptyState
            title="No dependency graph"
            description="Connect blocking work to expose bottlenecks and downstream impact."
          />
        )}
      </div>
    </SectionCard>
  );
}

export function NotificationsPanel({
  notifications,
}: {
  notifications: NotificationItem[] | undefined;
}) {
  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Bell className="text-teal-300" size={20} />
        Notifications
      </h2>
      <div className="mt-5 space-y-3">
        {notifications?.length ? (
          notifications.map((item) => (
            <div
              className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"
              key={item.id}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-white">{item.title}</p>
                {!item.readAt && <span className="h-2 w-2 rounded-full bg-teal-300" />}
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">{item.body}</p>
            </div>
          ))
        ) : (
          <EmptyState
            title="No notifications"
            description="In-app notifications are tenant-scoped and recipient-specific."
          />
        )}
      </div>
    </SectionCard>
  );
}

export function WorkloadPanel({ members }: { members: MemberWorkload[] | undefined }) {
  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <LockKeyhole className="text-teal-300" size={20} />
        Workload
      </h2>
      <div className="mt-5 space-y-3">
        {members?.map((member) => (
          <div
            className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"
            key={member.user.id}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-white">{member.user.name}</p>
                <p className="mt-1 text-xs text-slate-500">{formatStatus(member.role)}</p>
              </div>
              <p className="text-2xl font-semibold text-white">{member.workload.activeTasks}</p>
            </div>
            <p className="mt-3 text-xs text-slate-400">
              {member.workload.urgentTasks} urgent / {member.workload.blockedTasks} blocked /{" "}
              {member.workload.overdueTasks} overdue
            </p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

/**
 * Audit history, gated on `audit:read`. The UI hiding it is a convenience —
 * the route is the boundary that actually withholds the rows.
 */
export function AuditHistoryPanel({
  role,
  activityLogs,
}: {
  role: Role;
  activityLogs: ActivityLog[] | undefined;
}) {
  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Activity className="text-teal-300" size={20} />
        Audit history
      </h2>
      {can(role, "audit:read") ? (
        <div className="mt-5 space-y-3">
          {activityLogs?.length ? (
            activityLogs.map((event) => (
              <div
                className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"
                key={event.id}
              >
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
            <EmptyState
              title="No audit events yet"
              description="Important mutations will appear here with actor, resource, and metadata."
            />
          )}
        </div>
      ) : (
        <div className="mt-5">
          <RoleNotice text="Audit history is visible to organization admins." />
        </div>
      )}
    </SectionCard>
  );
}
