"use client";

import { FormEvent, useState } from "react";
import { AlertTriangle, Play, Plus, Sparkles, Trash2, Zap } from "lucide-react";

import { AppShell, RoleNotice } from "@/components/app-shell";
import { PolicyDraftCard } from "@/components/automations/PolicyDraftCard";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import {
  apiRequest,
  ClientApiError,
  formatStatus,
  type AutomationAction,
  type AutomationRule,
  type AutomationRunSummary,
  type AutomationTrigger,
  type InterpretResult,
} from "@/lib/ui/api-client";
import { useApiQuery } from "@/lib/ui/use-api-query";
import { errorMessage } from "@/lib/ui/error-message";
import { can } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";

const TRIGGERS: AutomationTrigger[] = [
  "TASK_STATUS_CHANGED",
  "TASK_OVERDUE",
  "PROJECT_HEALTH_CHANGED",
];

const ACTIONS: AutomationAction[] = [
  "NOTIFY_MANAGER",
  "UPDATE_MILESTONE_PROGRESS",
  "WRITE_AUDIT_EVENT",
];

const emptyForm = {
  name: "",
  description: "",
  trigger: "TASK_STATUS_CHANGED" as AutomationTrigger,
  condition: "status == DONE",
  action: "UPDATE_MILESTONE_PROGRESS" as AutomationAction,
  // D-8: the manual form also starts as a disabled draft, so neither creation
  // path produces a live rule without the author ticking the toggle below.
  // The toggle itself is unchanged and still works in both directions.
  enabled: false,
};

// ── Policy input max length matches backend policyInterpretRequestSchema ──
const POLICY_MAX_LENGTH = 2000;

