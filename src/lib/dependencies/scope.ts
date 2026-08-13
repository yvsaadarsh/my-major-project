/**
 * Shared scoping helpers for tenant-wide task dependencies.
 *
 * `TaskDependency` no longer carries a `projectId` — an edge belongs to the
 * tenant, and its endpoints may live in different projects. That makes "this
 * project's dependencies" a two-sided question, and getting it wrong is silent:
 * filtering on one side returns a plausible-looking list that is missing every
 * inbound constraint from other projects.
 *
 * So the query fragment and the predicate live here once, and every caller uses
 * them rather than reimplementing the OR.
 */

/** Prisma `select` for a dependency plus both endpoints' project ids. */
export const DEPENDENCY_SCOPE_SELECT = {
  id: true,
  sourceTaskId: true,
  targetTaskId: true,
  type: true,
  sourceTask: { select: { projectId: true } },
  targetTask: { select: { projectId: true } },
} as const;

/** Prisma `where` for edges with either endpoint inside `projectId`. */
export function dependenciesRelevantToProject(organizationId: string, projectId: string) {
  return {
    organizationId,
    OR: [{ sourceTask: { projectId } }, { targetTask: { projectId } }],
  };
}

/** The nested shape `DEPENDENCY_SCOPE_SELECT` returns. */
export type NestedDependencyRow = {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: "BLOCKS" | "DEPENDS_ON" | "RELATED_TO";
  sourceTask: { projectId: string } | null;
  targetTask: { projectId: string } | null;
};

/** Flattened edge: what every consumer actually wants to work with. */
export type ScopedDependency = {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: "BLOCKS" | "DEPENDS_ON" | "RELATED_TO";
  sourceProjectId: string;
  targetProjectId: string;
  /** True when the two endpoints live in different projects. */
  crossProject: boolean;
};

/**
 * Flatten Prisma's nested rows.
 *
 * Rows whose endpoint task is missing are dropped. That should be impossible —
 * both foreign keys cascade — but the relation is nullable in Prisma's generated
 * types, and inventing an empty string here would create an edge belonging to a
 * project with no name, which is harder to debug than simply not being there.
 */
export function flattenDependencies(rows: NestedDependencyRow[]): ScopedDependency[] {
  const flattened: ScopedDependency[] = [];

  for (const row of rows) {
    const sourceProjectId = row.sourceTask?.projectId;
    const targetProjectId = row.targetTask?.projectId;

    if (sourceProjectId === undefined || targetProjectId === undefined) {
      continue;
    }

    flattened.push({
      crossProject: sourceProjectId !== targetProjectId,
      id: row.id,
      sourceProjectId,
      sourceTaskId: row.sourceTaskId,
      targetProjectId,
      targetTaskId: row.targetTaskId,
      type: row.type,
    });
  }

  return flattened;
}

/**
 * Is this edge relevant to `projectId`?
 *
 * True when either endpoint is inside it. Deliberately not "the source is
 * inside": a task in another project blocking work in this one is exactly the
 * risk this project's owner needs to see.
 */
export function edgeTouchesProject(edge: ScopedDependency, projectId: string): boolean {
  return edge.sourceProjectId === projectId || edge.targetProjectId === projectId;
}

/** Edges relevant to `projectId`, from an already-fetched tenant-wide list. */
export function edgesForProject(
  edges: ScopedDependency[],
  projectId: string,
): ScopedDependency[] {
  return edges.filter((edge) => edgeTouchesProject(edge, projectId));
}
