"use client";

import { FormEvent } from "react";
import { Plus, Workflow } from "lucide-react";

import { RoleNotice } from "@/components/app-shell";
import { EmptyState } from "@/components/page-state";
import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import { formatStatus } from "@/lib/ui/api-client";
import { can, type Role } from "@/lib/ui/permissions";
import { shortDate, type AutomationRule } from "@/lib/ui/work-os-types";

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

export function AutomationRulesPanel({
  role,
  rules,
  saving,
  name,
  trigger,
  condition,
  action,
  onNameChange,
  onTriggerChange,
  onConditionChange,
  onActionChange,
  onSubmit,
}: {
  role: Role;
  rules: AutomationRule[] | undefined;
  saving: boolean;
  name: string;
  trigger: string;
  condition: string;
  action: string;
  onNameChange: (value: string) => void;
  onTriggerChange: (value: string) => void;
  onConditionChange: (value: string) => void;
  onActionChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const allowed = can(role, "automations:manage");

  return (
    <SectionCard>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white">Automation rules</h2>
          <p className="mt-1 text-sm text-slate-400">
            Deterministic triggers, conditions, actions, and audit logs.
          </p>
        </div>
        <Workflow className="text-teal-300" size={24} />
      </div>

      <form className="mt-5 space-y-3" onSubmit={onSubmit}>
        <input
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
          disabled={!allowed}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="Rule name"
          value={name}
        />
        <select
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
          disabled={!allowed}
          onChange={(event) => onTriggerChange(event.target.value)}
          value={trigger}
        >
          {triggerOptions.map(([value, label]) => (
            <option className="bg-slate-950 text-white" key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
          disabled={!allowed}
          onChange={(event) => onConditionChange(event.target.value)}
          placeholder="Condition"
          value={condition}
        />
        <select
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
          disabled={!allowed}
          onChange={(event) => onActionChange(event.target.value)}
          value={action}
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

      {!allowed && (
        <div className="mt-4">
          <RoleNotice text="Automation management is available to admins and managers." />
        </div>
      )}

      <div className="mt-5 space-y-3">
        {rules?.length ? (
          rules.map((rule) => (
            <div
              className="rounded-2xl border border-white/10 bg-white/[0.035] p-4"
              key={rule.id}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-white">{rule.name}</p>
                <span
                  className={`rounded-full px-2 py-1 text-xs ${rule.enabled ? "bg-emerald-300/10 text-emerald-200" : "bg-white/10 text-slate-400"}`}
                >
                  {rule.enabled ? "Enabled" : "Paused"}
                </span>
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                {formatStatus(rule.trigger)} then {formatStatus(rule.action)}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {rule.runsThisMonth} runs this month / last {shortDate(rule.lastRunAt)}
              </p>
            </div>
          ))
        ) : (
          <EmptyState
            title="No automation rules"
            description="Create deterministic rules for overdue work, health changes, and milestone updates."
          />
        )}
      </div>
    </SectionCard>
  );
}
