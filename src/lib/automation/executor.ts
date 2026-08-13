/**
 * Automation executor (infrastructure). Server-only: performs Prisma writes.
 *
 * The pure decision-making lives in `@/lib/domain/automation-engine` — this
 * module only *persists* what the engine plans. Every effect is made idempotent
 * by the `AutomationRun` unique key `(organizationId, ruleId, dedupeKey)`:
 *
 *  - Before performing a planned action we INSERT an `AutomationRun`. If the
 *    insert throws P2002 (unique violation) the effect already ran in a previous
 *    dispatch/scan, so we count it SKIPPED and move on — no double notification,
 *    no double milestone bump.
 *  - On a fresh insert we perform the action, bump the rule's counters and leave
 *    the run SUCCESS. If the action throws we flip the run to FAILED (the row is
 *    kept, so it will not be retried) and continue. One rule failing never throws
 *    out of the dispatcher.
 *
 * There is NO background runner: `runAutomationsForEvent` is called inline right
 * after the mutation that produced the event (e.g. a task status change), and
 * `runScheduledAutomations` is exposed via `POST /api/v1/automations/run` for a
 * future cron/scheduled task to poll. Both share the same idempotent pipeline.
 */
import {
  AutomationRunStatus,
  MembershipRole,
  MembershipStatus,
  MilestoneStatus,
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  planAutomation,
  type AutomationEvent,
  type AutomationPlan,
  type AutomationRuleLike,
  type AutomationTrigger,
  type EventTaskContext,
  type HealthStatus,
  type PlannedAction,
} from "@/lib/domain/automation-engine";
import { milestoneCompletion } from "@/lib/domain/work-intelligence";
import {
  analyzeProjectHealth,
  blockerIdsFrom,
} from "@/lib/domain/project-intelligence";
import {
  DEPENDENCY_SCOPE_SELECT,
  edgesForProject,
  flattenDependencies,
} from "@/lib/dependencies/scope";
import { createNotification, resolveManagerRecipients } from "@/lib/notifications/service";
import { callFast, isAiConfigured, SMART_NOTIFY_SYSTEM } from "@/lib/ai";

/**
 * A client capable of both direct model access and opening a transaction. The
 * full `PrismaClient` satisfies this; callers pass `prisma` directly because the
 * executor runs *after* the user's own mutation has already committed.
 */
type ExecutorClient = PrismaClient;

export type AutomationRunSummary = {
  evaluated: number;
  fired: number;
  skipped: number;
  failed: number;
};

function emptySummary(): AutomationRunSummary {
  return { evaluated: 0, fired: 0, skipped: 0, failed: 0 };
}

