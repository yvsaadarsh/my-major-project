/**
 * POST /api/v1/automations/interpret
 *
 * Accepts a manager's natural-language policy string and returns a structured
 * draft automation rule plus any conflict warnings against the organization's
 * existing enabled rules.
 *
 * This endpoint is READ-ONLY. It never writes to the database. The manager
 * reviews the draft and conflict list, then decides whether to save via the
 * normal POST /api/v1/automations endpoint (which persists the rule).
 *
 * The complete Feature 2 lifecycle for this endpoint is:
 *
 *   1. Manager submits natural-language policy (this request).
 *   2. AI interprets the policy → structured draft rule (this response).
 *   3. Conflict detector checks draft against existing rules (this response).
 *   4. Manager reviews draft + conflicts in the UI.
 *   5. Manager approves → POST /api/v1/automations saves the rule.
 *   6. Automation engine executes rules on matching events.
 *   7. Audit log records each execution.
 *
 * Auth: requires AutomationsManage permission (ADMIN or MANAGER role).
 * Tenant isolation: organizationId always comes from the verified session cookie,
 * never from the request body or AI output.
 *
 * Error codes:
 *   400  — missing or invalid request body
 *   422  — policy is syntactically valid but cannot be mapped to supported
 *           triggers/actions/conditions (AI returned "unsupported")
 *   502  — AI call failed or returned malformed output
 */

import { NextRequest } from "next/server";

import { json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { interpretAutomationPolicy } from "@/lib/ai/automation-policy";
import { prisma } from "@/lib/db";
import { findConflicts } from "@/lib/domain/policy-conflict";
import { Permission } from "@/lib/rbac";
import { policyInterpretRequestSchema } from "@/lib/validators";

export const POST = withTenantGuard(
  Permission.AutomationsManage,
  async (request: NextRequest, tenant) => {
    // ── 1. Validate request body ────────────────────────────────────────────
    const { policy } = await parseJson(request, policyInterpretRequestSchema);

    // ── 2. Call AI interpreter ──────────────────────────────────────────────
    // Leaf module — returns a typed result, never throws. organizationId is
    // not passed: the AI layer has no tenant context by design.
    const interpretation = await interpretAutomationPolicy(policy);

    if (interpretation.status === "ai_error") {
      return json(
        {
          error: "ai_error",
          message: interpretation.reason,
        },
        502,
      );
    }

    if (interpretation.status === "unsupported") {
      return json(
        {
          error: "unsupported",
          message: interpretation.reason,
        },
        422,
      );
    }

    // interpretation.status === "ok" — we have a validated draft rule
    const draft = interpretation.rule;

    // ── 3. Load existing enabled rules for this tenant ──────────────────────
    // organizationId is always from the verified session — never from the
    // request body or AI output. Idempotency and isolation properties apply.
    const existingRules = await prisma.automationRule.findMany({
      where: {
        organizationId: tenant.tenantId,
        enabled: true,
      },
      select: {
        id: true,
        trigger: true,
        action: true,
        condition: true,
      },
    });

    // ── 4. Run conflict detection ───────────────────────────────────────────
    // Pure, deterministic — no AI involved. The draft is given a sentinel id
    // so the conflict results reference it if needed (currently unused by
    // findConflicts since it compares draft against existing, not draft vs draft).
    const conflicts = findConflicts(
      { ...draft, id: "__draft__" },
      existingRules.map((r) => ({
        id: r.id,
        trigger: r.trigger as Parameters<typeof findConflicts>[1][number]["trigger"],
        action: r.action as Parameters<typeof findConflicts>[1][number]["action"],
        condition: r.condition,
      })),
    );

    // ── 5. Return draft + conflicts — nothing is written ───────────────────
    // The manager sees the draft and conflict warnings in the UI. If they
    // approve, the UI POSTs to /api/v1/automations with sourcePolicy set.
    return json(
      {
        draft: {
          name: draft.name,
          trigger: draft.trigger,
          condition: draft.condition,
          action: draft.action,
        },
        conflicts: conflicts.map((c) => ({
          kind: c.kind,
          conflictingRuleId: c.conflictingRuleId,
          message: c.message,
        })),
        /** Echo the original policy back so the UI can pass it as sourcePolicy on save. */
        sourcePolicy: policy,
      },
      200,
    );
  },
);
