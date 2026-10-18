/**
 * What-If Simulation Engine — pure domain module.
 *
 * Given an already-loaded ProjectIntelligenceSnapshot and one SimulationChange,
 * this module:
 *
 *   1. Clones the in-memory state (tasks, milestones, dependencies).
 *   2. Applies the requested change to the clone — **no DB writes**.
 *   3. Re-runs analyzeProjectHealth over the modified state.
 *   4. Computes healthDelta, severity, and verdict **entirely in code**.
 *
 * P0 rules enforced here:
 *   - DB changes only after authorized Apply — never during simulation.
 *   - healthDelta, severity, and verdict are computed by this module.
 *     The model narrates them; it never produces them.
 *   - No AI imports. No Prisma. No React. This is pure and testable.
 *
 * Reused domain functions (not re-implemented):
 *   analyzeProjectHealth   — project-intelligence.ts
 *   blockerIdsFrom         — project-intelligence.ts
 *   buildBlockingGraph     — dependency-risk.ts (not imported; we derive
 *                            blockerIds directly via blockerIdsFrom, which
 *                            uses the same normalized edge logic)
 *   downstreamOf           — dependency-risk.ts (used to count affected tasks)
 */

import {
  analyzeProjectHealth,
  blockerIdsFrom,
  type ProjectIntelligence,
  type HealthBand,
  type IntelTask,
  type IntelMilestone,
} from "@/lib/domain/project-intelligence";
import { downstreamOf, buildBlockingGraph } from "@/lib/domain/dependency-risk";
import type { ScopedDependency } from "@/lib/dependencies/scope";
import type { SimulationChange } from "@/lib/validators";
import type { ProjectIntelligenceSnapshot } from "@/lib/intelligence/project-snapshot";

// ─── Result types ─────────────────────────────────────────────────────────────

export type SimulationSeverity = "none" | "low" | "medium" | "high" | "critical";
export type SimulationVerdict = "safe" | "watch" | "block";

export type SignalChange = {
  name: string;
  before: number;
  after: number;
  delta: number; // negative = more deduction (worse); positive = less deduction (better)
};

export type SimulationDiff = {
  baseline: {
    score: number;
    band: HealthBand;
  };
  modified: {
    score: number;
    band: HealthBand;
  };
  /** Positive = improvement; negative = degradation. */
  healthDelta: number;
  severity: SimulationSeverity;
  verdict: SimulationVerdict;
  bandChanged: boolean;
  affectedTaskCount: number;
  signalChanges: SignalChange[];
};

// ─── State cloning ────────────────────────────────────────────────────────────

function cloneTasks(tasks: IntelTask[]): IntelTask[] {
  return tasks.map((t) => ({ ...t }));
}

function cloneMilestones(milestones: IntelMilestone[]): IntelMilestone[] {
  return milestones.map((m) => ({ ...m }));
}

function cloneDependencies(deps: ScopedDependency[]): ScopedDependency[] {
  return deps.map((d) => ({ ...d }));
}

// ─── Change handlers — each returns the IDs directly changed ────────────────

function applyTaskStatus(
  tasks: IntelTask[],
  taskId: string,
  status: "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE",
  now: Date,
): string[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return [];
  task.status = status;
  task.completedAt = status === "DONE" ? now : null;
  return [taskId];
}

function applyTaskReassign(
  tasks: IntelTask[],
  taskId: string,
  assignedToUserId: string | null,
): string[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return [];
  task.assignedToUserId = assignedToUserId;
  return [taskId];
}

function applyTaskDueDate(
  tasks: IntelTask[],
  taskId: string,
  dueDate: string | null,
): string[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return [];
  task.dueDate = dueDate ? new Date(dueDate) : null;
  return [taskId];
}