function addSummary(target: AutomationRunSummary, delta: AutomationRunSummary) {
  target.evaluated += delta.evaluated;
  target.fired += delta.fired;
  target.skipped += delta.skipped;
  target.failed += delta.failed;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

type LoadedRule = AutomationRuleLike & {
  action: AutomationRuleLike["action"];
};

/**
 * Deterministic milestone status recompute from task completion. DONE at 100%;
 * otherwise AT_RISK once past due, ON_TRACK when some work is done, else keeps the
 * current planned/at-risk value. Pure and side-effect free.
 */
export function recomputeMilestoneStatus(
  current: MilestoneStatus,
  completion: number,
  dueDate: Date,
  now: Date,
): MilestoneStatus {
  if (completion >= 100) {
    return MilestoneStatus.DONE;
  }
  if (dueDate.getTime() < now.getTime()) {
    return MilestoneStatus.AT_RISK;
  }
  if (completion > 0) {
    return MilestoneStatus.ON_TRACK;
  }
  return current;
}

// ---------------------------------------------------------------------------
// AI notification phrasing
// ---------------------------------------------------------------------------

/**
 * Produces a replacement notification body, or `null` to keep the deterministic
 * one.
 *
 * Deliberately a *thunk*: a model call costs money and latency, and by the time
 * an action is dispatched it may still be deduped away or skipped. The executor
 * therefore invokes this only at the moment it is genuinely about to notify.
 */
type NotificationNarrator = () => Promise<string | null>;

/**
 * Longest generated body we will accept.
 *
 * `SMART_NOTIFY_SYSTEM` asks for 120 characters. This bound is deliberately
 * looser: it is not a style check, it is a guard against a model that ignored
 * the instruction and returned a paragraph, which would land verbatim in a
 * notification row. Anything beyond this is rejected outright rather than
 * truncated — a sentence cut off mid-word reads as a bug, and the deterministic
 * fallback is a complete, correct sentence.
 */
const MAX_GENERATED_BODY_CHARS = 240;

/**
 * Model output is untrusted input (see AGENTS.md) and this string is persisted,
 * so it is validated before it can reach the database.
 *
 * Collapses whitespace: the prompt asks for one sentence, and a stray newline
 * would break the notification list layout.
 */
function sanitizeGeneratedBody(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim();

  if (collapsed.length === 0 || collapsed.length > MAX_GENERATED_BODY_CHARS) {
    return null;
  }

  return collapsed;
}

/**
 * Build the narrator for one project health transition.
 *
 * Memoised: several rules can subscribe to the same transition, and they would
 * otherwise each pay for an identical model call and produce differently-worded
 * notifications for one event.
 */
function healthChangeNarrator(context: {
  projectName: string;
  previousBand: string;
  currentBand: string;
  score: number;
  topFactor: { name: string; pointsCost: number } | null;
  openCount: number;
  overdueCount: number;
}): NotificationNarrator {
  let cached: Promise<string | null> | null = null;

  return () => {
    if (cached === null) {
      cached = (async () => {
        // Cheap guard so a deployment without a key never pays the cost of an
        // exception per notification.
        if (!isAiConfigured()) {
          return null;
        }

        const prompt =
          `${context.projectName} moved from ${context.previousBand} to ${context.currentBand}. ` +
          `Score: ${context.score}/100. ` +
          // Omitted rather than faked when nothing costs points: a project can
          // reach Healthy with an empty factor list, and "Top factor: none"
          // invites the model to write a sentence about nothing.
          (context.topFactor
            ? `Top factor: ${context.topFactor.name} (-${context.topFactor.pointsCost} pts). `
            : "") +
          `Open tasks: ${context.openCount}. Overdue: ${context.overdueCount}.`;

        const generated = await callFast(SMART_NOTIFY_SYSTEM, prompt);

        return sanitizeGeneratedBody(generated);
      })();
    }

    return cached;
  };
}

/**
 * Performs a single planned action inside a transaction. Throws on failure so the
 * caller can mark the run FAILED. `actorUserId` is only required by
 * WRITE_AUDIT_EVENT (it must reference an active member of the tenant).
 */
async function performAction(
  tx: Prisma.TransactionClient,
  tenantId: string,
  actorUserId: string | null,
  action: PlannedAction,
): Promise<void> {
  if (action.kind === "NOTIFY_MANAGER") {
    const recipients = await resolveManagerRecipients(tx, tenantId);

    for (const recipientUserId of recipients) {
      await createNotification(tx, {
        organizationId: tenantId,
        recipientUserId,
        type: action.type,
        title: action.title,
        body: action.body,
        href: action.href,
        priority: action.priority,
        dedupeKey: action.dedupeKey,
      });
    }

    return;
  }

  if (action.kind === "UPDATE_MILESTONE_PROGRESS") {
    const milestone = await tx.milestone.findFirst({
      where: { id: action.milestoneId, organizationId: tenantId },
      select: { id: true, projectId: true, name: true, dueDate: true, status: true },
    });

    if (!milestone) {
      return;
    }

    const tasks = await tx.task.findMany({
      where: { organizationId: tenantId, milestoneId: milestone.id },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        dueDate: true,
        assignedToUserId: true,
        projectId: true,
        milestoneId: true,
        parentTaskId: true,
        rating: true,
      },
    });

    const { completion } = milestoneCompletion(milestone, tasks);
    const nextStatus = recomputeMilestoneStatus(
      milestone.status,
      completion,
      milestone.dueDate,
      new Date(),
    );

    if (nextStatus !== milestone.status) {
      await tx.milestone.updateMany({
        where: { id: milestone.id, organizationId: tenantId },
        data: { status: nextStatus },
      });
    }

    return;
  }

  // WRITE_AUDIT_EVENT
  if (!actorUserId) {
    throw new Error("No actor available to attribute the automation audit event.");
  }

  await tx.activityLog.create({
    data: {
      action: action.action,
      actorUserId,
      entityId: action.entityId,
      entityType: action.entityType,
      metadata: action.metadata as Prisma.InputJsonValue,
      organizationId: tenantId,
    },
  });
}

