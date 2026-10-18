/**
 * POST /api/v1/intelligence/projects/:projectId/apply
 *
 * What-If Simulation — Feature 1, Phase 5 (Safe Apply).
 *
 * Applies the exact change from a previous simulation to the live database,
 * inside a single Prisma transaction. Guards every step:
 *
 *   1. Auth + permission (projects:apply — ADMIN/MANAGER only).
 *   2. Parse + Zod-validate the request body.
 *   3. Re-fetch the project through requireProjectForTenant — 404 if the
 *      project was deleted or belongs to another tenant since simulation.
 *   4. Open a Serializable transaction and, inside it:
 *      a. Recompute the snapshot fingerprint from the live rows and reject a
 *         mismatch with 409 before mutating anything.
 *      b. Execute the change.
 *      c. Record an ActivityLog audit entry.
 *      d. Recompute the fingerprint and return it as the new token.
 *
 * P0 rules enforced:
 *   - This is the ONLY place a simulation result ever writes to the database.
 *   - Model output is never consulted here. The change schema is re-validated
 *     from the client's payload; the model had no path to mutate it.
 *   - snapshotToken is a content fingerprint of the simulation-relevant state
 *     (see @/lib/domain/simulation/snapshot-token for why project.updatedAt
 *     cannot serve this purpose). Mismatch → 409.
 *   - The freshness check runs inside the transaction, through the transaction
 *     client, so no Apply can commit between the check and the write.
 *   - Each proposal is single-use: applying it changes the state it
 *     fingerprints, so a replay is rejected rather than duplicating rows.
 *   - All DB writes are tenant-scoped (organizationId filter on every query).
 *   - task_add validates that any milestone belongs to this project, not merely
 *     to this organization.
 *   - task.create uses tenant.user.id as createdByUserId — never a model value.
 */

import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard, type RouteContext } from "@/lib/api/tenant-guard";
import { Permission } from "@/lib/rbac";
import { applySimulationSchema, type SimulationChange } from "@/lib/validators";
import { requireProjectForTenant } from "@/lib/tenant/queries";
import { readSnapshotToken } from "@/lib/intelligence/snapshot-token";
import { prisma } from "@/lib/db";

// ─── Change executor — one function per change type ───────────────────────────

// Prisma's interactive-transaction client type. Using a structural type here
// avoids importing from the generated client path directly (which may not exist
// in every tsc environment) while still giving the function a typed parameter.
type TxClient = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

async function executeChange(
  tx: TxClient,
  change: SimulationChange,
  organizationId: string,
  projectId: string,
  actorUserId: string,
  now: Date,
): Promise<void> {
  switch (change.type) {
    case "task_status": {
      const result = await tx.task.updateMany({
        where: { id: change.taskId, organizationId, projectId },
        data: {
          status: change.status,
          completedAt: change.status === "DONE" ? now : null,
        },
      });
      if (result.count === 0) {
        throw new ApiError(404, "task_not_found", "Task not found in this project.");
      }
      break;
    }

    case "task_reassign": {
      const result = await tx.task.updateMany({
        where: { id: change.taskId, organizationId, projectId },
        data: { assignedToUserId: change.assignedToUserId },
      });
      if (result.count === 0) {
        throw new ApiError(404, "task_not_found", "Task not found in this project.");
      }
      break;
    }

    case "task_due_date": {
      const result = await tx.task.updateMany({
        where: { id: change.taskId, organizationId, projectId },
        data: { dueDate: change.dueDate ? new Date(change.dueDate) : null },
      });
      if (result.count === 0) {
        throw new ApiError(404, "task_not_found", "Task not found in this project.");
      }
      break;
    }

    case "task_add": {
      // D-4: the composite FK on (milestoneId, organizationId) proves the
      // milestone belongs to this *organization*, not to this *project*, so a
      // milestone from a sibling project would be accepted by the database.
      // This mirrors the guard in POST /projects/:projectId/tasks, including
      // its error code, rather than trusting an organization-only key.
      if (change.milestoneId) {
        const milestoneCount = await tx.milestone.count({
          where: {
            id: change.milestoneId,
            organizationId,
            projectId,
          },
        });
        if (milestoneCount !== 1) {
          throw new ApiError(
            422,
            "invalid_milestone",
            "The milestone must belong to this project and organization.",
          );
        }
      }

      await tx.task.create({
        data: {
          organizationId,
          projectId,
          title: change.title,
          status: change.status,
          priority: change.priority,
          dueDate: change.dueDate ? new Date(change.dueDate) : null,
          assignedToUserId: change.assignedToUserId ?? null,
          milestoneId: change.milestoneId ?? null,
          createdByUserId: actorUserId,
        },
      });
      break;
    }

    case "task_remove": {
      // Verify ownership before delete (deleteMany is the tenant-safe path).
      const result = await tx.task.deleteMany({
        where: { id: change.taskId, organizationId, projectId },
      });
      if (result.count === 0) {
        throw new ApiError(404, "task_not_found", "Task not found or already removed.");
      }
      break;
    }

    case "milestone_date": {
      const result = await tx.milestone.updateMany({
        where: { id: change.milestoneId, organizationId, projectId },
        data: { dueDate: new Date(change.dueDate) },
      });
      if (result.count === 0) {
        throw new ApiError(404, "milestone_not_found", "Milestone not found in this project.");
      }
      break;
    }

    case "dependency_add": {
      // Verify both tasks belong to this org (composite FK enforces it at the
      // DB level, but a 422 is friendlier than a constraint violation).
      const [source, target] = await Promise.all([
        tx.task.findFirst({ where: { id: change.sourceTaskId, organizationId }, select: { id: true } }),
        tx.task.findFirst({ where: { id: change.targetTaskId, organizationId }, select: { id: true } }),
      ]);
      if (!source) throw new ApiError(404, "task_not_found", "Source task not found.");
      if (!target) throw new ApiError(404, "task_not_found", "Target task not found.");

      await tx.taskDependency.create({
        data: {
          organizationId,
          sourceTaskId: change.sourceTaskId,
          targetTaskId: change.targetTaskId,
          type: change.depType,
          createdByUserId: actorUserId,
        },
      });
      break;
    }

    case "dependency_remove": {
      const result = await tx.taskDependency.deleteMany({
        where: { id: change.dependencyId, organizationId },
      });
      if (result.count === 0) {
        throw new ApiError(
          404,
          "dependency_not_found",
          "Dependency not found or already removed.",
        );
      }
      break;
    }

    default: {
      // TypeScript exhaustiveness guard — should never reach here.
      // Cast silences the implicit-any from the generated union type when
      // Prisma/Zod types don't fully resolve in the tsc environment.
      const _exhaustive: never = change as never;
      void _exhaustive;
      throw new ApiError(400, "unsupported_change_type", "Unsupported change type.");
    }
  }
}

