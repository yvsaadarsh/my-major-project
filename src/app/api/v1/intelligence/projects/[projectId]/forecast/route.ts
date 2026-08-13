import { ApiError, json } from "@/lib/api/http";
import { withTenantGuard, type RouteContext } from "@/lib/api/tenant-guard";
import { FORECAST_SYSTEM, isAiConfigured, streamQuality } from "@/lib/ai";
import { Permission } from "@/lib/rbac";
import { loadProjectIntelligenceSnapshot } from "@/lib/intelligence/project-snapshot";

/**
 * AI trajectory forecast: where this project is heading, not where it is now.
 *
 * Like the narrative brief, this is strictly additive and phrases only
 * already-computed metrics. `FORECAST_SYSTEM` writes two hedged sentences over a
 * context object of trend numbers — velocity direction, slippage, overdue ratio,
 * critical-chain depth. The model extrapolates in prose; it never computes a
 * figure, and the deterministic page renders identically without it.
 *
 * Two guards keep the forecast honest:
 *
 *  - **Not configured → 501.** No key, no section. The UI hides it on this exact
 *    status rather than surfacing an error for content nobody asked for.
 *  - **Too little history → 200 { insufficient }.** `docs/INTELLIGENCE.md`
 *    deliberately refuses predicted dates on tiny projects ("confident-looking
 *    numbers with no basis"). A forecast over fewer than five open tasks, or a
 *    project younger than two weeks, is exactly that, so it is declined up front
 *    rather than dressed up by the model.
 *
 * Tenant isolation is unchanged: the shared snapshot loader resolves the project
 * through `requireProjectForTenant` (404 for another tenant) and filters every
 * query on `organizationId`. No raw task content is sent to the model.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_OPEN_TASKS = 5;
const MIN_PROJECT_AGE_DAYS = 14;

export const GET = withTenantGuard<{ projectId: string }>(
  Permission.DashboardRead,
  async (_request, tenant, context: RouteContext<{ projectId: string }>) => {
    const { projectId } = await context.params;
    const now = new Date();

    // 501, not 500: the request was understood, the feature is simply not
    // enabled here. The client keys off this to hide the section entirely.
    if (!isAiConfigured()) {
      return json({ error: "AI not configured" }, 501);
    }

    const snapshot = await loadProjectIntelligenceSnapshot(
      tenant.tenantId,
      projectId,
      now,
    );

    const { health, project, risk } = snapshot;

    const openTaskCount = health.counts.open;
    const projectAgeDays = Math.floor(
      (now.getTime() - project.createdAt.getTime()) / DAY_MS,
    );

    // A forecast from a handful of tasks or a two-week-old project is
    // confident-looking noise. Decline it rather than let the model extrapolate
    // from nothing.
    if (openTaskCount < MIN_OPEN_TASKS || projectAgeDays < MIN_PROJECT_AGE_DAYS) {
      return json({ insufficient: true, message: "Not enough history to forecast" });
    }

    // Only computed metrics — no task titles, descriptions, ids, or dates.
    const forecastContext = {
      projectName: project.name,
      currentBand: health.band,
      score: health.score,
      velocityDirection: health.velocity.direction,
      velocityRecentCount: health.velocity.recentCompleted,
      velocityPriorCount: health.velocity.priorCompleted,
      overdueRatio:
        openTaskCount === 0
          ? 0
          : Math.round((health.counts.overdue / openTaskCount) * 100) / 100,
      slippageAvgDays: health.slippage.averageDaysPerPush,
      criticalChainLength: risk.longestChain.length,
      daysUntilDeadline:
        project.endDate === null
          ? null
          : Math.floor((project.endDate.getTime() - now.getTime()) / DAY_MS),
      openTaskCount,
    };

    const iterator = streamQuality(
      FORECAST_SYSTEM,
      JSON.stringify(forecastContext),
    )[Symbol.asyncIterator]();

    // Pull the first chunk eagerly so an immediate provider failure (missing
    // key, 401, rate limit) becomes a real status code instead of a 200 with an
    // empty body. See the narrative route for the fuller rationale.
    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (error) {
      console.error("[forecast] upstream failed before first chunk", error);
      throw new ApiError(
        502,
        "ai_upstream_failed",
        "The forecast could not be generated. The deterministic analysis is unaffected.",
      );
    }

    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (!first.done) {
            controller.enqueue(encoder.encode(first.value));
          }

          while (true) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            controller.enqueue(encoder.encode(next.value));
          }

          controller.close();
        } catch (error) {
          // Mid-stream failure: the client already has a 200 and some prose.
          // Close cleanly and let the reader keep the partial forecast.
          console.error("[forecast] stream ended early", error);
          controller.close();
        }
      },
      async cancel() {
        // Reader went away — stop the upstream request so a cancelled forecast
        // stops billing rather than running to completion.
        await iterator.return?.();
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  },
);
