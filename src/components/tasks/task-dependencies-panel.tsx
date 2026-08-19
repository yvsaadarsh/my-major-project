"use client";

import { FormEvent } from "react";
import Link from "next/link";
import { GitBranch, Plus } from "lucide-react";

import { InlineError } from "@/components/page-state";
import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import { formatStatus, type Dependency, type Task } from "@/lib/ui/api-client";
import { can, type Role } from "@/lib/ui/permissions";

/**
 * The dependency edges touching this task, split by direction, plus the form
 * for adding a new outbound one.
 *
 * `blocking` / `blockedBy` / `dependencyOptions` are derived here rather than
 * passed in: they are a pure function of the dependency list and this task's
 * id, and computing them beside the markup that renders them keeps the two
 * from drifting.
 */
export function TaskDependenciesPanel({
  role,
  taskId,
  dependencies,
  siblingTasks,
  dependencyTargetId,
  dependencyError,
  onDependencyTargetChange,
  onAddDependency,
}: {
  role: Role;
  taskId: string | undefined;
  dependencies: Dependency[];
  siblingTasks: Task[];
  dependencyTargetId: string;
  dependencyError: string | null;
  onDependencyTargetChange: (value: string) => void;
  onAddDependency: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const blocking = dependencies.filter((dependency) => dependency.sourceTask.id === taskId);
  const blockedBy = dependencies.filter((dependency) => dependency.targetTask.id === taskId);
  const existingTargetIds = new Set(blocking.map((dependency) => dependency.targetTask.id));
  const dependencyOptions = siblingTasks.filter((item) => !existingTargetIds.has(item.id));

  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
        <GitBranch className="text-teal-300" size={18} />
        Dependencies
      </h2>

      {dependencyError && (
        <div className="mt-4">
          <InlineError message={dependencyError} />
        </div>
      )}

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            This task blocks
          </p>
          <div className="mt-3 space-y-2">
            {blocking.length ? (
              blocking.map((dependency) => (
                <Link
                  key={dependency.id}
                  href={`/tasks/${dependency.targetTask.id}`}
                  className="block rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-sm text-slate-200 transition-all hover:border-teal-300/30"
                >
                  <span className="text-[11px] font-semibold text-amber-200">
                    {formatStatus(dependency.type)}
                  </span>{" "}
                  {dependency.targetTask.title}
                </Link>
              ))
            ) : (
              <p className="text-sm text-slate-500">Nothing downstream.</p>
            )}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
            Blocked by
          </p>
          <div className="mt-3 space-y-2">
            {blockedBy.length ? (
              blockedBy.map((dependency) => (
                <Link
                  key={dependency.id}
                  href={`/tasks/${dependency.sourceTask.id}`}
                  className="block rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-sm text-slate-200 transition-all hover:border-teal-300/30"
                >
                  <span className="text-[11px] font-semibold text-rose-200">
                    {formatStatus(dependency.type)}
                  </span>{" "}
                  {dependency.sourceTask.title}
                </Link>
              ))
            ) : (
              <p className="text-sm text-slate-500">Nothing upstream.</p>
            )}
          </div>
        </div>
      </div>

      {can(role, "tasks:update") && (
        <form onSubmit={onAddDependency} className="mt-5 flex flex-col gap-3 sm:flex-row">
          <select
            value={dependencyTargetId}
            onChange={(event) => onDependencyTargetChange(event.target.value)}
            disabled={dependencyOptions.length === 0}
            className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
          >
            <option className="bg-slate-950 text-white" value="">
              Add a task this one blocks...
            </option>
            {dependencyOptions.map((option) => (
              <option className="bg-slate-950 text-white" key={option.id} value={option.id}>
                {option.title}
              </option>
            ))}
          </select>
          <PermissionAction
            role={role}
            permission="tasks:update"
            type="submit"
            variant="secondary"
          >
            <Plus size={16} />
            Link
          </PermissionAction>
        </form>
      )}
    </SectionCard>
  );
}
