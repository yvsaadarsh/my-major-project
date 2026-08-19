"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Bell,
  Calculator,
  CalendarClock,
  GitBranch,
  Gauge,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { AutomationRulesPanel } from "@/components/work-os/automation-rules-panel";
import { ProjectHealthPanel } from "@/components/work-os/project-health-panel";
import {
  AuditHistoryPanel,
  DependenciesPanel,
  MilestonesPanel,
  NotificationsPanel,
  WorkloadPanel,
} from "@/components/work-os/overview-panels";
import { apiRequest } from "@/lib/ui/api-client";
import { can } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";
import type { Overview } from "@/lib/ui/work-os-types";

export default function WorkOsPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [automationName, setAutomationName] = useState("");
  const [automationCondition, setAutomationCondition] = useState(
    "Open task due date is before today",
  );
  const [automationTrigger, setAutomationTrigger] = useState("TASK_OVERDUE");
  const [automationAction, setAutomationAction] = useState("NOTIFY_MANAGER");

  const topHealth = useMemo(
    () => overview?.health.slice().sort((a, b) => a.health.score - b.health.score) ?? [],
    [overview],
  );

  async function loadOverview() {
    setError(null);
    setLoading(true);

    try {
      const response = await apiRequest<Overview>("/api/v1/work-os/overview");
      setOverview(response);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load Work OS.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (organization) {
      void loadOverview();
    }
  }, [organization]);

  async function createAutomation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!can(role, "automations:manage") || !automationName.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest("/api/v1/automations", {
        body: {
          action: automationAction,
          condition: automationCondition,
          description: "Created from the Work OS automation console.",
          enabled: true,
          name: automationName,
          trigger: automationTrigger,
        },
        method: "POST",
      });
      setAutomationName("");
      await loadOverview();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create automation.");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  type MetricTuple = [string, number, typeof Gauge];
  const metricCards: MetricTuple[] = [
    ["Projects monitored", overview?.health.length ?? 0, Gauge],
    ["Milestones", overview?.milestones.length ?? 0, CalendarClock],
    ["Dependencies", overview?.dependencies.length ?? 0, GitBranch],
    ["Unread notices", overview?.notifications?.filter((n) => !n.readAt).length ?? 0, Bell],
  ];

  return (
    <AppShell
      eyebrow="Work graph"
      organizationName={organization?.name}
      role={role}
      title="Plan, risk, access, and operations in one tenant-safe control room."
      description="Northstar connects projects, milestones, tasks, dependencies, notifications, automations, and audit history in one tenant-scoped view."
    >
      {error && <InlineError message={error} />}

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-2 rounded-2xl border border-teal-300/20 bg-teal-300/10 px-4 py-3 text-sm font-medium text-teal-100">
            <ShieldCheck size={17} />
            Server-enforced tenant scope
          </span>
          {/*
            Precise rather than absolute: every number on this page is computed
            by the domain layer. AI may phrase a notification body, but it never
            produces a score — see AGENTS.md rules 3 and 6.
          */}
          <span
            className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-slate-300"
            title="Health scores, workload and dependency impact are computed deterministically. Generated text never sets a number."
          >
            <Calculator size={17} />
            Scores computed, never generated
          </span>
        </div>
        <button
          className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white transition-all hover:bg-white/[0.1]"
          onClick={() => void loadOverview()}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {loading ? (
        <LoadingState label="Loading tenant work graph..." />
      ) : (
        <div className="grid gap-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {metricCards.map(([label, value, MetricIcon]) => (
              <SectionCard key={label} className="min-h-36">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-400">{label}</p>
                  <MetricIcon className="text-teal-300" size={20} />
                </div>
                <p className="mt-5 text-4xl font-semibold text-white">{value}</p>
              </SectionCard>
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
            <ProjectHealthPanel projects={topHealth} />

            <AutomationRulesPanel
              action={automationAction}
              condition={automationCondition}
              name={automationName}
              onActionChange={setAutomationAction}
              onConditionChange={setAutomationCondition}
              onNameChange={setAutomationName}
              onSubmit={createAutomation}
              onTriggerChange={setAutomationTrigger}
              role={role}
              rules={overview?.automationRules}
              saving={saving}
              trigger={automationTrigger}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-3">
            <MilestonesPanel milestones={overview?.milestones} />
            <DependenciesPanel dependencies={overview?.dependencies} />
            <NotificationsPanel notifications={overview?.notifications} />
          </div>

          <div className="grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
            <WorkloadPanel members={overview?.members} />
            <AuditHistoryPanel activityLogs={overview?.activityLogs} role={role} />
          </div>
        </div>
      )}
    </AppShell>
  );
}
