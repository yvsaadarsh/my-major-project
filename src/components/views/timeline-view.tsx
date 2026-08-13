"use client";

import Link from "next/link";

import { EmptyState } from "@/components/page-state";
import {
  assigneeNameFor,
  formatViewDate,
  StatusPill,
  type ViewProps,
} from "@/components/views/shared";
import { buildTimelineLayout, isTaskOverdue } from "@/lib/domain/view-engine";

const barStyles: Record<string, string> = {
  TODO: "bg-slate-400/70",
  IN_PROGRESS: "bg-teal-300",
  BLOCKED: "bg-rose-300",
  DONE: "bg-emerald-300",
};

/**
 * Lightweight horizontal timeline. Bars are positioned as percentages of the
 * overall date range by the pure `buildTimelineLayout` helper — no charting
 * dependency, just CSS. Scrolls horizontally on small screens.
 */
export function TimelineView({ members, tasks }: ViewProps) {
  const layout = buildTimelineLayout(tasks);

  if (!layout.bars.length) {
    return (
      <EmptyState
        title="No dated tasks"
        description="The timeline plots tasks that have a due date. Give a task a due date, or relax the current filters, to see it here."
      />
    );
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="min-w-[46rem] space-y-3">
        <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Range start
            </p>
            <p className="mt-1 text-sm font-semibold text-white">
              {formatViewDate(layout.rangeStart)}
            </p>
          </div>
          <p className="text-xs text-slate-500">{layout.totalDays} days</p>
          <div className="text-right">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
              Range end
            </p>
            <p className="mt-1 text-sm font-semibold text-white">
              {formatViewDate(layout.rangeEnd)}
            </p>
          </div>
        </div>

        <ul className="space-y-2">
          {layout.bars.map((bar) => (
            <li
              key={bar.task.id}
              className="grid grid-cols-[13rem_1fr] items-center gap-4 rounded-3xl border border-white/10 bg-white/[0.025] px-4 py-3"
            >
              <div className="min-w-0">
                <Link
                  href={`/tasks/${bar.task.id}`}
                  className="block truncate text-sm font-semibold text-white underline-offset-4 transition-colors hover:text-teal-200 hover:underline focus:outline-none focus-visible:text-teal-200 focus-visible:underline"
                >
                  {bar.task.title}
                </Link>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {assigneeNameFor(bar.task, members)}
                </p>
              </div>

              <div className="relative h-9 overflow-hidden rounded-2xl bg-white/[0.04]">
                <div
                  className={`absolute inset-y-1 flex items-center rounded-xl px-2 ${
                    barStyles[bar.task.status] ?? "bg-slate-400/70"
                  } ${isTaskOverdue(bar.task) ? "ring-1 ring-rose-200" : ""}`}
                  style={{
                    left: `${bar.offsetPercent}%`,
                    width: `${bar.widthPercent}%`,
                  }}
                  title={`${formatViewDate(bar.start)} → ${formatViewDate(bar.end)}`}
                >
                  <span className="truncate text-[11px] font-semibold text-slate-950">
                    {formatViewDate(bar.end)}
                  </span>
                </div>
                <span className="sr-only">
                  {bar.task.title} runs from {formatViewDate(bar.start)} to{" "}
                  {formatViewDate(bar.end)}
                </span>
              </div>

              <div className="col-span-2 sm:hidden">
                <StatusPill status={bar.task.status} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
