"use client";

import { useId, useState } from "react";
import { RefreshCw, Save, Search, Share2, Trash2 } from "lucide-react";

import {
  columnLabel,
  groupByLabel,
  NO_MILESTONE_KEY,
  priorityLabel,
  sortFieldLabel,
  statusLabel,
  UNASSIGNED_KEY,
  VIEW_COLUMNS,
  VIEW_PRIORITIES,
  VIEW_STATUSES,
  VIEW_TYPES,
  viewTypeLabel,
  GROUP_BY_OPTIONS,
  SORT_FIELDS,
  type GroupBy,
  type SortDirection,
  type SortField,
  type ViewConfig,
  type ViewType,
} from "@/lib/domain/view-engine";
import type { Member, Milestone, SavedView } from "@/lib/ui/api-client";
import { can, type Role } from "@/lib/ui/permissions";

export type ViewToolbarProps = {
  canManageSelected: boolean;
  config: ViewConfig;
  members: Member[];
  milestones: Milestone[];
  onConfigChange: (config: ViewConfig) => void;
  onCreateView: (name: string) => void;
  onDeleteView: () => void;
  onResetConfig: () => void;
  onSelectView: (viewId: string) => void;
  onToggleShared: () => void;
  onUpdateView: () => void;
  onViewTypeChange: (viewType: ViewType) => void;
  role: Role;
  savedViews: SavedView[];
  selectedView: SavedView | null;
  viewType: ViewType;
};

const controlClass =
  "h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-3 text-sm text-white outline-none transition-all focus:border-teal-300/60 focus-visible:ring-2 focus-visible:ring-teal-300/30 disabled:cursor-not-allowed disabled:text-slate-600";

const multiSelectClass =
  "w-full rounded-2xl border border-white/10 bg-white/[0.04] p-2 text-sm text-white outline-none transition-all focus:border-teal-300/60 focus-visible:ring-2 focus-visible:ring-teal-300/30";

const labelClass = "text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500";

const buttonClass =
  "inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white transition-all hover:bg-white/[0.1] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/40 disabled:cursor-not-allowed disabled:bg-white/[0.03] disabled:text-slate-600";

function selectedValues(element: HTMLSelectElement) {
  return Array.from(element.selectedOptions).map((option) => option.value);
}

/**
 * Shared control bar for every view: view-type switch, filters, sort, grouping,
 * column visibility (table only) and saved-view management. Purely
 * presentational — all state changes bubble up through callbacks.
 */
