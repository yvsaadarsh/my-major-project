import { ApiError, json } from "@/lib/api/http";
import { withTenantGuard, type RouteContext } from "@/lib/api/tenant-guard";
import { isAiConfigured, RETROSPECTIVE_SYSTEM, streamQuality } from "@/lib/ai";
import { prisma } from "@/lib/db";
import {
  scheduleChangesFromActivity,
  slippageStats,
} from "@/lib/domain/project-intelligence";
import { Permission } from "@/lib/rbac";
import { requireProjectForTenant } from "@/lib/tenant/queries";

/**
 * AI retrospective over a closed milestone.
 *
 * Additive and read-only: this issues SELECTs, streams prose, and persists
 * nothing. `RETROSPECTIVE_SYSTEM` writes three fixed sections (what went well /
 * what slipped and why / one recommendation) from already-computed statistics.
 *
 * What is sent to the model
 * -------------------------
 * Counts, averages and day-deltas only — **no task titles, descriptions,
 * assignees, ids or per-task dates**. The milestone name is the single free-text
 * field, and it is needed for the retrospective to read as being about anything.
 * That is a narrower egress than the narrative brief, which sends two task
 * titles.
 *
 * Deriving "when the milestone closed"
 * ------------------------------------
 * `Milestone` has no `completedAt` column (see `prisma/schema.prisma`), so
 * closure has to be inferred. Preference order:
 *
 *  1. The latest `completedAt` among the milestone's DONE tasks — a real event
 *     recorded from real work, and the honest answer to "when did this finish?".
 *  2. `milestone.updatedAt`, when nothing was ever completed (the common case for
 *     a MISSED milestone). This is weaker: any later edit to the row moves it.
 *
 * Both are approximations of a fact the schema does not record. The prompt
 * forbids inventing dates and is only ever given this one, so the model cannot
 * turn the approximation into a more precise claim than it deserves. If exact
 * closure timing ever matters, the fix is a `completedAt` column written when the
 * status changes — not more inference here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cap on activity rows read for one milestone's tasks.
 *
 * Scoped by `entityId IN (task ids)` rather than org-wide, so this is already a
 * narrow read; the cap only guards a pathological re-dating history.
 */
const ACTIVITY_READ_CAP = 2000;

/** Milestone states a retrospective is meaningful for. */
const CLOSED_STATUSES = new Set(["DONE", "MISSED"]);

type Params = {
  projectId: string;
  milestoneId: string;
};

export const GET = withTenantGuard<Params>(
  Permission.DashboardRead,
  async (_request, tenant, context: RouteContext<Params>) => {
    const { projectId, milestoneId } = await context.params;

    // 404s another tenant's project before anything else runs.
    await requireProjectForTenant(tenant.tenantId, projectId);

    // Scoped by organization *and* project: a milestone id from another project
    // in the same tenant is a 404 here, not a silent cross-project read.
    const milestone = await prisma.milestone.findFirst({
      where: { id: milestoneId, organizationId: tenant.tenantId, projectId },
      select: {
        id: true,
        name: true,
        dueDate: true,
        status: true,
        updatedAt: true,
      },
    });

    if (!milestone) {
      throw new ApiError(404, "milestone_not_found", "Milestone was not found.");
    }

    // Checked before the AI-configured check: "this milestone is still open" is
    // a property of the request, and should answer the same way on every
    // deployment rather than depending on whether a key happens to be set.
    if (!CLOSED_STATUSES.has(milestone.status)) {
      return json(
        { error: "Retrospective only available for completed milestones" },
        400,
      );
    }

    if (!isAiConfigured()) {
      return json({ error: "AI not configured" }, 501);
    }

    // Every task ever assigned to this milestone, DONE included — a
    // retrospective that omitted the finished work would be describing only what
    // went wrong.
    const tasks = await prisma.task.findMany({
      where: { organizationId: tenant.tenantId, projectId, milestoneId },
      select: {
        id: true,
        status: true,
        dueDate: true,
        completedAt: true,
      },
    });

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((task) => task.status === "DONE").length;

    // ── Closure timestamp ─────────────────────────────────────────────────
    const completionTimes = tasks
      .filter((task) => task.status === "DONE" && task.completedAt !== null)
      .map((task) => (task.completedAt as Date).getTime());

    const closedAt =
      completionTimes.length > 0
        ? new Date(Math.max(...completionTimes))
        : milestone.updatedAt;

    // ── Slippage ──────────────────────────────────────────────────────────
    // Read due-date history for exactly this milestone's tasks. Parsing goes
    // through the domain helpers so the tolerance for pre-recording rows and the
    // push/pull rules match every other slippage number in the product.
    const taskIds = tasks.map((task) => task.id);

    const activity =
      taskIds.length === 0
        ? []
        : await prisma.activityLog.findMany({
            where: {
              organizationId: tenant.tenantId,
              entityType: "task",
              entityId: { in: taskIds },
              action: { in: ["task.updated", "task.status_changed"] },
            },
            select: {
              entityType: true,
              entityId: true,
              action: true,
              createdAt: true,
              metadata: true,
            },
            orderBy: { createdAt: "asc" },
            take: ACTIVITY_READ_CAP,
          });

    // No blocker weighting here: this is a retrospective on one milestone, not a
    // health score, so an empty set keeps the aggregate unweighted.
    const slippage = slippageStats(
      scheduleChangesFromActivity(activity),
      new Set<string>(),
    );

    // ── Overdue at closure ────────────────────────────────────────────────
    // Tasks that were still unfinished at the closure instant *and* already past
    // their own due date then. Evaluated against `closedAt` rather than now, so
    // the number describes the milestone's condition when it closed rather than
    // drifting every time the page is reloaded.
    const closedAtMs = closedAt.getTime();
    const overdueAtCompletion = tasks.filter((task) => {
      const unfinishedThen =
        task.completedAt === null || task.completedAt.getTime() > closedAtMs;
      return (
        unfinishedThen &&
        task.dueDate !== null &&
        task.dueDate.getTime() < closedAtMs
      );
    }).length;

    // Positive = late, negative = early.
    const daysEarlyOrLate = Math.round(
      (closedAtMs - milestone.dueDate.getTime()) / DAY_MS,
    );

    const retrospectiveContext = {
      milestoneName: milestone.name,
      status: milestone.status,
      dueDate: milestone.dueDate.toISOString().slice(0, 10),
      completedAt: closedAt.toISOString().slice(0, 10),
      totalTasks,
      completedTasks,
      tasksWithSlippage: slippage.tasksPushed,
      avgDaysPushed: slippage.averageDaysPerPush,
      maxDaysPushed: slippage.worstPushDays,
      overdueAtCompletion,
      daysEarlyOrLate,
    };

    const iterator = streamQuality(
      RETROSPECTIVE_SYSTEM,
      JSON.stringify(retrospectiveContext),
    )[Symbol.asyncIterator]();

    // Pull the first chunk eagerly so an immediate provider failure (missing key,
    // 401, rate limit) becomes a real status code instead of a 200 with an empty
    // body. Once the status line is on the wire it cannot be retracted.
    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (error) {
      console.error("[retrospective] upstream failed before first chunk", error);
      throw new ApiError(
        502,
        "ai_upstream_failed",
        "The retrospective could not be generated.",
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
          // Mid-stream failure: the reader already has a 200 and some prose.
          // Close cleanly so it keeps what arrived.
          console.error("[retrospective] stream ended early", error);
          controller.close();
        }
      },
      async cancel() {
        // Modal closed or navigated away — stop the upstream request so a
        // cancelled retrospective stops billing.
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