// ─── Concurrency control ──────────────────────────────────────────────────────

/**
 * Raised inside the transaction when the live fingerprint no longer matches the
 * one the proposal was reviewed against. Throwing (rather than returning) is
 * what rolls the transaction back before any mutation is committed.
 */
class StaleSnapshotError extends Error {
  constructor(readonly currentToken: string) {
    super("snapshot_stale");
    this.name = "StaleSnapshotError";
  }
}

/**
 * True for Prisma's write-conflict / deadlock error.
 *
 * Under `Serializable`, Postgres aborts one of two transactions that read and
 * then wrote the same rows. Prisma surfaces that as `P2034`; the underlying
 * SQLSTATEs are 40001 (serialization failure) and 40P01 (deadlock). Checked
 * structurally so this route need not import the generated client, whose types
 * are unavailable in some environments.
 */
function isWriteConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2034" || code === "40001" || code === "40P01";
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const POST = withTenantGuard<{ projectId: string }>(
  Permission.ProjectsApplySimulation,
  async (request, tenant, context: RouteContext<{ projectId: string }>) => {
    const { projectId } = await context.params;
    const now = new Date();
    const organizationId = tenant.tenantId;
    const actorUserId = tenant.user.id;

    // ── 1. Parse + validate request body ──────────────────────────────────────
    const { change, snapshotToken } = await parseJson(request, applySimulationSchema);

    // ── 2. Re-fetch project — 404 if deleted or wrong tenant ─────────────────
    //
    // Kept as an explicit gate so a wrong-tenant or deleted project fails with
    // 404 before any transaction is opened.
    await requireProjectForTenant(organizationId, projectId);

    // ── 3+4. Verify freshness and execute, in one serializable transaction ───
    //
    // Both halves must happen inside the same transaction, and the freshness
    // check must read through the transaction client. Checking first and then
    // opening a transaction leaves a window in which another Apply commits
    // between the two, which is the race the previous implementation had.
    //
    // `Serializable` is what closes that window. The check reads the task,
    // milestone and dependency rows and then writes them; if a competing Apply
    // does the same concurrently, Postgres aborts one with a write conflict
    // rather than letting both commit. That is reported as 409, exactly like a
    // stale token, because the user's remedy is identical: re-simulate.
    //
    // Single-use falls out of the same mechanism. The fingerprint covers the
    // state each change type mutates, so a committed Apply necessarily changes
    // it — replaying the same proposal recomputes a different live token and is
    // rejected. That is what prevents duplicate tasks and duplicate dependency
    // edges on a repeated request.
    let newSnapshotToken: string;

    try {
      newSnapshotToken = await prisma.$transaction(
        async (tx: TxClient) => {
          const liveToken = await readSnapshotToken(tx, organizationId, projectId);

          if (liveToken !== snapshotToken) {
            throw new StaleSnapshotError(liveToken);
          }

          await executeChange(tx, change, organizationId, projectId, actorUserId, now);

          // Audit trail — every Apply is recorded regardless of change type.
          await tx.activityLog.create({
            data: {
              organizationId,
              actorUserId,
              entityType: "project",
              entityId: projectId,
              action: "project.simulation_applied",
              metadata: {
                changeType: change.type,
                snapshotToken,
              },
            },
          });

          // Recomputed from the post-change state inside the same transaction,
          // so the caller receives a token for exactly what was committed.
          return readSnapshotToken(tx, organizationId, projectId);
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (error instanceof StaleSnapshotError) {
        return json(
          {
            error: "snapshot_stale",
            message:
              "The project changed after this simulation ran. Re-run the simulation from the current project state before applying.",
            currentToken: error.currentToken,
          },
          409,
        );
      }

      if (isWriteConflict(error)) {
        return json(
          {
            error: "snapshot_stale",
            message:
              "Another change was applied to this project at the same time. Re-run the simulation from the current project state before applying.",
          },
          409,
        );
      }

      throw error;
    }

    // ── 5. Return the new fingerprint ────────────────────────────────────────
    return json({
      applied: true,
      changeType: change.type,
      newSnapshotToken,
    });
  },
);
