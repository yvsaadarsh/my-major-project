"use client";

import Link from "next/link";

import {
  assigneeNameFor,
  CountBadge,
  DueDate,
  PriorityPill,
  type ViewProps,
} from "@/components/views/shared";
import { groupTasks } from "@/lib/domain/view-engine";

/**
 * Kanban-style board. Columns follow the active `groupBy`; when grouping is off
 * the board falls back to the four workflow status lanes so it never collapses
 * into a single column.
 */
export function BoardView({ config, groups, members, tasks }: ViewProps) {
  const columns = config.groupBy === "none" ? groupTasks(tasks, "status") : groups;

  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-full gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {columns.map((column) => (
          <section
            key={column.key}
            aria-label={`${column.label} column`}
            className="min-h-[22rem] rounded-3xl border border-white/10 bg-white/[0.025] p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                {column.label}
              </h3>
              <CountBadge count={column.tasks.length} />
            </div>

            <div className="mt-4 space-y-3">
              {column.tasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="group block rounded-3xl border border-white/10 bg-white/[0.04] p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-teal-300/30 hover:bg-white/[0.07] focus:outline-none focus-visible:border-teal-300/60 focus-visible:ring-2 focus-visible:ring-teal-300/40"
                >
                  <p className="text-sm font-semibold leading-6 text-white">{task.title}</p>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="truncate text-xs text-slate-400">
                      {assigneeNameFor(task, members)}
                    </span>
                    <PriorityPill priority={task.priority} />
                  </div>
                  <p className="mt-2 text-xs">
                    <DueDate task={task} />
                  </p>
                </Link>
              ))}

              {column.tasks.length === 0 && (
                <p className="rounded-2xl border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-600">
                  Nothing here
                </p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
