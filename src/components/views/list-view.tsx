"use client";

import Link from "next/link";

import {
  assigneeNameFor,
  DueDate,
  GroupHeading,
  PriorityPill,
  StatusPill,
  type ViewProps,
} from "@/components/views/shared";

/** Dense grouped rows — the highest information density per vertical pixel. */
export function ListView({ groups, members, tasks }: ViewProps) {
  const populated = groups.filter((group) => group.tasks.length > 0);

  if (!tasks.length) {
    return (
      <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">
        No tasks match the current view.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {populated.map((group) => (
        <section key={group.key} aria-label={`${group.label} group`}>
          <GroupHeading label={group.label} count={group.tasks.length} />

          <ul className="mt-3 divide-y divide-white/5 overflow-hidden rounded-3xl border border-white/10 bg-white/[0.025]">
            {group.tasks.map((task) => (
              <li key={task.id}>
                <Link
                  href={`/tasks/${task.id}`}
                  className="flex flex-col gap-2 px-4 py-3 transition-colors hover:bg-white/[0.05] focus:outline-none focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-300/40 sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
                    {task.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-slate-400">{assigneeNameFor(task, members)}</span>
                    <StatusPill status={task.status} />
                    <PriorityPill priority={task.priority} />
                    <DueDate task={task} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
