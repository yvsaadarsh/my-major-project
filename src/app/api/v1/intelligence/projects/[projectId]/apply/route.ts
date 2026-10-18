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
 *   4. Stale-write detection: reject if project.updatedAt has changed since
 *      the simulation (snapshotToken mismatch).
 *   5. Execute the change transactionally in Prisma.
 *   6. Record an ActivityLog audit entry in the same transaction.
 *   7. Return 200 with the updated project.updatedAt (the new snapshot token).
 *
 * P0 rules enforced:
 *   - This is the ONLY place a simulation result ever writes to the database.
 *   - Model output is never consulted here. The change schema is re-validated
 *     from the client's payload; the model had no path to mutate it.
 *   - snapshotToken is project.updatedAt.toISOString(). Mismatch → 409.
 *   - All DB writes are tenant-scoped (organizationId filter on every query).
 *   - task.create uses tenant.user.id as createdByUserId — never a model value.
 */

import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard, type RouteContext } from "@/lib/api/tenant-guard";
import { Permission } from "@/lib/rbac";
import { applySimulationSchema, type SimulationChange } from "@/lib/validators";
import { requireProjectForTenant } from "@/lib/tenant/queries";
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
    const project = await requireProjectForTenant(organizationId, projectId);

    // ── 3. Stale-write detection ──────────────────────────────────────────────
    //
    // The simulation captured project.updatedAt as its snapshotToken. If the
    // project has been modified since (by another user, or another Apply),
    // the token won't match and we reject with 409 Conflict.
    //
    // This is a first-writer-wins strategy: the second Apply must re-simulate
    // from the current state before it can apply.
    const liveToken = project.updatedAt.toISOString();
    if (liveToken !== snapshotToken) {
      return json(
        {
          error: "snapshot_stale",
          message:
            "The project was updated after this simulation ran. Re-run the simulation from the current project state before applying.",
          currentToken: liveToken,
        },
        409,
      );
    }

    // ── 4. Execute + audit (single transaction) ───────────────────────────────
    await prisma.$transaction(async (tx: TxClient) => {
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
    });

    // ── 5. Return the new project state ──────────────────────────────────────
    //
    // Re-fetch to get the new updatedAt (Prisma sets it after the transaction).
    const updated = await requireProjectForTenant(organizationId, projectId);

    return json({
      applied: true,
      changeType: change.type,
      newSnapshotToken: updated.updatedAt.toISOString(),
    });
  },
);
