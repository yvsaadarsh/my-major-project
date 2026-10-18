"use client";

import { useState } from "react";
import { Beaker } from "lucide-react";

import { InlineError } from "@/components/page-state";
import { can } from "@/lib/ui/permissions";
import type { Role } from "@/lib/ui/permissions";
import {
  apiRequest,
  ClientApiError,
  type ApplyResult,
  type SimulateResult,
  type SimulationChange,
} from "@/lib/ui/api-client";
import { errorMessage } from "@/lib/ui/error-message";
import { SimulationResultPanel } from "./SimulationDiff";

// ── Constants ─────────────────────────────────────────────────────────────────

const SCENARIO_MAX = 2000;

const CHANGE_TYPE_LABELS: Record<SimulationChange["type"], string> = {
  task_status: "Change task status",
  task_reassign: "Reassign task",
  task_due_date: "Change task due date",
  task_add: "Add new task",
  task_remove: "Remove task",
  milestone_date: "Change milestone date",
  dependency_add: "Add dependency",
  dependency_remove: "Remove dependency",
};

const TASK_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"] as const;
const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
const DEP_TYPES = ["BLOCKS", "DEPENDS_ON", "RELATED_TO"] as const;

type TaskStatus = (typeof TASK_STATUSES)[number];
type TaskPriority = (typeof TASK_PRIORITIES)[number];
type DepType = (typeof DEP_TYPES)[number];

// ── Form state ────────────────────────────────────────────────────────────────

/**
 * Flat form state covering all 8 change types.
 * Fields are shared where their semantics are the same (e.g. `taskId`).
 */
type ChangeForm = {
  type: SimulationChange["type"];
  // ── used by task_status / task_reassign / task_due_date / task_remove
  taskId: string;
  // ── task_status
  status: TaskStatus;
  // ── task_reassign  (empty string → unassign / null)
  assignedToUserId: string;
  // ── task_due_date  (empty string → remove due date / null)
  dueDate: string;
  // ── task_add
  title: string;
  addStatus: TaskStatus;
  priority: TaskPriority;
  addDueDate: string;
  addAssigneeId: string;
  // ── milestone_date
  milestoneId: string;
  milestoneDate: string;
  // ── dependency_add
  sourceTaskId: string;
  targetTaskId: string;
  depType: DepType;
  // ── dependency_remove
  dependencyId: string;
};

const DEFAULT_FORM: ChangeForm = {
  type: "task_status",
  taskId: "",
  status: "DONE",
  assignedToUserId: "",
  dueDate: "",
  title: "",
  addStatus: "TODO",
  priority: "MEDIUM",
  addDueDate: "",
  addAssigneeId: "",
  milestoneId: "",
  milestoneDate: "",
  sourceTaskId: "",
  targetTaskId: "",
  depType: "BLOCKS",
  dependencyId: "",
};

// ── Validation helper ─────────────────────────────────────────────────────────

/**
 * Builds a typed `SimulationChange` from the form state, or returns `null` if
 * required fields are missing / invalid. Mirrors the Zod schema in
 * `src/lib/validators.ts` — keep in sync if the schema changes.
 */
function buildChange(f: ChangeForm): SimulationChange | null {
  switch (f.type) {
    case "task_status":
      if (!f.taskId.trim()) return null;
      return { type: "task_status", taskId: f.taskId.trim(), status: f.status };

    case "task_reassign":
      if (!f.taskId.trim()) return null;
      return {
        type: "task_reassign",
        taskId: f.taskId.trim(),
        assignedToUserId: f.assignedToUserId.trim() || null,
      };

    case "task_due_date":
      if (!f.taskId.trim()) return null;
      return {
        type: "task_due_date",
        taskId: f.taskId.trim(),
        dueDate: f.dueDate ? new Date(f.dueDate).toISOString() : null,
      };

    case "task_add":
      if (f.title.trim().length < 2) return null;
      return {
        type: "task_add",
        title: f.title.trim(),
        status: f.addStatus,
        priority: f.priority,
        ...(f.addDueDate
          ? { dueDate: new Date(f.addDueDate).toISOString() }
          : {}),
        ...(f.addAssigneeId.trim()
          ? { assignedToUserId: f.addAssigneeId.trim() }
          : {}),
      };

    case "task_remove":
      if (!f.taskId.trim()) return null;
      return { type: "task_remove", taskId: f.taskId.trim() };

    case "milestone_date":
      if (!f.milestoneId.trim() || !f.milestoneDate) return null;
      return {
        type: "milestone_date",
        milestoneId: f.milestoneId.trim(),
        dueDate: new Date(f.milestoneDate).toISOString(),
      };

    case "dependency_add": {
      const src = f.sourceTaskId.trim();
      const tgt = f.targetTaskId.trim();
      if (!src || !tgt || src === tgt) return null;
      return {
        type: "dependency_add",
        sourceTaskId: src,
        targetTaskId: tgt,
        depType: f.depType,
      };
    }

    case "dependency_remove":
      if (!f.dependencyId.trim()) return null;
      return { type: "dependency_remove", dependencyId: f.dependencyId.trim() };
  }
}

