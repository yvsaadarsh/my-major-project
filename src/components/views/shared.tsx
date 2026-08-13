"use client";

import type {
  ViewConfig,
  ViewGroup,
  ViewTask,
  ViewTaskPriority,
  ViewTaskStatus,
} from "@/lib/domain/view-engine";
import { isTaskOverdue, priorityLabel, statusLabel } from "@/lib/domain/view-engine";
import type { Member, Milestone } from "@/lib/ui/api-client";

/**
 * Every view renders from the same props so they stay swappable: the flat
 * filtered+sorted task list, the grouped projection of it, the active config and
 * the lookup data the cells need.
 */
export type ViewProps = {
  config: ViewConfig;
  groups: ViewGroup[];
  members: Member[];
  milestones: Milestone[];
  onConfigChange: (config: ViewConfig) => void;
  tasks: ViewTask[];
};

const statusStyles: Record<ViewTaskStatus, string> = {
  TODO: "border-white/10 bg-white/[0.06] text-slate-300",
  IN_PROGRESS: "border-teal-300/30 bg-teal-300/10 text-teal-100",
  BLOCKED: "border-rose-300/25 bg-rose-300/10 text-rose-100",
  DONE: "border-emerald-300/25 bg-emerald-300/10 text-emerald-100",
};

const priorityStyles: Record<ViewTaskPriority, string> = {
  URGENT: "border-rose-300/30 bg-rose-300/10 text-rose-100",
  HIGH: "border-amber-300/25 bg-amber-300/10 text-amber-100",
  MEDIUM: "border-white/10 bg-white/[0.06] text-slate-300",
  LOW: "border-white/10 bg-white/[0.04] text-slate-400",
};

const pillBase =
  "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold";

export function StatusPill({ status }: { status: ViewTaskStatus }) {
  return <span className={`${pillBase} ${statusStyles[status]}`}>{statusLabel(status)}</span>;
}

export function PriorityPill({ priority }: { priority: ViewTaskPriority }) {
  return (
    <span className={`${pillBase} ${priorityStyles[priority]}`}>{priorityLabel(priority)}</span>
  );
}

export function formatViewDate(value: unknown) {
  if (!value || (typeof value !== "string" && !(value instanceof Date))) {
    return "No due date";
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? "No due date" : date.toLocaleDateString();
}

export function DueDate({ task }: { task: ViewTask }) {
  const overdue = isTaskOverdue(task);

  return (
    <span className={overdue ? "font-semibold text-rose-200" : "text-slate-400"}>
      {formatViewDate(task.dueDate)}
      {overdue && <span className="sr-only"> (overdue)</span>}
    </span>
  );
}

export function CountBadge({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-white/8 px-2 py-1 text-xs text-slate-400">{count}</span>
  );
}

export function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</h3>
      <CountBadge count={count} />
    </div>
  );
}

export function milestoneNameOf(task: ViewTask, milestones: Milestone[]) {
  if (!task.milestoneId) {
    return "No milestone";
  }

  return milestones.find((milestone) => milestone.id === task.milestoneId)?.name ?? "No milestone";
}

export function assigneeNameFor(task: ViewTask, members: Member[]) {
  if (task.assignedTo?.name) {
    return task.assignedTo.name;
  }

  if (!task.assignedToUserId) {
    return "Unassigned";
  }

  return (
    members.find((member) => member.user.id === task.assignedToUserId)?.user.name ?? "Unassigned"
  );
}