/**
 * Runs an already-loaded set of rules against one event. Each planned action is
 * guarded by an `AutomationRun` insert so re-runs are idempotent. Never throws.
 */
async function runRulesAgainstEvent(
  client: ExecutorClient,
  tenantId: string,
  actorUserId: string | null,
  rules: LoadedRule[],
  event: AutomationEvent,
  narrate?: NotificationNarrator,
): Promise<AutomationRunSummary> {
  const summary = emptySummary();

  for (const rule of rules) {
    let plan: AutomationPlan;

    try {
      plan = planAutomation(rule, event);
    } catch {
      // A malformed rule must never take the whole batch down.
      continue;
    }

    if (!plan.fires || !plan.conditionMet || plan.actions.length === 0) {
      continue;
    }

    for (const action of plan.actions) {
      let run: { id: string };

      try {
        run = await client.automationRun.create({
          data: {
            organizationId: tenantId,
            ruleId: rule.id,
            dedupeKey: plan.dedupeKey,
            status: AutomationRunStatus.SUCCESS,
            entityType: plan.entityType || null,
            entityId: plan.entityId || null,
          },
          select: { id: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          summary.skipped += 1;
          continue;
        }
        // Could not even record the run — swallow and keep going.
        summary.failed += 1;
        continue;
      }

      /**
       * Optional AI phrasing of the notification body.
       *
       * ── The fallback contract ──────────────────────────────────────────────
       * This runs here, and not elsewhere, for three reasons:
       *
       *  1. **After the run row is SUCCESS**, so a deduped or already-executed
       *     action never triggers a paid model call.
       *  2. **Outside `$transaction`**, because a network round-trip inside a
       *     database transaction holds a connection open for the length of an
       *     external API call. Under load that exhausts the pool and takes down
       *     writes that have nothing to do with automations.
       *  3. **Wrapped so it cannot throw.** The AI body is a presentation
       *     nicety; the notification is the product requirement. Every failure
       *     path — no API key, 401, rate limit, timeout, malformed or
       *     over-long output — resolves to `null` and the deterministic body
       *     from `planAutomation` is used unchanged.
       *
       * The invariant a future developer must preserve: **an AI failure is never
       * an automation failure.** If this were allowed to throw, the surrounding
       * catch would mark the run FAILED, and because the `AutomationRun` row is
       * kept for idempotency it would never be retried — so a transient Anthropic
       * outage would permanently swallow a health-change alert. That is strictly
       * worse than sending a plainly-worded one.
       */
      let effectiveAction = action;

      if (action.kind === "NOTIFY_MANAGER" && narrate) {
        try {
          const generated = await narrate();

          if (generated) {
            effectiveAction = { ...action, body: generated };
          }
        } catch (error) {
          // Logged, not rethrown. See the contract above.
          console.error("[automation] AI notification phrasing failed", error);
        }
      }

      try {
        await client.$transaction(async (tx) => {
          await performAction(tx, tenantId, actorUserId, effectiveAction);
          await tx.automationRule.updateMany({
            where: { id: rule.id, organizationId: tenantId },
            data: {
              runsThisMonth: { increment: 1 },
              lastRunAt: new Date(),
            },
          });
        });
        summary.fired += 1;
      } catch (error) {
        await client.automationRun
          .update({
            where: { id: run.id },
            data: {
              status: AutomationRunStatus.FAILED,
              detail: error instanceof Error ? error.message.slice(0, 500) : "Unknown error.",
            },
          })
          .catch(() => undefined);
        summary.failed += 1;
      }
    }
  }

  return summary;
}

async function loadRules(
  client: ExecutorClient,
  tenantId: string,
  trigger: AutomationTrigger,
): Promise<LoadedRule[]> {
  return client.automationRule.findMany({
    where: { organizationId: tenantId, enabled: true, trigger },
    select: { id: true, trigger: true, action: true, condition: true },
  });
}

/**
 * Resolves a system actor (first active ADMIN, else any active member) for
 * scheduled automations that must attribute an audit event to a real member.
 */
async function resolveSystemActor(
  client: ExecutorClient,
  tenantId: string,
): Promise<string | null> {
  const admin = await client.organizationMember.findFirst({
    where: {
      organizationId: tenantId,
      status: MembershipStatus.ACTIVE,
      role: MembershipRole.ADMIN,
    },
    select: { userId: true },
  });

  if (admin) {
    return admin.userId;
  }

  const anyMember = await client.organizationMember.findFirst({
    where: { organizationId: tenantId, status: MembershipStatus.ACTIVE },
    select: { userId: true },
  });

  return anyMember?.userId ?? null;
}

/**
 * Dispatch automations for a single event produced inline by a mutation (today:
 * task status changes). Loads the enabled rules whose trigger matches the event,
 * then runs the idempotent per-action pipeline. Never throws.
 */
export async function runAutomationsForEvent(
  client: ExecutorClient,
  tenantId: string,
  actorUserId: string | null,
  event: AutomationEvent,
): Promise<AutomationRunSummary> {
  const summary = emptySummary();

  try {
    const rules = await loadRules(client, tenantId, event.kind);

    if (rules.length === 0) {
      return summary;
    }

    summary.evaluated += 1;
    addSummary(summary, await runRulesAgainstEvent(client, tenantId, actorUserId, rules, event));
  } catch {
    // Dispatch is best-effort and must never surface to the user's mutation.
  }

  return summary;
}

function toEventTask(task: {
  id: string;
  title: string;
  status: EventTaskContext["status"];
  priority: EventTaskContext["priority"];
  projectId: string;
  milestoneId: string | null;
  dueDate: Date | null;
}): EventTaskContext {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId,
    milestoneId: task.milestoneId,
    dueDate: task.dueDate,
  };
}

/**
 * Batch/time-based automations for a tenant. Scans open tasks for TASK_OVERDUE
 * rules and every non-archived project's computed health for
 * PROJECT_HEALTH_CHANGED rules, running the same idempotent pipeline. Intended to
 * be polled by a future scheduled task via `POST /api/v1/automations/run`.
 *
 * Because there is no stored "previous health", the scan uses a deterministic
 * baseline of "Healthy": a project only fires when its current health differs
 * (i.e. it is Watch/At risk/Critical), and the per-status dedupe key prevents
 * re-notifying while it stays at the same level.
 */
export async function runScheduledAutomations(
  client: ExecutorClient,
  tenantId: string,
): Promise<AutomationRunSummary> {
  const summary = emptySummary();
  const now = new Date();
  let actorUserId: string | null | undefined;

  const resolveActor = async () => {
    if (actorUserId === undefined) {
      actorUserId = await resolveSystemActor(client, tenantId);
    }
    return actorUserId;
  };

  // --- TASK_OVERDUE ---------------------------------------------------------
  const overdueRules = await loadRules(client, tenantId, "TASK_OVERDUE");

  if (overdueRules.length > 0) {
    const overdueTasks = await client.task.findMany({
      where: {
        organizationId: tenantId,
        status: { not: "DONE" },
        dueDate: { lt: now },
      },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        projectId: true,
        milestoneId: true,
        dueDate: true,
      },
    });

    const actor = overdueRules.some((rule) => rule.action === "WRITE_AUDIT_EVENT")
      ? await resolveActor()
      : null;

    for (const task of overdueTasks) {
      summary.evaluated += 1;
      const event: AutomationEvent = {
        kind: "TASK_OVERDUE",
        task: toEventTask(task),
        now,
      };
      addSummary(
        summary,
        await runRulesAgainstEvent(client, tenantId, actor, overdueRules, event),
      );
    }
  }

  // --- PROJECT_HEALTH_CHANGED ----------------------------------------------
  const healthRules = await loadRules(client, tenantId, "PROJECT_HEALTH_CHANGED");

  if (healthRules.length > 0) {
    const [projects, tasks, milestones, dependencies] = await Promise.all([
      client.project.findMany({
        where: { organizationId: tenantId, status: { not: "ARCHIVED" } },
        select: {
          id: true,
          name: true,
          description: true,
          status: true,
          startDate: true,
          endDate: true,
          // Previous observation, so a "change" can actually be detected.
          lastHealthBand: true,
        },
      }),
      client.task.findMany({
        where: { organizationId: tenantId },
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          dueDate: true,
          assignedToUserId: true,
          projectId: true,
          milestoneId: true,
          parentTaskId: true,
          rating: true,
          // Required by the intelligence engine's velocity signal.
          completedAt: true,
          createdAt: true,
        },
      }),
      client.milestone.findMany({
        where: { organizationId: tenantId },
        select: { id: true, projectId: true, name: true, dueDate: true, status: true },
      }),
      client.taskDependency.findMany({
        where: { organizationId: tenantId },
        select: DEPENDENCY_SCOPE_SELECT,
      }),
    ]);

    const actor = healthRules.some((rule) => rule.action === "WRITE_AUDIT_EVENT")
      ? await resolveActor()
      : null;

    const scopedDependencies = flattenDependencies(dependencies);

    for (const project of projects) {
      // Partition per project before scoring. The old scorer was handed every
      // task in the tenant and filtered internally, so with more than one
      // project its ratios were computed against the wrong denominator.
      const projectTasks = tasks.filter((task) => task.projectId === project.id);
      const projectMilestones = milestones.filter((m) => m.projectId === project.id);
      // Either endpoint inside the project: a task elsewhere blocking work here
      // is still a blocker for this project's health.
      const projectDependencies = edgesForProject(scopedDependencies, project.id);
      const openTaskIds = new Set(
        projectTasks.filter((task) => task.status !== "DONE").map((task) => task.id),
      );

      // Slippage is intentionally not fed in here. Automations run on every
      // task mutation, and loading the activity log each time would turn a
      // cheap trigger evaluation into a table scan. Health for automation
      // purposes therefore uses the live signals only; the reporting endpoints
      // include slippage. Rules keyed on health bands are unaffected in
      // practice because slippage moves a score by at most 18 points.
      const health = analyzeProjectHealth(
        project,
        projectTasks,
        projectMilestones,
        [],
        blockerIdsFrom(projectDependencies, openTaskIds),
        now,
      );
      summary.evaluated += 1;

      const previous = project.lastHealthBand as HealthStatus | null;

      // Record the observation regardless of whether it fires a rule, so the
      // next run has something real to compare against. Done before the rule
      // dispatch: if a notification fails, the band is still recorded, and the
      // alternative — retrying on the next run — would spam the same alert.
      if (previous !== health.band) {
        await client.project.update({
          data: {
            lastHealthAt: now,
            lastHealthBand: health.band,
            lastHealthScore: health.score,
          },
          where: { id: project.id },
        });
      }

      // Three cases, and only one of them is an event:
      //
      //  - `previous === null`: never evaluated. Seed the baseline and stay
      //    silent. Firing here would mean enabling a rule immediately alerts on
      //    every unhealthy project, which reads as a flood of false alarms about
      //    situations that are not new.
      //  - `previous === health.band`: no change. The trigger is
      //    PROJECT_HEALTH_*CHANGED*, so an unchanged band is not an event.
      //  - otherwise: a real transition, which is what rules subscribe to.
      //
      // The previous implementation compared against a hardcoded "Healthy", so
      // it fired every run for every project that was not currently Healthy and
      // never fired at all for a project that degraded *from* Healthy — the
      // exact transition anyone would want to be told about.
      if (previous === null || previous === health.band) {
        continue;
      }

      const event: AutomationEvent = {
        kind: "PROJECT_HEALTH_CHANGED",
        project: { id: project.id, name: project.name },
        previousStatus: previous,
        newStatus: health.band,
      };

      // Built here because this is the only scope holding the computed health —
      // score, ranked factors and counts. The event type stays a pure domain
      // value and gains no dependency on the AI layer.
      //
      // Nothing is called yet: the narrator is a thunk, invoked only if a rule
      // actually reaches the notify step.
      const narrate = healthChangeNarrator({
        currentBand: health.band,
        openCount: health.counts.open,
        overdueCount: health.counts.overdue,
        previousBand: previous,
        projectName: project.name,
        score: health.score,
        // `factors` is ranked worst-first and contains only signals that cost
        // points, so index 0 is the real top factor or there is none.
        topFactor: health.factors[0]
          ? { name: health.factors[0].label, pointsCost: health.factors[0].points }
          : null,
      });

      addSummary(
        summary,
        await runRulesAgainstEvent(client, tenantId, actor, healthRules, event, narrate),
      );
    }
  }

  return summary;
}
