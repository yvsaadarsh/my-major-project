/**
 * The two ways a simulation snapshot token is obtained, side by side.
 *
 * The token is a fingerprint of simulation-relevant project state (see
 * `@/lib/domain/simulation/snapshot-token`). It is produced in two places and
 * must agree exactly, or every Apply would look stale:
 *
 *   - `tokenInputFromSnapshot` — at simulate time, mapped from the intelligence
 *     snapshot the route has already loaded. No additional queries.
 *   - `readTokenInput` — at apply time, read with the *transaction* client so
 *     the staleness check and the mutation observe the same database snapshot.
 *
 * They live in one file on purpose. Both produce the same `SnapshotTokenInput`,
 * and the field lists below are the contract: **a field added to one must be
 * added to the other**, or the two paths will hash different things and Apply
 * will reject every proposal.
 *
 * The dependency edge set is scoped with the shared helpers from
 * `@/lib/dependencies/scope`, so the fingerprint covers the same two-sided edge
 * list the simulation itself analysed, including inbound cross-project edges.
 */

import {
  computeSnapshotToken,
  type SnapshotTokenInput,
} from "@/lib/domain/simulation/snapshot-token";
import {
  DEPENDENCY_SCOPE_SELECT,
  dependenciesRelevantToProject,
  flattenDependencies,
} from "@/lib/dependencies/scope";
import { ApiError } from "@/lib/api/http";

/**
 * Minimal structural view of a Prisma-like client.
 *
 * The public functions take `unknown` and narrow to this once, rather than
 * declaring it as their parameter type. That is deliberate: the generated
 * client's delegate types are unavailable in some environments (the generated
 * path resolves to an error type), and an interactive-transaction client is an
 * `Omit<...>` of it, so a structural parameter type fails to match for reasons
 * that have nothing to do with the call being correct. Narrowing in one place
 * keeps the assumption explicit and contained.
 */
type ReaderClient = {
  project: { findFirst(args: unknown): Promise<unknown> };
  task: { findMany(args: unknown): Promise<unknown> };
  milestone: { findMany(args: unknown): Promise<unknown> };
  taskDependency: { findMany(args: unknown): Promise<unknown> };
};

/** The task fields that feed the fingerprint. Keep in step with the mapper. */
const TASK_TOKEN_SELECT = {
  id: true,
  status: true,
  priority: true,
  dueDate: true,
  completedAt: true,
  assignedToUserId: true,
} as const;

/** The milestone fields that feed the fingerprint. */
const MILESTONE_TOKEN_SELECT = {
  id: true,
  status: true,
  dueDate: true,
} as const;

/**
 * Map an already-loaded intelligence snapshot onto the fingerprint input.
 *
 * Used by the simulate route, which has the snapshot in hand — so the token it
 * returns is a pure function of the exact state the diff was computed from.
 */
export function tokenInputFromSnapshot(snapshot: {
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
  scopedDependencies: ReadonlyArray<{
    id: string;
    sourceTaskId: string;
    targetTaskId: string;
    type: string;
  }>;
}): SnapshotTokenInput {
  return {
    project: { id: snapshot.project.id, status: snapshot.project.status },
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      completedAt: task.completedAt,
      assignedToUserId: task.assignedToUserId,
    })),
    milestones: snapshot.milestones.map((milestone) => ({
      id: milestone.id,
      status: milestone.status,
      dueDate: milestone.dueDate,
    })),
    dependencies: snapshot.scopedDependencies.map((edge) => ({
      id: edge.id,
      sourceTaskId: edge.sourceTaskId,
      targetTaskId: edge.targetTaskId,
      type: edge.type,
    })),
  };
}

/**
 * Read the fingerprint input directly, tenant- and project-scoped.
 *
 * Pass the interactive-transaction client at apply time so the read joins the
 * transaction: with `Serializable` isolation, that is what lets Postgres detect
 * a competing Apply that mutated the same rows.
 *
 * Throws 404 for a missing or wrong-tenant project, matching the rest of the
 * tenant-scoped loaders — a guessed id is indistinguishable from a nonexistent
 * one.
 */
export async function readTokenInput(
  queryClient: unknown,
  organizationId: string,
  projectId: string,
): Promise<SnapshotTokenInput> {
  const client = queryClient as ReaderClient;

  const project = (await client.project.findFirst({
    where: { id: projectId, organizationId },
    select: { id: true, status: true },
  })) as { id: string; status: string } | null;

  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found.");
  }

  const [tasks, milestones, dependencies] = await Promise.all([
    client.task.findMany({
      where: { organizationId, projectId },
      select: TASK_TOKEN_SELECT,
    }) as Promise<SnapshotTokenInput["tasks"]>,
    client.milestone.findMany({
      where: { organizationId, projectId },
      select: MILESTONE_TOKEN_SELECT,
    }) as Promise<SnapshotTokenInput["milestones"]>,
    client.taskDependency.findMany({
      where: dependenciesRelevantToProject(organizationId, projectId),
      select: DEPENDENCY_SCOPE_SELECT,
    }) as Promise<Parameters<typeof flattenDependencies>[0]>,
  ]);

  return {
    project,
    tasks,
    milestones,
    dependencies: flattenDependencies(dependencies).map((edge) => ({
      id: edge.id,
      sourceTaskId: edge.sourceTaskId,
      targetTaskId: edge.targetTaskId,
      type: edge.type,
    })),
  };
}

/** Fingerprint of an already-loaded snapshot. */
export function snapshotTokenFromSnapshot(
  snapshot: Parameters<typeof tokenInputFromSnapshot>[0],
): string {
  return computeSnapshotToken(tokenInputFromSnapshot(snapshot));
}

/** Fingerprint read live through `client`, inside a transaction if given one. */
export async function readSnapshotToken(
  client: unknown,
  organizationId: string,
  projectId: string,
): Promise<string> {
  return computeSnapshotToken(await readTokenInput(client, organizationId, projectId));
}