export function ViewToolbar({
  canManageSelected,
  config,
  members,
  milestones,
  onConfigChange,
  onCreateView,
  onDeleteView,
  onResetConfig,
  onSelectView,
  onToggleShared,
  onUpdateView,
  onViewTypeChange,
  role,
  savedViews,
  selectedView,
  viewType,
}: ViewToolbarProps) {
  const ids = useId();
  const [newViewName, setNewViewName] = useState("");
  const canShare = can(role, "projects:update");

  function patchFilter(patch: Partial<ViewConfig["filter"]>) {
    onConfigChange({ ...config, filter: { ...config.filter, ...patch } });
  }

  function toggleColumn(column: string) {
    const visible = config.visibleColumns.includes(column)
      ? config.visibleColumns.filter((entry) => entry !== column)
      : [...config.visibleColumns, column];

    onConfigChange({ ...config, visibleColumns: visible });
  }

  return (
    <div className="space-y-4 rounded-3xl border border-white/10 bg-white/[0.025] p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="group"
          aria-label="View type"
          className="inline-flex flex-wrap gap-1 rounded-2xl border border-white/10 bg-white/[0.04] p-1"
        >
          {VIEW_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={viewType === type}
              onClick={() => onViewTypeChange(type)}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-300/40 ${
                viewType === type
                  ? "bg-teal-300 text-slate-950"
                  : "text-slate-300 hover:bg-white/[0.08] hover:text-white"
              }`}
            >
              {viewTypeLabel(type)}
            </button>
          ))}
        </div>

        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center lg:max-w-md">
          <label className="sr-only" htmlFor={`${ids}-search`}>
            Search tasks
          </label>
          <div className="relative flex-1">
            <Search
              aria-hidden
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
            />
            <input
              id={`${ids}-search`}
              type="search"
              value={config.filter.search ?? ""}
              onChange={(event) => patchFilter({ search: event.target.value })}
              placeholder="Search title or description"
              className={`${controlClass} pl-9`}
            />
          </div>
          <button type="button" onClick={onResetConfig} className={buttonClass}>
            <RefreshCw aria-hidden size={15} />
            Reset
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <label className={labelClass} htmlFor={`${ids}-sort-field`}>
            Sort by
          </label>
          <select
            id={`${ids}-sort-field`}
            value={config.sortField}
            onChange={(event) =>
              onConfigChange({ ...config, sortField: event.target.value as SortField })
            }
            className={`${controlClass} mt-1.5`}
          >
            {SORT_FIELDS.map((field) => (
              <option className="bg-slate-950 text-white" key={field} value={field}>
                {sortFieldLabel(field)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor={`${ids}-sort-direction`}>
            Direction
          </label>
          <select
            id={`${ids}-sort-direction`}
            value={config.sortDirection}
            onChange={(event) =>
              onConfigChange({
                ...config,
                sortDirection: event.target.value as SortDirection,
              })
            }
            className={`${controlClass} mt-1.5`}
          >
            <option className="bg-slate-950 text-white" value="asc">
              Ascending
            </option>
            <option className="bg-slate-950 text-white" value="desc">
              Descending
            </option>
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor={`${ids}-group-by`}>
            Group by
          </label>
          <select
            id={`${ids}-group-by`}
            value={config.groupBy}
            onChange={(event) =>
              onConfigChange({ ...config, groupBy: event.target.value as GroupBy })
            }
            className={`${controlClass} mt-1.5`}
          >
            {GROUP_BY_OPTIONS.map((option) => (
              <option className="bg-slate-950 text-white" key={option} value={option}>
                {groupByLabel(option)}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2">
          <legend className={`${labelClass} px-1`}>Scope</legend>
          <label className="flex items-center gap-2 py-1 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={config.filter.overdueOnly === true}
              onChange={(event) => patchFilter({ overdueOnly: event.target.checked })}
              className="h-4 w-4 accent-teal-300"
            />
            Overdue only
          </label>
          <label className="flex items-center gap-2 py-1 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={config.filter.includeSubtasks !== false}
              onChange={(event) => patchFilter({ includeSubtasks: event.target.checked })}
              className="h-4 w-4 accent-teal-300"
            />
            Include subtasks
          </label>
        </fieldset>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <label className={labelClass} htmlFor={`${ids}-status`}>
            Status
          </label>
          <select
            id={`${ids}-status`}
            multiple
            size={4}
            value={config.filter.status ?? []}
            onChange={(event) => patchFilter({ status: selectedValues(event.target) })}
            className={`${multiSelectClass} mt-1.5`}
          >
            {VIEW_STATUSES.map((status) => (
              <option className="bg-slate-950 text-white" key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor={`${ids}-priority`}>
            Priority
          </label>
          <select
            id={`${ids}-priority`}
            multiple
            size={4}
            value={config.filter.priority ?? []}
            onChange={(event) => patchFilter({ priority: selectedValues(event.target) })}
            className={`${multiSelectClass} mt-1.5`}
          >
            {VIEW_PRIORITIES.map((priority) => (
              <option className="bg-slate-950 text-white" key={priority} value={priority}>
                {priorityLabel(priority)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor={`${ids}-assignee`}>
            Assignee
          </label>
          <select
            id={`${ids}-assignee`}
            multiple
            size={4}
            value={config.filter.assigneeIds ?? []}
            onChange={(event) => patchFilter({ assigneeIds: selectedValues(event.target) })}
            className={`${multiSelectClass} mt-1.5`}
          >
            <option className="bg-slate-950 text-white" value={UNASSIGNED_KEY}>
              Unassigned
            </option>
            {members.map((member) => (
              <option className="bg-slate-950 text-white" key={member.id} value={member.user.id}>
                {member.user.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor={`${ids}-milestone`}>
            Milestone
          </label>
          <select
            id={`${ids}-milestone`}
            multiple
            size={4}
            value={config.filter.milestoneIds ?? []}
            onChange={(event) => patchFilter({ milestoneIds: selectedValues(event.target) })}
            className={`${multiSelectClass} mt-1.5`}
          >
            <option className="bg-slate-950 text-white" value={NO_MILESTONE_KEY}>
              No milestone
            </option>
            {milestones.map((milestone) => (
              <option className="bg-slate-950 text-white" key={milestone.id} value={milestone.id}>
                {milestone.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {viewType === "TABLE" && (
        <fieldset className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3">
          <legend className={`${labelClass} px-1`}>Visible columns</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {VIEW_COLUMNS.map((column) => (
              <label key={column} className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={config.visibleColumns.includes(column)}
                  onChange={() => toggleColumn(column)}
                  className="h-4 w-4 accent-teal-300"
                />
                {columnLabel(column)}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex flex-col gap-3 border-t border-white/10 pt-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor={`${ids}-saved-view`}>
              Saved view
            </label>
            <select
              id={`${ids}-saved-view`}
              value={selectedView?.id ?? ""}
              onChange={(event) => onSelectView(event.target.value)}
              className={`${controlClass} mt-1.5`}
            >
              <option className="bg-slate-950 text-white" value="">
                Unsaved view
              </option>
              {savedViews.map((view) => (
                <option className="bg-slate-950 text-white" key={view.id} value={view.id}>
                  {view.name}
                  {view.isShared ? " (shared)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor={`${ids}-new-view`}>
              Save current view as
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id={`${ids}-new-view`}
                value={newViewName}
                onChange={(event) => setNewViewName(event.target.value)}
                placeholder="View name"
                className={`${controlClass} placeholder:text-slate-600`}
              />
              <button
                type="button"
                disabled={newViewName.trim().length < 2}
                onClick={() => {
                  onCreateView(newViewName.trim());
                  setNewViewName("");
                }}
                className={buttonClass}
              >
                <Save aria-hidden size={15} />
                Save
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!selectedView || !canManageSelected}
            onClick={onUpdateView}
            className={buttonClass}
          >
            Update
          </button>
          {canShare && (
            <button
              type="button"
              disabled={!selectedView || !canManageSelected}
              aria-pressed={selectedView?.isShared === true}
              onClick={onToggleShared}
              className={`${buttonClass} ${
                selectedView?.isShared
                  ? "border-teal-300/40 bg-teal-300/15 text-teal-100"
                  : ""
              }`}
            >
              <Share2 aria-hidden size={15} />
              {selectedView?.isShared ? "Shared" : "Share"}
            </button>
          )}
          <button
            type="button"
            disabled={!selectedView || !canManageSelected}
            onClick={onDeleteView}
            aria-label="Delete saved view"
            className={`${buttonClass} hover:border-rose-300/30 hover:bg-rose-300/10 hover:text-rose-100`}
          >
            <Trash2 aria-hidden size={15} />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
