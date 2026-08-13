import { json } from "@/lib/api/http";
import { withTenantGuard, type RouteContext } from "@/lib/api/tenant-guard";
import { Permission } from "@/lib/rbac";
import { slippageByTask } from "@/lib/domain/project-intelligence";
import { loadProjectIntelligenceSnapshot } from "@/lib/intelligence/project-snapshot";

/**
 * Project health intelligence + dependency risk for one project.
 *
 * Read-only by design. This handler issues SELECTs and no writes of any kind:
 * the analysis never modifies task state, never re-dates anything, and never
 * creates notifications. Recommendations are returned as text for a human to act
 * on.
 *
 * Tenant isolation follows the same pattern as every other route:
 *
 * - `withTenantGuard` resolves the organization from the session, never from the
 *   request, and enforces `dashboard:read`.
 * - `requireProjectForTenant` 404s if the project belongs to another tenant, so
 *   a guessed project id is indistinguishable from a nonexistent one.
 * - Every query filters on `organizationId`, so even a correct-looking
 *   `projectId` from another tenant returns nothing.
 *
 * The domain layers receive already-scoped rows and never see an organization
 * id, which means they cannot leak across tenants by construction.
 *
 * The loading itself lives in `src/lib/intelligence/project-snapshot.ts` because
 * the AI narrative route needs the identical snapshot, and the queries are
 * subtle enough (two-sided dependency scope, different task sets for health vs
 * risk) that a second copy would drift silently.
 */
export const GET = withTenantGuard<{ projectId: string }>(
  Permission.DashboardRead,
  async (_request, tenant, context: RouteContext<{ projectId: string }>) => {
    const { projectId } = await context.params;
    const now = new Date();

    const snapshot = await loadProjectIntelligenceSnapshot(
      tenant.tenantId,
      projectId,
      now,
    );

    const { health, project, risk, scheduleChanges, tasks } = snapshot;

    // Classify the boundary-crossing edges from this project's point of view.
    // "We are blocking someone else" and "someone else is blocking us" need
    // different actions from the person reading this, so they are counted apart.
    const projectOf = new Map<string, { id: string; name: string }>(
      snapshot.externalTasks.map((task) => [task.id, task.project]),
    );

    const crossProject = snapshot.scopedDependencies
      .filter((edge) => edge.crossProject)
      .map((edge) => {
        const inboundBlocker = edge.sourceProjectId !== projectId;
        const otherTaskId = inboundBlocker ? edge.sourceTaskId : edge.targetTaskId;

        return {
          direction: inboundBlocker ? ("inbound" as const) : ("outbound" as const),
          edgeId: edge.id,
          otherProject: projectOf.get(otherTaskId) ?? null,
          otherTaskId,
          type: edge.type,
        };
      });

    return json({
      crossProject: {
        edges: crossProject,
        inbound: crossProject.filter((edge) => edge.direction === "inbound").length,
        outbound: crossProject.filter((edge) => edge.direction === "outbound").length,
      },
      generatedAt: now.toISOString(),
      health,
      project: { id: project.id, name: project.name, status: project.status },
      risk,
      // Which commitments keep moving. The aggregate cannot answer this: one task
      // re-dated six times and six tasks moved once produce identical totals but
      // call for completely different conversations.
      slippageRetrospective: slippageByTask(
        scheduleChanges,
        (taskId) => tasks.find((task) => task.id === taskId)?.title ?? "(unknown task)",
        snapshot.blockerIds,
        20,
      ),
      /**
       * Declared so consumers never have to guess whether this endpoint could
       * have changed something. It cannot.
       */
      readOnly: true,
      scheduleHistory: {
        changesConsidered: scheduleChanges.length,
        /** True when the activity cap was reached and older history was ignored. */
        truncated: snapshot.activityTruncated,
      },
    });
  },
);