// ── Shared input styles ───────────────────────────────────────────────────────

const INPUT_CLS =
  "w-full rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:border-teal-300/30 focus:outline-none transition-colors";

const SELECT_CLS =
  "w-full rounded-xl border border-white/10 bg-[#1a1f2e] px-3 py-2 text-sm text-slate-200 focus:border-teal-300/30 focus:outline-none transition-colors";

const LABEL_CLS =
  "block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1";

// ── Sub-components ────────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className={LABEL_CLS}>{label}</p>
      {children}
    </div>
  );
}

// ── Dynamic change fields ─────────────────────────────────────────────────────

function ChangeFields({
  form,
  setForm,
}: {
  form: ChangeForm;
  setForm: React.Dispatch<React.SetStateAction<ChangeForm>>;
}) {
  function set<K extends keyof ChangeForm>(key: K, value: ChangeForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  switch (form.type) {
    case "task_status":
      return (
        <>
          <Field label="Task ID">
            <input
              className={INPUT_CLS}
              placeholder="Paste the task ID"
              value={form.taskId}
              onChange={(e) => set("taskId", e.target.value)}
            />
          </Field>
          <Field label="New status">
            <select
              className={SELECT_CLS}
              value={form.status}
              onChange={(e) => set("status", e.target.value as TaskStatus)}
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
        </>
      );

    case "task_reassign":
      return (
        <>
          <Field label="Task ID">
            <input
              className={INPUT_CLS}
              placeholder="Paste the task ID"
              value={form.taskId}
              onChange={(e) => set("taskId", e.target.value)}
            />
          </Field>
          <Field label="Assignee user ID (leave blank to unassign)">
            <input
              className={INPUT_CLS}
              placeholder="Paste the user ID, or leave blank"
              value={form.assignedToUserId}
              onChange={(e) => set("assignedToUserId", e.target.value)}
            />
          </Field>
        </>
      );

    case "task_due_date":
      return (
        <>
          <Field label="Task ID">
            <input
              className={INPUT_CLS}
              placeholder="Paste the task ID"
              value={form.taskId}
              onChange={(e) => set("taskId", e.target.value)}
            />
          </Field>
          <Field label="New due date (leave blank to remove)">
            <input
              type="datetime-local"
              className={INPUT_CLS}
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </Field>
        </>
      );

    case "task_add":
      return (
        <>
          <Field label="Title (min 2 chars)">
            <input
              className={INPUT_CLS}
              placeholder="What needs to be done?"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Status">
              <select
                className={SELECT_CLS}
                value={form.addStatus}
                onChange={(e) => set("addStatus", e.target.value as TaskStatus)}
              >
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select
                className={SELECT_CLS}
                value={form.priority}
                onChange={(e) =>
                  set("priority", e.target.value as TaskPriority)
                }
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Due date (optional)">
            <input
              type="datetime-local"
              className={INPUT_CLS}
              value={form.addDueDate}
              onChange={(e) => set("addDueDate", e.target.value)}
            />
          </Field>
          <Field label="Assignee user ID (optional)">
            <input
              className={INPUT_CLS}
              placeholder="Paste a user ID"
              value={form.addAssigneeId}
              onChange={(e) => set("addAssigneeId", e.target.value)}
            />
          </Field>
        </>
      );

    case "task_remove":
      return (
        <Field label="Task ID">
          <input
            className={INPUT_CLS}
            placeholder="Paste the task ID to remove"
            value={form.taskId}
            onChange={(e) => set("taskId", e.target.value)}
          />
        </Field>
      );

    case "milestone_date":
      return (
        <>
          <Field label="Milestone ID">
            <input
              className={INPUT_CLS}
              placeholder="Paste the milestone ID"
              value={form.milestoneId}
              onChange={(e) => set("milestoneId", e.target.value)}
            />
          </Field>
          <Field label="New due date">
            <input
              type="datetime-local"
              className={INPUT_CLS}
              value={form.milestoneDate}
              onChange={(e) => set("milestoneDate", e.target.value)}
            />
          </Field>
        </>
      );

    case "dependency_add":
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Source task ID">
              <input
                className={INPUT_CLS}
                placeholder="Paste the source task ID"
                value={form.sourceTaskId}
                onChange={(e) => set("sourceTaskId", e.target.value)}
              />
            </Field>
            <Field label="Target task ID">
              <input
                className={INPUT_CLS}
                placeholder="Paste the target task ID"
                value={form.targetTaskId}
                onChange={(e) => set("targetTaskId", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Dependency type">
            <select
              className={SELECT_CLS}
              value={form.depType}
              onChange={(e) => set("depType", e.target.value as DepType)}
            >
              {DEP_TYPES.map((d) => (
                <option key={d} value={d}>
                  {d.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
        </>
      );

    case "dependency_remove":
      return (
        <Field label="Dependency ID">
          <input
            className={INPUT_CLS}
            placeholder="Paste the dependency ID to remove"
            value={form.dependencyId}
            onChange={(e) => set("dependencyId", e.target.value)}
          />
        </Field>
      );
  }
}

// ── Workspace (main export) ───────────────────────────────────────────────────

type SimulationWorkspaceProps = {
  projectId: string;
  role: string | undefined;
  /** Called after a successful Apply so the parent can re-fetch intelligence. */
  onApplied: () => void;
};

/**
 * What-If Simulation Workspace.
 *
 * - Renders nothing if the current user lacks `projects:simulate`.
 * - The scenario (natural language) and structured change are both required by
 *   the backend simulate route, so the UI collects both.
 * - The snapshot token is fetched lazily from the project endpoint at simulate
 *   time; this guarantees the token is as fresh as possible and avoids
 *   complicating the parent's load function.
 * - Simulation and Apply are always explicit and separate. No auto-apply.
 * - All hooks are called unconditionally (React rules); the permission guard
 *   gates the rendered JSX, not the hook calls.
 */
export function SimulationWorkspace({
  projectId,
  role,
  onApplied,
}: SimulationWorkspaceProps) {
  // ── Permission gate ───────────────────────────────────────────────────────
  const canSimulate = role ? can(role as Role, "projects:simulate") : false;

  // ── State (all hooks before any conditional JSX) ──────────────────────────
  const [scenario, setScenario] = useState("");
  const [form, setForm] = useState<ChangeForm>({ ...DEFAULT_FORM });

  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [simResult, setSimResult] = useState<SimulateResult | null>(null);
  /** The structured change that produced the current result — sent to Apply. */
  const [pendingChange, setPendingChange] =
    useState<SimulationChange | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [staleError, setStaleError] = useState<string | null>(null);

  // ── Don't render for users without simulate permission ────────────────────
  if (!canSimulate) return null;

  // ── Derived ───────────────────────────────────────────────────────────────
  const change = buildChange(form);
  const canSubmit = scenario.trim().length > 0 && change !== null && !simulating;
  const normalizedRole = (role ?? "MEMBER") as Role;
  const remaining = SCENARIO_MAX - scenario.length;

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function runSimulation() {
    if (!canSubmit || !change) return;

    setSimulating(true);
    setSimError(null);
    setSimResult(null);
    setPendingChange(null);
    setApplyError(null);
    setStaleError(null);

    // No snapshot token is sent: the simulate endpoint derives it server-side
    // from the state it actually simulated, so the client has nothing
    // authoritative to contribute and the extra project fetch this used to do
    // is gone.
    try {
      const result = await apiRequest<SimulateResult>(
        `/api/v1/intelligence/projects/${projectId}/simulate`,
        {
          method: "POST",
          body: { scenario: scenario.trim(), change },
        },
      );
      setSimResult(result);
      // Hold the change the *server* validated, not the locally built one, so
      // the object sent to Apply is the one shown in the review panel —
      // including any schema defaults the server filled in.
      setPendingChange(
        result.status === "simulated" ? result.change : null,
      );
    } catch (err) {
      if (err instanceof ClientApiError) {
        if (err.status === 501) {
          setSimError("AI simulation is not configured for this deployment.");
        } else if (err.status === 403) {
          setSimError("You don't have permission to run simulations.");
        } else {
          setSimError(err.message);
        }
      } else {
        setSimError(errorMessage(err, "Simulation failed — please try again."));
      }
    } finally {
      setSimulating(false);
    }
  }

  async function applySimulation() {
    if (
      !simResult ||
      simResult.status !== "simulated" ||
      !pendingChange
    )
      return;

    setApplying(true);
    setApplyError(null);
    setStaleError(null);

    try {
      await apiRequest<ApplyResult>(
        `/api/v1/intelligence/projects/${projectId}/apply`,
        {
          method: "POST",
          body: {
            change: pendingChange,
            snapshotToken: simResult.snapshotToken,
          },
        },
      );

      // Clear workspace state and notify parent to re-fetch intelligence.
      setSimResult(null);
      setPendingChange(null);
      setScenario("");
      setForm({ ...DEFAULT_FORM });
      onApplied();
    } catch (err) {
      if (err instanceof ClientApiError && err.status === 409) {
        setStaleError(
          "The project was changed after this simulation ran. " +
            "Re-run the simulation to work from the current state.",
        );
      } else if (err instanceof ClientApiError && err.status === 403) {
        setApplyError("You don't have permission to apply changes.");
      } else {
        setApplyError(
          errorMessage(err, "Failed to apply the change — please try again."),
        );
      }
    } finally {
      setApplying(false);
    }
  }

  function discardResult() {
    setSimResult(null);
    setPendingChange(null);
    setApplyError(null);
    setStaleError(null);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="mt-6">
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        {/* Header */}
        <div className="flex items-center gap-2.5">
          <Beaker size={18} className="shrink-0 text-teal-300" aria-hidden />
          <h2 className="text-xl font-semibold text-white">
            What-If Simulation
          </h2>
        </div>
        <p className="mt-1 text-sm text-slate-400">
          Describe a hypothetical change and see how it would affect project
          health — before committing anything.
        </p>

        {/* Input form */}
        {!simResult && (
          <div className="mt-5 space-y-4">
            {/* Scenario textarea */}
            <div>
              <div className="flex items-center justify-between">
                <p className={LABEL_CLS}>Describe the scenario</p>
                <span
                  className={`text-[10px] tabular-nums ${
                    remaining < 100 ? "text-amber-300" : "text-slate-600"
                  }`}
                >
                  {remaining} left
                </span>
              </div>
              <textarea
                className={`${INPUT_CLS} min-h-[80px] resize-y`}
                placeholder="e.g. &ldquo;What if we mark the API integration task as done and move the deadline to next Friday?&rdquo;"
                maxLength={SCENARIO_MAX}
                value={scenario}
                onChange={(e) => setScenario(e.target.value)}
                disabled={simulating}
              />
            </div>

            {/* Change type selector */}
            <div>
              <p className={LABEL_CLS}>Change type</p>
              <select
                className={SELECT_CLS}
                value={form.type}
                onChange={(e) =>
                  setForm({
                    ...DEFAULT_FORM,
                    type: e.target.value as SimulationChange["type"],
                  })
                }
                disabled={simulating}
              >
                {(Object.keys(CHANGE_TYPE_LABELS) as SimulationChange["type"][]).map(
                  (t) => (
                    <option key={t} value={t}>
                      {CHANGE_TYPE_LABELS[t]}
                    </option>
                  ),
                )}
              </select>
            </div>

            {/* Dynamic fields for the selected change type */}
            <div
              className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3"
              aria-label={`Fields for ${CHANGE_TYPE_LABELS[form.type]}`}
            >
              <ChangeFields form={form} setForm={setForm} />
            </div>

            {/* Simulate button */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={runSimulation}
                disabled={!canSubmit}
                className="inline-flex h-9 items-center gap-2 rounded-xl bg-teal-300 px-4 text-xs font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {simulating ? (
                  <>
                    <span
                      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-950 border-t-transparent"
                      aria-hidden
                    />
                    Simulating…
                  </>
                ) : (
                  <>
                    <Beaker size={13} aria-hidden />
                    Run simulation
                  </>
                )}
              </button>
              {!canSubmit && !simulating && (
                <p className="text-xs text-slate-500">
                  {scenario.trim().length === 0
                    ? "Describe the scenario to continue."
                    : "Fill in all required change fields."}
                </p>
              )}
            </div>

            {/* Request error */}
            {simError && <InlineError message={simError} />}
          </div>
        )}

        {/* Simulation result */}
        {simResult && (
          <SimulationResultPanel
            result={simResult}
            role={normalizedRole}
            applying={applying}
            applyError={applyError}
            staleError={staleError}
            onApply={applySimulation}
            onDiscard={discardResult}
          />
        )}
      </div>
    </div>
  );
}