export default function AutomationsPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });
  const canManage = can(role, "automations:manage");

  // ── Existing automation state ──────────────────────────────────────────
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<AutomationRunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── AI Policy Studio state ─────────────────────────────────────────────
  const [policy, setPolicy] = useState("");
  const [interpreting, setInterpreting] = useState(false);
  const [interpretError, setInterpretError] = useState<string | null>(null);
  const [draft, setDraft] = useState<InterpretResult | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);
  /** D-8: confirmation that a saved rule is inert until explicitly enabled. */
  const [draftSavedNotice, setDraftSavedNotice] = useState<string | null>(null);
  const [draftSaveError, setDraftSaveError] = useState<string | null>(null);

  // ── Data loading ───────────────────────────────────────────────────────

  const { data, loading, error: queryError, reload: loadRules } = useApiQuery<{ automationRules: AutomationRule[] }>(
    organization ? "/api/v1/automations" : null, "Unable to load automations.", organization?.id,
  );
  const rules = data?.automationRules ?? [];

  // ── Manual rule creation ───────────────────────────────────────────────

  async function createRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiRequest("/api/v1/automations", {
        method: "POST",
        body: {
          name: form.name,
          description: form.description || undefined,
          trigger: form.trigger,
          condition: form.condition,
          action: form.action,
          enabled: form.enabled,
        },
      });
      setForm(emptyForm);
      await loadRules();
    } catch (caught) {
      setError(errorMessage(caught, "Unable to create automation."));
    } finally {
      setSaving(false);
    }
  }

  // ── Toggle / delete / run ──────────────────────────────────────────────

  async function toggleEnabled(rule: AutomationRule) {
    if (!canManage) {
      return;
    }
    setError(null);
    try {
      await apiRequest(`/api/v1/automations/${rule.id}`, {
        method: "PATCH",
        body: { enabled: !rule.enabled },
      });
      await loadRules();
    } catch (caught) {
      setError(errorMessage(caught, "Unable to update automation."));
    }
  }

  async function deleteRule(rule: AutomationRule) {
    if (!canManage || !window.confirm(`Delete automation "${rule.name}"?`)) {
      return;
    }
    setError(null);
    try {
      await apiRequest(`/api/v1/automations/${rule.id}`, { method: "DELETE" });
      await loadRules();
    } catch (caught) {
      setError(errorMessage(caught, "Unable to delete automation."));
    }
  }

  async function runNow() {
    if (!canManage) {
      return;
    }
    setRunning(true);
    setSummary(null);
    setError(null);
    try {
      const response = await apiRequest<{ summary: AutomationRunSummary }>(
        "/api/v1/automations/run",
        { method: "POST" },
      );
      setSummary(response.summary);
      await loadRules();
    } catch (caught) {
      setError(errorMessage(caught, "Unable to run automations."));
    } finally {
      setRunning(false);
    }
  }

  // ── AI Policy Studio handlers ──────────────────────────────────────────

  /**
   * POST /api/v1/automations/interpret — read-only, returns a draft for review.
   * Never writes to the DB; the manager explicitly approves before saving.
   */
  async function interpretPolicy() {
    if (!canManage || !policy.trim()) {
      return;
    }
    setInterpreting(true);
    setInterpretError(null);
    setDraft(null);
    setDraftSaveError(null);
    setDraftSavedNotice(null);
    try {
      const result = await apiRequest<InterpretResult>("/api/v1/automations/interpret", {
        method: "POST",
        body: { policy: policy.trim() },
      });
      setDraft(result);
    } catch (caught) {
      // Map specific error codes to user-friendly messages
      if (caught instanceof ClientApiError) {
        if (caught.status === 422) {
          setInterpretError(
            "This policy cannot be mapped to a supported trigger, condition, or action. " +
              "Try rephrasing it, or use the manual form below.",
          );
        } else if (caught.status === 501) {
          // Matches the simulation workspace's handling: the feature is
          // switched off for this deployment, not failing intermittently, so
          // retrying will not help.
          setInterpretError(
            "AI policy interpretation is not configured for this deployment. " +
              "Use the manual form below.",
          );
        } else if (caught.status === 502) {
          setInterpretError(
            "The AI service is temporarily unavailable. Please try again in a moment.",
          );
        } else if (caught.status === 403) {
          setInterpretError("You don't have permission to interpret policies.");
        } else {
          setInterpretError(errorMessage(caught, "Interpretation failed. Please try again."));
        }
      } else {
        setInterpretError(errorMessage(caught, "Interpretation failed. Please try again."));
      }
    } finally {
      setInterpreting(false);
    }
  }

  /**
   * Save the AI-generated draft via the existing POST /api/v1/automations endpoint.
   * Requires explicit user approval (clicking "Save rule" / "Save anyway").
   * Draft is preserved on save failure so the user doesn't lose their work.
   */
  async function saveDraft() {
    if (!canManage || !draft) {
      return;
    }
    setDraftSaving(true);
    setDraftSaveError(null);
    try {
      await apiRequest("/api/v1/automations", {
        method: "POST",
        body: {
          name: draft.draft.name,
          trigger: draft.draft.trigger,
          condition: draft.draft.condition,
          action: draft.draft.action,
          // D-8: saved as a disabled draft. Approving the AI's interpretation
          // means "this rule is correct", not "start running it now" — the
          // user enables it from the rule list as a separate, audited step.
          enabled: false,
          sourcePolicy: draft.sourcePolicy,
        },
      });
      // Clear policy studio state on successful save
      setPolicy("");
      setDraft(null);
      setDraftSaveError(null);
      // D-8: the draft card is gone at this point, so say what happened —
      // otherwise a successful save is indistinguishable from activation.
      setDraftSavedNotice(
        "Rule saved as a disabled draft. Enable it below when you're ready for it to run.",
      );
      // Refresh rule list so the newly saved rule appears
      await loadRules();
    } catch (caught) {
      // Intentionally preserve `draft` so the user can retry without re-interpreting
      if (caught instanceof ClientApiError) {
        if (caught.status === 403) {
          setDraftSaveError("You don't have permission to save automation rules.");
        } else {
          setDraftSaveError(errorMessage(caught, "Unable to save rule. The draft has been preserved."));
        }
      } else {
        setDraftSaveError(errorMessage(caught, "Unable to save rule. The draft has been preserved."));
      }
    } finally {
      setDraftSaving(false);
    }
  }

  function discardDraft() {
    setDraft(null);
    setDraftSaveError(null);
    setPolicy("");
    setInterpretError(null);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  const policyCharsLeft = POLICY_MAX_LENGTH - policy.length;
  const canInterpret = canManage && policy.trim().length > 0 && !interpreting && !draftSaving;

  return (
    <AppShell
      eyebrow="Automations"
      organizationName={organization?.name}
      role={role}
      title="Deterministic rules that keep work moving."
      description="Each rule runs a trigger → condition → action pipeline. Runs are idempotent: the same event never fires the same effect twice."
    >
      {(error || queryError) && (
        <div className="mb-4">
          <InlineError message={error || queryError!} />
        </div>
      )}

      {!canManage && (
        <div className="mb-4">
          <RoleNotice text="You can view automation rules. Only Admins and Managers can create, edit, delete or run them." />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        {/* ── Existing rules list ── */}
        <SectionCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <Zap size={18} className="text-teal-300" />
                Rules
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Enabled rules run automatically on matching events.
              </p>
            </div>
            {canManage && (
              <button
                type="button"
                onClick={() => void runNow()}
                disabled={running}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
              >
                <Play size={16} />
                {running ? "Running…" : "Run now"}
              </button>
            )}
          </div>

          {summary && (
            <div className="mt-4 grid grid-cols-4 gap-2 rounded-2xl border border-teal-300/20 bg-teal-300/[0.06] p-3 text-center">
              {(
                [
                  ["Evaluated", summary.evaluated],
                  ["Fired", summary.fired],
                  ["Skipped", summary.skipped],
                  ["Failed", summary.failed],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <p className="text-lg font-semibold text-white">{value}</p>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
                </div>
              ))}
            </div>
          )}

          {rules.length === 0 && !loading ? (
            <div className="mt-6">
              <EmptyState
                title="No automation rules yet"
                description="Create a rule to notify managers, advance milestones, or write audit events automatically."
              />
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-semibold text-white">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            rule.enabled ? "bg-teal-300" : "bg-slate-600"
                          }`}
                          aria-hidden
                        />
                        {rule.name}
                        {rule.sourcePolicy && (
                          <span
                            title={`Created from policy: ${rule.sourcePolicy}`}
                            className="inline-flex items-center gap-1 rounded-full bg-teal-300/10 px-1.5 py-0.5 text-[10px] font-medium text-teal-300"
                          >
                            <Sparkles size={9} />
                            AI
                          </span>
                        )}
                      </p>
                      {rule.description && (
                        <p className="mt-1 text-sm text-slate-400">{rule.description}</p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                        <span className="rounded-full bg-white/[0.06] px-2 py-1 font-medium text-slate-300">
                          {formatStatus(rule.trigger)}
                        </span>
                        <span className="rounded-full bg-white/[0.06] px-2 py-1 font-mono text-slate-300">
                          {rule.condition}
                        </span>
                        <span className="rounded-full bg-teal-300/10 px-2 py-1 font-medium text-teal-100">
                          {formatStatus(rule.action)}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        {rule.runsThisMonth} run{rule.runsThisMonth === 1 ? "" : "s"} this month ·{" "}
                        {rule.lastRunAt
                          ? `last ran ${new Date(rule.lastRunAt).toLocaleString()}`
                          : "never run"}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <button
                          type="button"
                          onClick={() => void toggleEnabled(rule)}
                          className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                            rule.enabled
                              ? "border-teal-300/30 bg-teal-300/10 text-teal-100 hover:bg-teal-300/20"
                              : "border-white/10 bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
                          }`}
                        >
                          {rule.enabled ? "Enabled" : "Disabled"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteRule(rule)}
                          aria-label={`Delete ${rule.name}`}
                          className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition-colors hover:bg-rose-400/20"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* ── Right column: AI Studio + Manual form ── */}
        <div className="flex flex-col gap-6">
          {/* ── AI Policy Studio ── */}
          {canManage && (
            <SectionCard>
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <Sparkles size={18} className="text-teal-300" />
                Policy studio
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Describe an automation policy in plain English. The AI will interpret
                it into a structured rule for your review.
              </p>

              <div className="mt-4">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Policy description
                </label>
                <textarea
                  value={policy}
                  onChange={(e) => {
                    // Respect backend max length
                    if (e.target.value.length <= POLICY_MAX_LENGTH) {
                      setPolicy(e.target.value);
                      // Clear stale interpretation state when policy changes
                      if (draft) {
                        setDraft(null);
                        setDraftSaveError(null);
                      }
                      if (interpretError) {
                        setInterpretError(null);
                      }
                    }
                  }}
                  disabled={interpreting || draftSaving}
                  placeholder="e.g. When a task becomes overdue, notify the manager automatically."
                  rows={4}
                  className="mt-1 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600 resize-none"
                />
                <p
                  className={`mt-1 text-right text-[11px] ${
                    policyCharsLeft < 100 ? "text-amber-400" : "text-slate-600"
                  }`}
                >
                  {policyCharsLeft} characters remaining
                </p>
              </div>

              {interpretError && (
                <div className="mt-2">
                  <InlineError message={interpretError} />
                </div>
              )}

              <button
                type="button"
                onClick={() => void interpretPolicy()}
                disabled={!canInterpret}
                className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-slate-500"
              >
                <Sparkles size={16} />
                {interpreting ? "Interpreting…" : "Interpret policy"}
              </button>

              {/* D-8: post-save confirmation that the rule is inert for now. */}
              {draftSavedNotice && (
                <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-3">
                  <AlertTriangle
                    size={14}
                    className="mt-0.5 shrink-0 text-amber-300"
                  />
                  <p className="text-xs leading-5 text-amber-100/90">
                    {draftSavedNotice}
                  </p>
                </div>
              )}

              {/* Draft preview — only shown after a successful interpretation */}
              {draft && (
                <PolicyDraftCard
                  result={draft}
                  saveError={draftSaveError}
                  saving={draftSaving}
                  onSave={() => void saveDraft()}
                  onDiscard={discardDraft}
                />
              )}
            </SectionCard>
          )}

          {/* ── Manual rule form ── */}
          <SectionCard>
            <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
              <Plus size={18} className="text-teal-300" />
              New rule
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Conditions support <span className="font-mono text-slate-300">status</span> and{" "}
              <span className="font-mono text-slate-300">priority</span> (e.g.{" "}
              <span className="font-mono text-slate-300">status == DONE</span>).
            </p>

            <form onSubmit={createRule} className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Name
                </label>
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  disabled={!canManage}
                  placeholder="Advance milestone on completion"
                  className="mt-1 h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Description
                </label>
                <input
                  value={form.description}
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                  disabled={!canManage}
                  placeholder="Optional"
                  className="mt-1 h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Trigger
                </label>
                <select
                  value={form.trigger}
                  onChange={(event) =>
                    setForm({ ...form, trigger: event.target.value as AutomationTrigger })
                  }
                  disabled={!canManage}
                  className="mt-1 h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                >
                  {TRIGGERS.map((trigger) => (
                    <option key={trigger} value={trigger} className="bg-slate-950 text-white">
                      {formatStatus(trigger)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Condition
                </label>
                <input
                  value={form.condition}
                  onChange={(event) => setForm({ ...form, condition: event.target.value })}
                  disabled={!canManage}
                  placeholder="status == DONE"
                  className="mt-1 h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 font-mono text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Action
                </label>
                <select
                  value={form.action}
                  onChange={(event) =>
                    setForm({ ...form, action: event.target.value as AutomationAction })
                  }
                  disabled={!canManage}
                  className="mt-1 h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                >
                  {ACTIONS.map((action) => (
                    <option key={action} value={action} className="bg-slate-950 text-white">
                      {formatStatus(action)}
                    </option>
                  ))}
                </select>
              </div>

              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  disabled={!canManage}
                  onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                  className="h-5 w-5 accent-teal-300"
                />
                <span className="text-sm text-slate-200">Enable immediately</span>
              </label>

              <PermissionAction role={role} permission="automations:manage" type="submit">
                <Plus size={16} />
                {saving ? "Creating…" : "Create rule"}
              </PermissionAction>
            </form>
          </SectionCard>
        </div>
      </div>
    </AppShell>
  );
}
