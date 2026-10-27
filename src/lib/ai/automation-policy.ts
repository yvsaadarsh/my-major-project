/**
 * AI-assisted automation policy interpretation — Feature 2.
 *
 * This is a leaf module: no Prisma, no React, no tenant logic. It accepts a
 * plain string (the manager's natural-language policy), calls the AI with the
 * exact vocabulary the deterministic engine supports, and returns a typed
 * result for the route handler to validate and forward to the manager.
 *
 * Architecture rules preserved:
 *  - AI interprets; deterministic code executes. This module never writes to DB.
 *  - organizationId never enters or leaves here.
 *  - Model output is Zod-validated before it leaves this file.
 *  - Unsupported policies return a typed error; they never silently produce a
 *    plausible-but-wrong rule.
 */

import { callFast } from "@/lib/ai/client";
import { AUTOMATION_PARSE_SYSTEM } from "@/lib/ai/prompts";
import { aiRuleOutputSchema, type InterpretedRule } from "@/lib/validators";

// ---------------------------------------------------------------------------
// Vocabulary — single source of truth for what the engine can do.
//
// These strings are injected into the AI prompt's user message, not the system
// prompt. Tenant data flows through user messages only; the system prompt is
// shared and immutable across all tenants.
//
// Every value here must match exactly what the Prisma enums, TS unions, and
// condition DSL (automation-engine.ts) accept. If the engine changes, update
// this too — the AI must never be shown values that the engine will reject.
// ---------------------------------------------------------------------------

const TRIGGER_VOCABULARY = [
  "TASK_OVERDUE          — fires when a task's due date has passed and the task is not DONE (evaluated in scheduled batch)",
  "TASK_STATUS_CHANGED   — fires immediately when any task's status changes",
  "PROJECT_HEALTH_CHANGED — fires in scheduled batch when a project's health band transitions",
].join("\n");

const ACTION_VOCABULARY = [
  "NOTIFY_MANAGER         — sends a notification to all ADMIN and MANAGER members of the organization",
  "UPDATE_MILESTONE_PROGRESS — recomputes the task's milestone completion and status",
  "WRITE_AUDIT_EVENT      — writes an audit log entry for the triggering entity",
].join("\n");

const CONDITION_FIELD_VOCABULARY = [
  "status   — current task status; allowed values: TODO, IN_PROGRESS, BLOCKED, DONE",
  "priority — task priority;       allowed values: LOW, MEDIUM, HIGH, URGENT",
].join("\n");

const CONDITION_OPERATOR_VOCABULARY = [
  "==   — exact equality:  status == DONE",
  "!=   — inequality:      priority != LOW",
  "in   — set membership:  priority in (HIGH, URGENT)",
].join("\n");

const CONDITION_CONJUNCTION = "Clauses may be combined with 'and' only. 'or' is NOT supported.";

const UNSUPPORTED_EXAMPLES = [
  "overdue_days > 5           (numeric fields do not exist in conditions)",
  "health_band == AT_RISK      (PROJECT_HEALTH_CHANGED has no condition fields)",
  "status == DONE or priority == URGENT  ('or' is not supported)",
].join("\n");

/**
 * Builds the user-message payload sent to AUTOMATION_PARSE_SYSTEM.
 *
 * The system prompt says "trigger vocabulary supplied with the input" — this
 * is that input. Keeping it in the user message means a vocabulary change
 * shows up as a code diff, not a hidden prompt change, and tenant data never
 * gets mixed into the system prompt.
 */
export function buildAutomationVocabulary(policy: string): string {
  return [
    `POLICY: ${policy}`,
    "",
    "--- SUPPORTED TRIGGERS ---",
    TRIGGER_VOCABULARY,
    "",
    "--- SUPPORTED ACTIONS ---",
    ACTION_VOCABULARY,
    "",
    "--- CONDITION FIELDS (task-level only; not all triggers support conditions) ---",
    CONDITION_FIELD_VOCABULARY,
    "",
    "--- CONDITION OPERATORS ---",
    CONDITION_OPERATOR_VOCABULARY,
    "",
    CONDITION_CONJUNCTION,
    "",
    "--- EXAMPLES OF UNSUPPORTED CONDITIONS (return {\"error\":\"unsupported\"} for these) ---",
    UNSUPPORTED_EXAMPLES,
    "",
    "Return the JSON object only. No prose.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PolicyInterpretOk = {
  status: "ok";
  rule: InterpretedRule;
};

export type PolicyInterpretUnsupported = {
  status: "unsupported";
  reason: string;
};

export type PolicyInterpretError = {
  status: "ai_error";
  reason: string;
};

export type PolicyInterpretResult =
  | PolicyInterpretOk
  | PolicyInterpretUnsupported
  | PolicyInterpretError;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Sends a manager's natural-language policy to the AI and returns a typed
 * result. Never throws — errors are returned as typed variants so callers can
 * surface them as proper HTTP responses without a try/catch at the call site.
 *
 * The caller (route handler) is responsible for:
 *  - Loading existing rules for the org and running conflict detection.
 *  - Returning the draft to the manager for approval.
 *  - Only persisting after the manager explicitly submits via POST /automations.
 *
 * This function does no DB access and has no tenant context — organizationId
 * never enters here.
 */
export async function interpretAutomationPolicy(
  policy: string,
): Promise<PolicyInterpretResult> {
  const userMessage = buildAutomationVocabulary(policy);

  let rawText: string;

  try {
    rawText = await callFast(AUTOMATION_PARSE_SYSTEM, userMessage);
  } catch (error) {
    return {
      status: "ai_error",
      reason: error instanceof Error ? error.message : "AI call failed.",
    };
  }

  // Guard: model returned empty string (valid outcome per callFast contract).
  if (!rawText) {
    return {
      status: "ai_error",
      reason: "AI returned an empty response. Try rephrasing the policy.",
    };
  }

  // Guard: parse JSON — treat any parse failure as a model error, not a
  // validation error, because the model is supposed to return only JSON.
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      status: "ai_error",
      reason: "AI returned non-JSON output. Try rephrasing the policy.",
    };
  }

  // Zod-validate the parsed value against the union of allowed shapes.
  const result = aiRuleOutputSchema.safeParse(parsed);

  if (!result.success) {
    return {
      status: "ai_error",
      reason: `AI returned unexpected shape: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }

  // The model's explicit "I cannot map this to the vocabulary" signal.
  if ("error" in result.data && result.data.error === "unsupported") {
    return {
      status: "unsupported",
      reason:
        "The policy cannot be mapped to the supported triggers, actions, and condition vocabulary. " +
        "Rephrase using: triggers (TASK_OVERDUE, TASK_STATUS_CHANGED, PROJECT_HEALTH_CHANGED), " +
        "actions (NOTIFY_MANAGER, UPDATE_MILESTONE_PROGRESS, WRITE_AUDIT_EVENT), " +
        "and conditions on status or priority only.",
    };
  }

  // Happy path — validated rule shape.
  return {
    status: "ok",
    rule: result.data as InterpretedRule,
  };
}
