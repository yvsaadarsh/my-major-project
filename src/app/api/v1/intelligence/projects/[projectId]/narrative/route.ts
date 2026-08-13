import { ApiError, json } from "@/lib/api/http";
import { withTenantGuard, type RouteContext } from "@/lib/api/tenant-guard";
import { Permission } from "@/lib/rbac";
import { isAiConfigured, streamQuality, NARRATIVE_HEALTH_SYSTEM } from "@/lib/ai";
import { slippageByTask } from "@/lib/domain/project-intelligence";
import { loadProjectIntelligenceSnapshot } from "@/lib/intelligence/project-snapshot";

/**
 * AI narrative brief over the *already-computed* health analysis.
 *
 * The model phrases numbers it is given. It never produces one. Every figure in
 * the context object below comes from `analyzeProjectHealth` /
 * `analyzeDependencyRisk` / `slippageByTask`, and `NARRATIVE_HEALTH_SYSTEM`
 * forbids inventing any other. If this endpoint is unavailable the deterministic
 * page is unchanged — the brief is additive, never a replacement.
 *
 * What is sent to Anthropic
 * -------------------------
 * A structured context object of computed metrics, plus the project name and at
 * most **two** task titles: the top bottleneck and the worst-slipping task. No
 * descriptions, comments, assignees, ids, dates, or any other task row.
 *
 * That is a deliberate, bounded trade and it is a real change to the property
 * `docs/INTELLIGENCE.md` originally claimed ("nothing leaves the process"). A
 * brief that says "the top bottleneck" instead of naming it is not actionable,
 * which is the entire point of the feature. The doc records the trade; if it is
 * ever unacceptable for a tenant, the fix is to omit the two title fields here —
 * the prompt already tolerates their absence — not to loosen anything else.
 *
 * Tenant isolation is unchanged: `withTenantGuard` resolves the organization
 * from the session, `requireProjectForTenant` 404s another tenant's project, and
 * the snapshot loader filters every query on `organizationId`.
 *
 * Streaming and error handling
 * ----------------------------
 * The first chunk is pulled *before* the streaming Response is constructed. That
 * way an immediate failure — missing key, 401, rate limit — still becomes a
 * normal JSON error with a correct status code, instead of a 200 with an empty
 * body. Only a mid-stream failure degrades, and it cannot do better: once the
 * status line is on the wire it cannot be retracted.
 */
export const GET = withTenantGuard<{ projectId: string }>(
  Permission.DashboardRead,
  async (_request, tenant, context: RouteContext<{ projectId: string }>) => {
    const { projectId } = await context.params;
    const now = new Date();

    // 501 rather than 500: the server understood the request and the feature is
    // simply not enabled here. The UI keys off this exact status to hide the
    // section entirely, so AI stays optional.
    if (!isAiConfigured()) {
      return json({ error: "AI not configured" }, 501);
    }

    const snapshot = await loadProjectIntelligenceSnapshot(
      tenant.tenantId,
      projectId,
      now,
    );

    const { health, project, risk, scheduleChanges, tasks } = snapshot;

    // Highest-impact bottleneck. `bottlenecks` is already ranked by impactScore
    // and omits tasks that block nothing open, so index 0 is the real answer or
    // there is none.
    const top = risk.bottlenecks[0] ?? null;

    const worstSlippage =
      slippageByTask(
        scheduleChanges,
        (taskId) => tasks.find((task) => task.id === taskId)?.title ?? "(unknown task)",
        snapshot.blockerIds,
        1,
      )[0] ?? null;

    /**
     * The complete payload sent to the model. Assembled explicitly, field by
     * field, rather than by spreading a domain object — a spread would silently
     * start exporting any field a future refactor adds to `ProjectIntelligence`.
     */
    const modelContext = {
      projectName: project.name,
      score: health.score,
      band: health.band,
      // Only signals that cost points, worst first. `pointsCost` is named to
      // make the direction unambiguous to the model: these are deductions.
      factors: health.factors.map((factor) => ({
        name: factor.label,
        pointsCost: factor.points,
        evidence: factor.evidence,
      })),
      topBottleneck: top
        ? {
            taskTitle: top.title,
            blockedCount: top.openBlockedCount,
            isOverdue: top.overdue,
          }
        : null,
      cycleCount: risk.cycles.length,
      criticalChainLength: risk.longestChain.length,
      slippageWorstTask: worstSlippage
        ? {
            title: worstSlippage.title,
            totalDaysPushed: worstSlippage.totalDaysPushed,
            pushCount: worstSlippage.pushes,
          }
        : null,
      velocityDirection: health.velocity.direction,
      confidenceLevel: health.confidence.level,
    };

    const iterator = streamQuality(
      NARRATIVE_HEALTH_SYSTEM,
      JSON.stringify(modelContext),
    )[Symbol.asyncIterator]();

    // Pull the first chunk eagerly so an immediate provider failure surfaces as
    // a real status code. See the note above.
    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (error) {
      // `streamQuality` has already normalized this to a clean Error whose
      // message is safe to log but is still developer-facing, so it is logged
      // here and replaced with a generic message for the client.
      console.error("[narrative] upstream failed before first chunk", error);
      throw new ApiError(
        502,
        "ai_upstream_failed",
        "The AI brief could not be generated. The deterministic analysis is unaffected.",
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
          // Mid-stream failure. The client already has a 200 and some prose, so
          // the honest options are "abort the body" or "stop cleanly and keep
          // what arrived". Closing cleanly is chosen: the reader keeps a partial
          // brief rather than throwing away text that is still accurate, and the
          // brief is advisory content sitting above an unaffected deterministic
          // page.
          console.error("[narrative] stream ended early", error);
          controller.close();
        }
      },
      async cancel() {
        // The reader went away — browser tab closed, component unmounted, user
        // navigated. Returning through the generator closes the upstream request
        // so a cancelled brief stops billing rather than running to completion.
        await iterator.return?.();
      },
    });

    return new Response(readable, {
      headers: {
        // Not `application/json` — the body is a token stream, and declaring it
        // JSON would invite a consumer to buffer and parse it.
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        // Defeats proxy buffering, which would otherwise collect the whole body
        // and deliver it at once — turning a streamed brief back into a slow
        // blocking response.
        "X-Accel-Buffering": "no",
        //
        // `Transfer-Encoding: chunked` is deliberately NOT set here. It is a
        // hop-by-hop header owned by the HTTP layer: Node sets it automatically
        // for a body of unknown length, and setting it by hand risks a duplicate
        // or conflicting header at the runtime boundary. Streaming works because
        // the body is a ReadableStream, not because of this header.
      },
    });
  },
);
