/**
 * Policy conflict detection — Feature 2.
 *
 * Pure, deterministic, no AI. Accepts a draft automation rule and the
 * organization's existing enabled rules, and returns a list of conflict
 * warnings the route handler surfaces to the manager before they decide
 * whether to save the draft.
 *
 * Architecture rules preserved:
 *  - Domain layer: no AI imports, no Prisma, no React, no tenant logic.
 *  - Only `parseCondition` and `evaluateCondition` from the engine are used —
 *    the same functions the executor uses at runtime, so the conflict check
 *    reflects real execution semantics.
 *  - Returns warnings, not hard errors. The caller decides what to do with them.
 *
 * Conflict taxonomy (important — do not collapse these categories):
 *
 *   CONFIRMED_DUPLICATE
 *     Same trigger + same action + identical condition string.
 *     If saved, the new rule would produce the exact same side-effect as an
 *     existing rule on every event. The idempotency key (ruleId) prevents
 *     duplicate execution in the executor, but the rule is still redundant.
 *
 *   CONFIRMED_UNCONDITIONAL
 *     Same trigger + same action + both conditions evaluate to true for every
 *     possible (status, priority) context. The executor runs both; one is
 *     always redundant.
 *
 *   POSSIBLE_OVERLAP
 *     Same trigger + same action + the two conditions are compatible (there
 *     exists at least one context where both evaluate to true). The executor
 *     fires both on those inputs, but NOT on all inputs. This is *not* always
 *     a problem — e.g. different teams intend both rules — but the manager
 *     should be aware.
 *
 * NOT detected here (explicitly out of scope):
 *   - Cross-trigger conflicts (different triggers cannot fire simultaneously).
 *   - Cross-action conflicts (different actions are additive by design).
 *   - Condition mutual-exclusion proofs beyond brute-force enumeration.
 */

import type { AutomationRuleLike } from "@/lib/domain/automation-engine";
import { evaluateCondition, parseCondition } from "@/lib/domain/automation-engine";

// ---------------------------------------------------------------------------
// All valid runtime values for condition fields.
// These must match the Prisma enums and the DSL's FIELD_MEMBERS exactly.
// If the engine adds a new status or priority value, add it here too.
// ---------------------------------------------------------------------------

const ALL_STATUSES = ["TODO", "IN_PROGRESS", "BLOCKED", "DONE"] as const;
const ALL_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

/** The 16-element cartesian product of all (status, priority) pairs. */
const ALL_CONTEXTS = ALL_STATUSES.flatMap((status) =>
  ALL_PRIORITIES.map((priority) => ({ status, priority })),
);

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ConflictKind =
  | "CONFIRMED_DUPLICATE"    // same trigger, action, and condition — rule is redundant
  | "CONFIRMED_UNCONDITIONAL" // same trigger and action, both always fire
  | "POSSIBLE_OVERLAP";       // same trigger and action, conditions intersect on some inputs

export type ConflictResult = {
  /** Which kind of conflict was detected. */
  kind: ConflictKind;
  /** The existing rule that the draft conflicts with. */
  conflictingRuleId: string;
  /** Human-readable description of why this is a conflict. */
  message: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks `draft` against every rule in `existing` and returns a list of
 * conflict warnings. The list may be empty (no conflicts found).
 *
 * @param draft   - The rule the manager is considering saving. Must have an
 *                  `id` field (can be any sentinel string such as "draft").
 * @param existing - The organization's existing enabled automation rules.
 *                  Typically loaded from DB by the calling route handler.
 */
export function findConflicts(
  draft: AutomationRuleLike,
  existing: AutomationRuleLike[],
): ConflictResult[] {
  const results: ConflictResult[] = [];

  const draftParsed = parseCondition(draft.condition);

  for (const rule of existing) {
    // Different trigger or action → these rules run in separate scenarios;
    // no interaction is possible.
    if (rule.trigger !== draft.trigger || rule.action !== draft.action) {
      continue;
    }

    const ruleParsed = parseCondition(rule.condition);

    // If either condition failed to parse we cannot reason about overlap —
    // skip rather than produce a false positive.
    if (draftParsed.error !== null || ruleParsed.error !== null) {
      continue;
    }

    // ── 1. Both unconditional ───────────────────────────────────────────────
    // Checked before the string-equality test so that two empty-condition
    // rules are classified as CONFIRMED_UNCONDITIONAL (the semantically
    // meaningful signal: "both always fire") rather than CONFIRMED_DUPLICATE.
    // CONFIRMED_DUPLICATE is reserved for non-unconditional rules that happen
    // to share the same condition string.
    if (draftParsed.alwaysTrue && ruleParsed.alwaysTrue) {
      results.push({
        kind: "CONFIRMED_UNCONDITIONAL",
        conflictingRuleId: rule.id,
        message:
          `Rule "${rule.id}" has the same trigger (${rule.trigger}) and ` +
          `action (${rule.action}) with no conditions. Both rules would ` +
          `always fire together on every matching event.`,
      });
      continue;
    }

    // ── 2. Exact duplicate ──────────────────────────────────────────────────
    // Normalise whitespace for the comparison so "status == DONE" and
    // "status  ==  DONE" are treated as identical.
    if (normalise(rule.condition) === normalise(draft.condition)) {
      results.push({
        kind: "CONFIRMED_DUPLICATE",
        conflictingRuleId: rule.id,
        message:
          `Rule "${rule.id}" has the same trigger (${rule.trigger}), ` +
          `action (${rule.action}), and condition. ` +
          `Saving this would create a redundant rule.`,
      });
      continue; // already a strong signal; skip overlap check
    }

    // ── 3. Possible overlap — enumerate the condition value space ───────────
    // We test all 16 (status × priority) combinations. If any context makes
    // BOTH conditions true, the two rules overlap on those inputs.
    //
    // Note: TASK_OVERDUE and PROJECT_HEALTH_CHANGED rules currently use no
    // condition in practice, so most rules for those triggers are caught by
    // case 1 or 2. TASK_STATUS_CHANGED rules are where this check matters.
    const overlappingContext = ALL_CONTEXTS.find(
      (ctx) =>
        evaluateCondition(draftParsed, ctx) && evaluateCondition(ruleParsed, ctx),
    );

    if (overlappingContext) {
      results.push({
        kind: "POSSIBLE_OVERLAP",
        conflictingRuleId: rule.id,
        message:
          `Rule "${rule.id}" has the same trigger (${rule.trigger}) and ` +
          `action (${rule.action}). Both rules fire when ` +
          `status=${overlappingContext.status} and ` +
          `priority=${overlappingContext.priority}. ` +
          `This may be intentional, but review before saving.`,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collapses runs of whitespace and upper-cases the condition string so that
 * cosmetically different but semantically identical strings compare as equal.
 */
function normalise(condition: string): string {
  return condition.trim().replace(/\s+/g, " ").toUpperCase();
}