function applyTaskAdd(
  tasks: IntelTask[],
  change: Extract<SimulationChange, { type: "task_add" }>,
  now: Date,
): string[] {
  const newTask: IntelTask = {
    id: "sim-new-task",
    title: change.title,
    status: change.status,
    priority: change.priority,
    dueDate: change.dueDate ? new Date(change.dueDate) : null,
    completedAt: change.status === "DONE" ? now : null,
    createdAt: now,
    assignedToUserId: change.assignedToUserId ?? null,
  };
  tasks.push(newTask);
  return ["sim-new-task"];
}

function applyTaskRemove(
  tasks: IntelTask[],
  dependencies: ScopedDependency[],
  taskId: string,
): string[] {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return [];
  tasks.splice(idx, 1);
  // Remove all edges that reference this task (cascade in-memory).
  for (let i = dependencies.length - 1; i >= 0; i--) {
    const d = dependencies[i];
    if (d.sourceTaskId === taskId || d.targetTaskId === taskId) {
      dependencies.splice(i, 1);
    }
  }
  return [taskId];
}

function applyMilestoneDate(
  milestones: IntelMilestone[],
  milestoneId: string,
  dueDate: string,
): string[] {
  const m = milestones.find((ms) => ms.id === milestoneId);
  if (!m) return [];
  m.dueDate = new Date(dueDate);
  return []; // no task IDs directly changed
}

function applyDependencyAdd(
  tasks: IntelTask[],
  dependencies: ScopedDependency[],
  change: Extract<SimulationChange, { type: "dependency_add" }>,
  projectId: string,
): string[] {
  // Validate both endpoints exist in the task list.
  const source = tasks.find((t) => t.id === change.sourceTaskId);
  const target = tasks.find((t) => t.id === change.targetTaskId);
  if (!source || !target) return [];

  dependencies.push({
    id: "sim-dep-new",
    sourceTaskId: change.sourceTaskId,
    targetTaskId: change.targetTaskId,
    type: change.depType,
    sourceProjectId: projectId,
    targetProjectId: projectId,
    crossProject: false,
  });
  return [change.sourceTaskId, change.targetTaskId];
}

function applyDependencyRemove(dependencies: ScopedDependency[], dependencyId: string): string[] {
  const idx = dependencies.findIndex((d) => d.id === dependencyId);
  if (idx === -1) return [];
  const removed = dependencies[idx];
  dependencies.splice(idx, 1);
  return [removed.sourceTaskId, removed.targetTaskId];
}

// ─── Severity + verdict (computed in code — never from model output) ──────────

function computeSeverity(
  healthDelta: number,
  fromBand: HealthBand,
  toBand: HealthBand,
): SimulationSeverity {
  // Band degradation gets at least 'medium' regardless of the raw delta.
  const bandOrder: HealthBand[] = ["Healthy", "Watch", "At risk", "Critical"];
  const bandDelta = bandOrder.indexOf(toBand) - bandOrder.indexOf(fromBand);

  if (healthDelta >= 0 && bandDelta <= 0) return "none";

  if (bandDelta >= 2) return "critical";
  if (bandDelta === 1) return Math.abs(healthDelta) >= 15 ? "high" : "medium";

  // Same band — pure delta rules.
  const abs = Math.abs(healthDelta);
  if (abs < 5) return "low";
  if (abs < 15) return "medium";
  if (abs < 25) return "high";
  return "critical";
}

function computeVerdict(severity: SimulationSeverity): SimulationVerdict {
  if (severity === "none" || severity === "low") return "safe";
  if (severity === "medium") return "watch";
  return "block";
}

// ─── Affected task count — tasks whose reachability/blocker status changed ───

function countAffectedTasks(
  directlyChangedIds: string[],
  deps: ScopedDependency[],
): number {
  if (directlyChangedIds.length === 0) return 0;

  const graph = buildBlockingGraph(deps);
  const affected = new Set(directlyChangedIds);
  for (const id of directlyChangedIds) {
    const downstream = downstreamOf(graph, id);
    downstream.forEach((tid) => affected.add(tid));
  }
  return affected.size;
}

// ─── Signal diff ─────────────────────────────────────────────────────────────

