/**
 * Prose for the project intelligence output.
 *
 * Split from `project-intelligence.ts` on purpose: that file is arithmetic and
 * must stay dependency-free and deterministic. This file composes the already-
 * computed signals into the summary paragraph and the ranked recommendations —
 * still deterministic (nothing here calls a model), still auditable, but
 * unambiguously *presentation* of the numbers rather than production of them.
 *
 * The scorer imports these back for the two convenience fields on
 * `ProjectIntelligence`; the two files never disagree because the narrator can
 * only read what the scorer has already produced.
 */

import type {
  HealthBand,
  HealthConfidence,
  HealthSignal,
  SlippageStats,
  VelocityTrend,
} from "./project-intelligence";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Compose the ranked factors into one paragraph.
 *
 * Built from the same `factors` array the UI renders, so the prose and the
 * breakdown can never disagree — a failure mode that a generated summary would
 * reintroduce immediately.
 */
export function buildSummary(
  projectName: string,
  score: number,
  band: HealthBand,
  completion: number,
  factors: HealthSignal[],
  confidence: HealthConfidence,
): string {
  const opening = `${projectName} scores ${score}/100 (${band}) at ${completion}% complete.`;

  if (factors.length === 0) {
    return `${opening} No health signals are currently costing points.${
      confidence.level === "high" ? "" : ` Confidence is ${confidence.level}: ${confidence.caveats[0]}`
    }`;
  }

  const top = factors.slice(0, 3);
  const drivers = top
    .map((factor) => `${factor.label.toLowerCase()} (−${factor.points})`)
    .join(", ");

  const detail = top[0].detail;

  const tail =
    confidence.level === "high"
      ? ""
      : ` Confidence is ${confidence.level}: ${confidence.caveats[0]}`;

  return `${opening} The score is driven by ${drivers}. ${detail}${tail}`;
}

/** Advisory only. Nothing here is ever executed by the system. */
export function buildRecommendations(
  factors: HealthSignal[],
  context: {
    blockedCount: number;
    overdueCount: number;
    slippage: SlippageStats;
    unassignedOpen: number;
    velocity: VelocityTrend;
  },
): string[] {
  const recommendations: string[] = [];

  for (const factor of factors) {
    switch (factor.key) {
      case "overdue":
        recommendations.push(
          `Triage the ${plural(context.overdueCount, "overdue task")}: re-date what is still real and close what is not. Overdue work is the single largest drag on this score.`,
        );
        break;
      case "blocked":
        recommendations.push(
          `Review the ${plural(context.blockedCount, "blocked task")} — check the dependency view for which blockers release the most work.`,
        );
        break;
      case "slippage":
        recommendations.push(
          context.slippage.blockerPushCount > 0
            ? `${plural(context.slippage.blockerPushCount, "due-date push", "due-date pushes")} landed on blocking tasks. Re-plan those first, since their dates drag everything downstream.`
            : `Due dates have moved by ${plural(Math.round(context.slippage.totalDaysPushed), "day")} in total. Consider whether the current dates are still credible.`,
        );
        break;
      case "velocity":
        recommendations.push(
          context.velocity.direction === "stalled"
            ? "Nothing has completed recently. Confirm whether the team is blocked, reassigned, or simply not updating task status."
            : "Throughput is falling. Compare it against the workload view to see whether it is capacity or blockers.",
        );
        break;
      case "milestone":
        recommendations.push(
          "Re-baseline the at-risk milestones, or move their scope, so the dates reflect what is actually achievable.",
        );
        break;
      case "deadline":
        recommendations.push(
          "The project end date has passed. Either extend it or close the project so it stops distorting reporting.",
        );
        break;
    }
  }

  if (context.unassignedOpen > 0) {
    recommendations.push(
      `${plural(context.unassignedOpen, "open task")} ${context.unassignedOpen === 1 ? "has" : "have"} no owner, so nobody is accountable for moving ${context.unassignedOpen === 1 ? "it" : "them"}.`,
    );
  }

  return recommendations;
}
