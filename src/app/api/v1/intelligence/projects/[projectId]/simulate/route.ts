/**
 * POST /api/v1/intelligence/projects/:projectId/simulate
 *
 * What-If Simulation — Feature 1, Phases 3+4.
 *
 * Flow:
 *   1. Auth + permission guard (projects:simulate — ADMIN/MANAGER only).
 *   2. Parse and Zod-validate the request body.
 *   3. Load project snapshot (tenant-scoped, same loader as forecast/narrative).
 *   4. AI Call 1 (Haiku/callFast) — interpret the scenario.
 *      → If needs_clarification: return early with the question.
 *   5. Deterministic simulation engine — clone state, apply change, recompute
 *      health, produce diff. All numbers computed here, never by the model.
 *   6. AI Call 2 (Sonnet/streamQuality buffered) — narrate the diff.
 *      → Falls back to a deterministic summary if Call 2 fails.
 *   7. Return full JSON result: diff + narration + snapshotToken.
 *
 * P0 rules enforced:
 *   - No DB writes. Simulation is purely read + in-memory.
 *   - healthDelta, severity, verdict come from the engine — never from model output.
 *   - Model output from Call 1 is Zod-validated before use.
 *   - snapshotToken is project.updatedAt.toISOString() — passed to the client
 *     so it can send it back with the Apply request for stale-write detection.
 *   - Tenant isolation: loadProjectIntelligenceSnapshot 404s for wrong-tenant IDs.
 */

import { z } from "zod";

import { json, parseJson } from "@/lib/api/http";
import { withTenantGuard, type RouteContext } from "@/lib/api/tenant-guard";
import {
  callFast,
  isAiConfigured,
  SIMULATION_INTERPRET_SYSTEM,
  SIMULATION_NARRATE_SYSTEM,
  streamQuality,
} from "@/lib/ai";
import { Permission } from "@/lib/rbac";
import { simulationRequestSchema } from "@/lib/validators";
import { loadProjectIntelligenceSnapshot } from "@/lib/intelligence/project-snapshot";
import { snapshotTokenFromSnapshot } from "@/lib/intelligence/snapshot-token";
import { runSimulation } from "@/lib/domain/simulation/engine";
import {
  describeChange,
  summarizeChange,
} from "@/lib/domain/simulation/describe-change";

// ─── Call 1 output schema (model output is untrusted; validate before use) ───

const interpretResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("simulated"),
    interpretedIntent: z.string().min(1).max(400),
  }),
  z.object({
    status: z.literal("needs_clarification"),
    clarificationQuestion: z.string().min(1).max(400),
  }),
]);

// ─── Helper: buffer the quality stream into a string ─────────────────────────

async function collectStream(iterable: AsyncIterable<string>): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of iterable) {
    parts.push(chunk);
  }
  return parts.join("").trim();
}

// ─── Deterministic narration fallback (if Call 2 fails) ──────────────────────

function deterministicNarration(
  interpretedIntent: string,
  changeType: string,
  healthDelta: number,
  severity: string,
  verdict: string,
): string {
  const direction = healthDelta >= 0 ? "improved" : "degraded";
  const abs = Math.abs(Math.round(healthDelta));
  return (
    `Simulation: ${interpretedIntent}. ` +
    `The project health ${direction} by ${abs} points after applying the ${changeType} change. ` +
    `Severity: ${severity}. Verdict: ${verdict}. ` +
    `(Narrative generation was unavailable — this is a deterministic summary.)`
  );
}

// ─── Route handler ────────────────────────────────────────────────────────────