function diffSignals(
  baseline: ProjectIntelligence,
  modified: ProjectIntelligence,
): SignalChange[] {
  // ProjectIntelligence exposes two signal lists: `factors` (signals that cost
  // points) and `healthy` (signals checked but costing nothing). Merge both so
  // we can detect when a signal transitions between the two lists.
  const allBaseline = [...baseline.factors, ...baseline.healthy];
  const allModified = [...modified.factors, ...modified.healthy];

  const byLabel = new Map<string, SignalChange>();

  for (const s of allBaseline) {
    byLabel.set(s.label, { name: s.label, before: s.points, after: 0, delta: 0 });
  }
  for (const s of allModified) {
    const entry = byLabel.get(s.label);
    if (entry) {
      entry.after = s.points;
      entry.delta = entry.before - s.points; // positive = improvement (fewer points deducted)
    } else {
      byLabel.set(s.label, { name: s.label, before: 0, after: s.points, delta: -s.points });
    }
  }

  return [...byLabel.values()].filter((c) => c.delta !== 0).sort((a, b) => a.delta - b.delta);
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Runs a what-if simulation over an already-loaded snapshot.
 *
 * Pure: no async, no DB, no AI. The caller is responsible for loading the
 * snapshot (via `loadProjectIntelligenceSnapshot`) and for passing the result
 * to the AI narration layer.
 */
export function runSimulation(
  snapshot: ProjectIntelligenceSnapshot,
  change: SimulationChange,
  now: Date,
): SimulationDiff {
  // Deep-clone to avoid mutating the snapshot (caller may inspect baseline).
  const tasks = cloneTasks(snapshot.tasks as unknown as IntelTask[]);
  // snapshot.milestones is the raw milestone array loaded alongside tasks;
  // it is now exposed from loadProjectIntelligenceSnapshot so the simulation
  // engine re-runs analyzeProjectHealth with real milestone data rather than [].
  const milestones = cloneMilestones(snapshot.milestones as unknown as IntelMilestone[]);
  const deps = cloneDependencies(snapshot.scopedDependencies);
  const projectId = snapshot.project.id;

  let directlyChangedIds: string[] = [];

  switch (change.type) {
    case "task_status":
      directlyChangedIds = applyTaskStatus(tasks, change.taskId, change.status, now);
      break;
    case "task_reassign":
      directlyChangedIds = applyTaskReassign(tasks, change.taskId, change.assignedToUserId);
      break;
    case "task_due_date":
      directlyChangedIds = applyTaskDueDate(tasks, change.taskId, change.dueDate);
      break;
    case "task_add":
      directlyChangedIds = applyTaskAdd(tasks, change, now);
      break;
    case "task_remove":
      directlyChangedIds = applyTaskRemove(tasks, deps, change.taskId);
      break;
    case "milestone_date":
      applyMilestoneDate(milestones, change.milestoneId, change.dueDate);
      break;
    case "dependency_add":
      directlyChangedIds = applyDependencyAdd(tasks, deps, change, projectId);
      break;
    case "dependency_remove":
      directlyChangedIds = applyDependencyRemove(deps, change.dependencyId);
      break;
  }

  // Recompute health on modified state.
  const openTaskIds = new Set(tasks.filter((t) => t.status !== "DONE").map((t) => t.id));
  const blockerIds = blockerIdsFrom(deps, openTaskIds);
  const modified = analyzeProjectHealth(
    snapshot.project,
    tasks,
    milestones,
    snapshot.scheduleChanges,
    blockerIds,
    now,
  );

  const baseline = snapshot.health;
  const healthDelta = modified.score - baseline.score;
  const severity = computeSeverity(healthDelta, baseline.band, modified.band);
  const verdict = computeVerdict(severity);
  const affectedTaskCount = countAffectedTasks(directlyChangedIds, deps);

  return {
    baseline: { score: baseline.score, band: baseline.band },
    modified: { score: modified.score, band: modified.band },
    healthDelta,
    severity,
    verdict,
    bandChanged: baseline.band !== modified.band,
    affectedTaskCount,
    signalChanges: diffSignals(baseline, modified),
  };
}
