"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import {
  assigneeNameFor,
  DueDate,
  milestoneNameOf,
  PriorityPill,
  StatusPill,
  type ViewProps,
} from "@/components/views/shared";
import {
  columnLabel,
  VIEW_COLUMNS,
  type SortField,
  type ViewColumn,
  type ViewTask,
} from "@/lib/domain/view-engine";
import type { Member, Milestone } from "@/lib/ui/api-client";

/** Columns that map onto a sortable domain field. `milestone` has no sort key. */
const columnSortField: Partial<Record<ViewColumn, SortField>> = {
  title: "title",
  status: "status",
  priority: "priority",
  assignee: "assignee",
  dueDate: "dueDate",
};

function renderCell(
  column: ViewColumn,
  task: ViewTask,
  members: Member[],
  milestones: Milestone[],
) {
  switch (column) {
    case "title":
      return (
        <Link
          href={`/tasks/${task.id}`}
          className="font-semibold text-white underline-offset-4 transition-colors hover:text-teal-200 hover:underline focus:outline-none focus-visible:text-teal-200 focus-visible:underline"
        >
          {task.title}
        </Link>
      );
    case "status":
      return <StatusPill status={task.status} />;
    case "priority":
      return <PriorityPill priority={task.priority} />;
    case "assignee":
      return <span className="text-slate-300">{assigneeNameFor(task, members)}</span>;
    case "dueDate":
      return <DueDate task={task} />;
    case "milestone":
      return <span className="text-slate-400">{milestoneNameOf(task, milestones)}</span>;
    default:
      return null;
  }
}

/** Spreadsheet-style view with sortable headers and per-column visibility. */
export function TableView({ config, groups, members, milestones, onConfigChange }: ViewProps) {
  const columns = VIEW_COLUMNS.filter((column) => config.visibleColumns.includes(column));
  const visible = columns.length ? columns : VIEW_COLUMNS;
  const populated = groups.filter((group) => group.tasks.length > 0);

  function toggleSort(column: ViewColumn) {
    const field = columnSortField[column];

    if (!field) {
      return;
    }

    onConfigChange({
      ...config,
      sortField: field,
      sortDirection:
        config.sortField === field && config.sortDirection === "asc" ? "desc" : "asc",
    });
  }

  if (!populated.length) {
    return (
      <p className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-slate-500">
        No tasks match the current view.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-3xl border border-white/10 bg-white/[0.025]">
      <table className="w-full min-w-[46rem] border-collapse text-left text-sm">
        <caption className="sr-only">
          Tasks in the current view, sorted by {columnLabel(config.sortField)},{" "}
          {config.sortDirection === "asc" ? "ascending" : "descending"}.
        </caption>
        <thead>
          <tr className="border-b border-white/10">
            {visible.map((column) => {
              const field = columnSortField[column];
              const active = field !== undefined && config.sortField === field;

              return (
                <th
                  key={column}
                  scope="col"
                  aria-sort={
                    active
                      ? config.sortDirection === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400"
                >
                  {field ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(column)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-1 py-0.5 uppercase tracking-[0.16em] transition-colors hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/40"
                    >
                      {columnLabel(column)}
                      {active ? (
                        config.sortDirection === "asc" ? (
                          <ArrowUp aria-hidden size={13} className="text-teal-300" />
                        ) : (
                          <ArrowDown aria-hidden size={13} className="text-teal-300" />
                        )
                      ) : (
                        <ChevronsUpDown aria-hidden size={13} className="text-slate-600" />
                      )}
                    </button>
                  ) : (
                    columnLabel(column)
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        {populated.map((group) => (
          <tbody key={group.key}>
            {config.groupBy !== "none" && (
              <tr className="border-b border-white/5 bg-white/[0.03]">
                <th
                  scope="colgroup"
                  colSpan={visible.length}
                  className="px-4 py-2 text-left text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"
                >
                  {group.label}
                  <span className="ml-2 font-normal normal-case tracking-normal text-slate-600">
                    {group.tasks.length}
                  </span>
                </th>
              </tr>
            )}

            {group.tasks.map((task) => (
              <tr
                key={task.id}
                className="border-b border-white/5 transition-colors last:border-0 hover:bg-white/[0.04]"
              >
                {visible.map((column) => (
                  <td key={column} className="px-4 py-3 align-middle">
                    {renderCell(column, task, members, milestones)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}
