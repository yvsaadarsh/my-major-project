/**
 * Renders a validated `SimulationChange` as labelled, human-readable fields.
 *
 * ## Why this exists
 *
 * The simulate route asks the model to interpret the user's free-text scenario,
 * and the model's reply (`interpretedIntent`) is the sentence the user reads
 * before approving an Apply. Originally the model was given only the scenario
 * text and the change's *type* — never the change's target. It could therefore
 * describe a different task than the one the diff was computed from and the
 * Apply would write, and the user would approve the mutation after reading a
 * sentence about something else.
 *
 * This module closes that gap from both ends. The same description is fed into
 * the interpretation context, so the model can name the real target, and
 * rendered in the review panel, so the user reviews the validated payload
 * rather than only the prose.
 *
 * The description is derived from the Zod-validated structured change, never
 * from model output, and it is presentation only: it has no influence on which
 * mutation executes. The engine computes the diff from the structured change and
 * the Apply endpoint re-validates that same change independently.
 *
 * Pure: no Prisma, no I/O, no AI.
 */

import type { SimulationChange } from "@/lib/validators";

/** One labelled row of the change, in display order. */
export type ChangeField = { label: string; value: string };

export type ChangeDescription = {
  /** Short human label for the change type, e.g. "Change task status". */
  action: string;
  /** The concrete parameters of the change, in display order. */
  fields: ChangeField[];
};

/** ISO date → `YYYY-MM-DD`, which is the precision these changes carry. */
function day(value: string | null | undefined): string {
  if (!value) return "none";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

/**
 * Describe a structured change.
 *
 * Every branch names the entity being changed, so no change type can reach the
 * review panel as an unexplained label.
 */
export function describeChange(change: SimulationChange): ChangeDescription {
  switch (change.type) {
    case "task_status":
      return {
        action: "Change task status",
        fields: [
          { label: "Task", value: change.taskId },
          { label: "New status", value: change.status },
        ],
      };

    case "task_reassign":
      return {
        action: "Reassign task",
        fields: [
          { label: "Task", value: change.taskId },
          {
            label: "New assignee",
            value: change.assignedToUserId ?? "unassigned",
          },
        ],
      };

    case "task_due_date":
      return {
        action: "Change task due date",
        fields: [
          { label: "Task", value: change.taskId },
          { label: "New due date", value: day(change.dueDate) },
        ],
      };

    case "task_add":
      return {
        action: "Add task",
        fields: [
          { label: "Title", value: change.title },
          { label: "Status", value: change.status },
          { label: "Priority", value: change.priority },
          { label: "Due date", value: day(change.dueDate) },
          { label: "Assignee", value: change.assignedToUserId ?? "unassigned" },
          { label: "Milestone", value: change.milestoneId ?? "none" },
        ],
      };

    case "task_remove":
      return {
        action: "Remove task",
        fields: [{ label: "Task", value: change.taskId }],
      };

    case "milestone_date":
      return {
        action: "Change milestone date",
        fields: [
          { label: "Milestone", value: change.milestoneId },
          { label: "New due date", value: day(change.dueDate) },
        ],
      };

    case "dependency_add":
      return {
        action: "Add dependency",
        fields: [
          { label: "Source task", value: change.sourceTaskId },
          { label: "Target task", value: change.targetTaskId },
          { label: "Type", value: change.depType },
        ],
      };

    case "dependency_remove":
      return {
        action: "Remove dependency",
        fields: [{ label: "Dependency", value: change.dependencyId }],
      };

    default: {
      const exhaustive: never = change as never;
      void exhaustive;
      return { action: "Unsupported change", fields: [] };
    }
  }
}

/** One-line form, for prompt context and log lines. */
export function summarizeChange(change: SimulationChange): string {
  const { action, fields } = describeChange(change);
  const detail = fields.map((f) => `${f.label}=${f.value}`).join(", ");
  return detail ? `${action} (${detail})` : action;
}
