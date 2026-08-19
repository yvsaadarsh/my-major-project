"use client";

import { FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, ListTree, Plus } from "lucide-react";

import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import { formatStatus, type Subtask } from "@/lib/ui/api-client";
import { can, type Role } from "@/lib/ui/permissions";

export function SubtasksPanel({
  role,
  subtasks,
  subtaskTitle,
  saving,
  onSubtaskTitleChange,
  onCreateSubtask,
  onCompleteSubtask,
}: {
  role: Role;
  subtasks: Subtask[];
  subtaskTitle: string;
  saving: boolean;
  onSubtaskTitleChange: (value: string) => void;
  onCreateSubtask: (event: FormEvent<HTMLFormElement>) => void;
  onCompleteSubtask: (subtaskId: string) => void;
}) {
  const subtaskTotal = subtasks.length;
  const subtaskCompleted = subtasks.filter((item) => item.status === "DONE").length;
  const subtaskCompletion = subtaskTotal
    ? Math.round((subtaskCompleted / subtaskTotal) * 100)
    : 0;

  return (
    <SectionCard>
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
          <ListTree className="text-teal-300" size={18} />
          Subtasks
        </h2>
        <span className="text-xs font-semibold text-slate-400">
          {subtaskCompleted}/{subtaskTotal} done
        </span>
      </div>

      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className="h-full rounded-full bg-teal-300 transition-all"
          style={{ width: `${subtaskCompletion}%` }}
        />
      </div>

      <div className="mt-5 space-y-3">
        {subtasks.length ? (
          subtasks.map((subtask) => (
            <div
              key={subtask.id}
              className="flex items-center justify-between gap-3 rounded-3xl border border-white/10 bg-white/[0.035] p-4"
            >
              <Link href={`/tasks/${subtask.id}`} className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-white">{subtask.title}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {formatStatus(subtask.status)} · {subtask.assignedTo?.name ?? "Unassigned"}
                </p>
              </Link>
              {subtask.status === "DONE" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-teal-300/10 px-3 py-1 text-xs font-semibold text-teal-200">
                  <CheckCircle2 size={13} />
                  Done
                </span>
              ) : (
                can(role, "tasks:update") && (
                  <button
                    onClick={() => void onCompleteSubtask(subtask.id)}
                    disabled={saving}
                    className="inline-flex h-9 items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white transition-all hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:text-slate-600"
                  >
                    <CheckCircle2 size={13} />
                    Mark done
                  </button>
                )
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-slate-500">No subtasks yet.</p>
        )}
      </div>

      {can(role, "tasks:create") && (
        <form onSubmit={onCreateSubtask} className="mt-5 flex flex-col gap-3 sm:flex-row">
          <input
            value={subtaskTitle}
            onChange={(event) => onSubtaskTitleChange(event.target.value)}
            placeholder="New subtask title"
            className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60"
          />
          <PermissionAction
            role={role}
            permission="tasks:create"
            type="submit"
            variant="secondary"
          >
            <Plus size={16} />
            Add subtask
          </PermissionAction>
        </form>
      )}
    </SectionCard>
  );
}