export const POST = withTenantGuard<{ projectId: string }>(
  Permission.ProjectsSimulate,
  async (request, tenant, context: RouteContext<{ projectId: string }>) => {
    const { projectId } = await context.params;
    const now = new Date();

    // Shared shape with POST /api/v1/automations/interpret: an unconfigured
    // deployment is a 501 with the `ai_not_configured` code on both AI routes,
    // so the client can handle "feature switched off" once rather than per
    // route. A genuine upstream failure remains a 502.
    if (!isAiConfigured()) {
      return json(
        {
          error: "ai_not_configured",
          message: "AI features are not configured for this deployment.",
        },
        501,
      );
    }

    // ── 1. Parse + validate request body ──────────────────────────────────────
    //
    // Any `snapshotToken` the client sends is deliberately ignored. The token
    // this route returns is derived server-side from the snapshot below, so a
    // client cannot claim a state it did not observe.
    const body = await parseJson(request, simulationRequestSchema);
    const { scenario, change } = body;

    // ── 2. Load tenant-scoped snapshot (404 for wrong-tenant project) ─────────
    const snapshot = await loadProjectIntelligenceSnapshot(
      tenant.tenantId,
      projectId,
      now,
    );

    // ── 3. AI Call 1 — interpret the scenario ────────────────────────────────
    //
    // Haiku is fast enough to sit on the request path. The model output is
    // Zod-validated before any logic branches on it, so a hallucinated field
    // cannot affect downstream behaviour.
    // The structured change is included, not just its type: without the target
    // identifiers the model could describe a different task than the one the
    // engine computes the diff from and Apply writes, and the user would approve
    // a mutation after reading a sentence about something else.
    const call1UserMessage = JSON.stringify({
      scenario,
      changeType: change.type,
      change: describeChange(change),
      changeSummary: summarizeChange(change),
      projectContext: {
        name: snapshot.project.name,
        healthScore: snapshot.health.score,
        healthBand: snapshot.health.band,
        openTaskCount: snapshot.health.counts.open,
      },
    });

    let interpretedIntent = "";

    try {
      const raw = await callFast(SIMULATION_INTERPRET_SYSTEM, call1UserMessage);
      const parsed = interpretResultSchema.safeParse(JSON.parse(raw));

      if (!parsed.success) {
        // Model returned malformed JSON. Treat as a soft failure: proceed with
        // a generic intent rather than blocking the simulation entirely.
        interpretedIntent = `Evaluate the impact of a ${change.type} change.`;
      } else if (parsed.data.status === "needs_clarification") {
        return json({
          status: "needs_clarification",
          clarificationQuestion: parsed.data.clarificationQuestion,
        });
      } else {
        interpretedIntent = parsed.data.interpretedIntent;
      }
    } catch (error) {
      // Call 1 failure is non-fatal: we can still run the deterministic engine
      // and return a result with a fallback narration.
      console.error("[simulate] Call 1 (interpret) failed", error);
      interpretedIntent = `Evaluate the impact of a ${change.type} change.`;
    }

    // ── 4. Deterministic simulation engine ────────────────────────────────────
    //
    // All numbers produced here. Model output is never used for these.
    const diff = runSimulation(snapshot, change, now);

    // ── 5. AI Call 2 — narrate the diff ──────────────────────────────────────
    //
    // Quality model (Sonnet) for prose. Buffered — the client needs the full
    // JSON (diff + narration) before it can render the Decision Center.
    // Falls back to a deterministic summary if the upstream call fails.
    let narration: string;

    const call2UserMessage = JSON.stringify({
      scenario,
      interpretedIntent,
      changeType: change.type,
      projectName: snapshot.project.name,
      baseline: {
        score: diff.baseline.score,
        band: diff.baseline.band,
      },
      modified: {
        score: diff.modified.score,
        band: diff.modified.band,
      },
      healthDelta: diff.healthDelta,
      severity: diff.severity,
      verdict: diff.verdict,
      bandChanged: diff.bandChanged,
      affectedTaskCount: diff.affectedTaskCount,
      signalChanges: diff.signalChanges,
    });

    try {
      narration = await collectStream(
        streamQuality(SIMULATION_NARRATE_SYSTEM, call2UserMessage),
      );
      if (!narration) {
        narration = deterministicNarration(
          interpretedIntent,
          change.type,
          diff.healthDelta,
          diff.severity,
          diff.verdict,
        );
      }
    } catch (error) {
      // PDF plan: "Narration fallback if Call 2 fails — return deterministic
      // diff with fallback text." Simulation result is still valid and usable.
      console.error("[simulate] Call 2 (narrate) failed", error);
      narration = deterministicNarration(
        interpretedIntent,
        change.type,
        diff.healthDelta,
        diff.severity,
        diff.verdict,
      );
    }

    // ── 6. Return result ──────────────────────────────────────────────────────
    //
    // snapshotToken is a fingerprint of `snapshot` — the exact state the diff
    // was computed from — so the relationship between the simulated state and
    // the token is total: equal tokens mean nothing the simulation reads has
    // changed. Apply recomputes it from the live database inside its
    // transaction and rejects a mismatch.
    //
    // `change` is the Zod-validated structured change, echoed so the review
    // panel shows what the server actually parsed (schema defaults included)
    // and the client sends that same object back to Apply. The narration and
    // interpreted intent remain descriptive only — neither determines which
    // mutation executes.
    return json({
      status: "simulated",
      interpretedIntent,
      change,
      changeDescription: describeChange(change),
      diff,
      narration,
      snapshotToken: snapshotTokenFromSnapshot(snapshot),
    });
  },
);
