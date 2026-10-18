/**
 * Deterministic snapshot fingerprint for What-If simulation concurrency control.
 *
 * ## Why a content fingerprint rather than `project.updatedAt`
 *
 * The original design used `project.updatedAt` as the concurrency token. That
 * cannot work, for a reason that is structural rather than incidental:
 * `Project.updatedAt` is `@updatedAt`, which Prisma advances only when the
 * *Project row itself* is written. Every simulated change writes `Task`,
 * `Milestone` or `TaskDependency` rows instead — and so do the ordinary task and
 * milestone routes. A token derived from `project.updatedAt` is therefore blind
 * to precisely the mutations the simulation depends on, in both directions:
 *
 *   - A concurrent edit to the simulated task leaves the token unchanged, so a
 *     stale proposal applies against state the user never reviewed.
 *   - Applying a proposal leaves the token unchanged, so the same single-use
 *     proposal can be applied repeatedly — duplicating tasks and dependency
 *     edges.
 *
 * Bumping the Project row to compensate was rejected: it would depend on
 * unverified assumptions about how Prisma emits `@updatedAt`, and it would still
 * miss mutations made through every other route, which do not touch that row.
 *
 * This module instead fingerprints the *observed state itself*. Any change to a
 * field the simulation reads produces a different token, whichever code path
 * made the change, with no schema migration and no reliance on timestamp
 * semantics.
 *
 * ## Scope of the fingerprint
 *
 * It covers exactly the entity state the simulation engine consumes: the
 * project's status, and the identity plus the scheduling/assignment/status
 * fields of every task, milestone and dependency edge in scope. Fields the
 * engine never reads (a task's title or description, for instance) are
 * deliberately excluded, so an unrelated edit does not force a pointless
 * re-simulation.
 *
 * Membership is covered as well as field values: ids are part of the digest, so
 * adding or removing a task, milestone or edge changes the token even when the
 * collection size happens to stay the same.
 *
 * ## Determinism
 *
 * Collections are sorted by id before hashing, so Prisma's row order cannot
 * affect the result. Dates are serialised as epoch milliseconds, which avoids
 * both timezone formatting and the `Date`-vs-string ambiguity that appears when
 * the same row arrives from different queries. The digest is SHA-256 hex, 64
 * characters, which fits the 100-character limit the request validators impose.
 *
 * Pure: no Prisma, no I/O, no AI. Safe to call from a transaction.
 */

import { createHash } from "node:crypto";

/**
 * The minimal structural shape the fingerprint needs.
 *
 * Declared locally rather than imported from the intelligence adapter so this
 * module stays inside the pure domain layer. The mapping from a loaded snapshot
 * lives in `src/lib/intelligence/snapshot-token.ts`, in one place, so the
 * simulate and apply paths cannot drift apart.
 */
export type SnapshotTokenInput = {
  project: { id: string; status: string };
  tasks: ReadonlyArray<{
    id: string;
    status: string;
    priority: string;
    dueDate: Date | string | null;
    completedAt: Date | string | null;
    assignedToUserId: string | null;
  }>;
  milestones: ReadonlyArray<{
    id: string;
    status: string;
    dueDate: Date | string | null;
  }>;
  dependencies: ReadonlyArray<{
    id: string;
    sourceTaskId: string;
    targetTaskId: string;
    type: string;
  }>;
};

/** Epoch milliseconds, or `-` for absent. Avoids timezone/format drift. */
function stamp(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? "?" : String(time);
}

function byId<T extends { id: string }>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A stable digest of the simulation-relevant state.
 *
 * Equal tokens mean no field the simulation reads has changed. Different tokens
 * mean the reviewed proposal no longer describes the live project.
 */
export function computeSnapshotToken(input: SnapshotTokenInput): string {
  const parts: string[] = [
    `v1`,
    `p:${input.project.id}:${input.project.status}`,
  ];

  for (const task of byId(input.tasks)) {
    parts.push(
      [
        "t",
        task.id,
        task.status,
        task.priority,
        stamp(task.dueDate),
        stamp(task.completedAt),
        task.assignedToUserId ?? "-",
      ].join(":"),
    );
  }

  for (const milestone of byId(input.milestones)) {
    parts.push(["m", milestone.id, milestone.status, stamp(milestone.dueDate)].join(":"));
  }

  for (const edge of byId(input.dependencies)) {
    parts.push(["d", edge.id, edge.sourceTaskId, edge.targetTaskId, edge.type].join(":"));
  }

  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
