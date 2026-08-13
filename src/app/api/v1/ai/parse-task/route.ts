import { NextRequest } from "next/server";
import { z } from "zod";

import { callFast, isAiConfigured, TASK_PARSE_SYSTEM } from "@/lib/ai";
import { ApiError, json, parseJson } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { Permission } from "@/lib/rbac";
import { requireProjectForTenant } from "@/lib/tenant/queries";

/**
 * Parse one line of natural language into a structured *draft* task.
 *
 * This route only *reads intent*; it never writes. Task creation stays on the
 * existing `POST /api/v1/projects/[projectId]/tasks`, which owns validation,
 * the activity log and the transaction. Splitting parse from create keeps the
 * trust boundary honest: model output is a suggestion the user confirms, not a
 * mutation the model performs.
 *
 * Model output is untrusted input (AGENTS.md, rule 5). It is parsed defensively
 * — fences stripped, JSON extracted, every field normalized against a known
 * vocabulary — before it leaves this handler. Nothing here reaches the database.
 */

const requestSchema = z.object({
  text: z.string().trim().min(1).max(500),
  projectId: z.string().trim().min(1).max(80),
});

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
type Priority = (typeof PRIORITIES)[number];

type ParsedTask = {
  title: string;
  description: string;
  priority: Priority;
  dueDate: string | null;
  notes: string;
};

export const POST = withTenantGuard(
  Permission.TasksCreate,
  async (request: NextRequest, tenant) => {
    // 501, not 500: the request was understood, the feature is simply not
    // enabled here. The client hides the AI affordance on this exact status.
    if (!isAiConfigured()) {
      return json({ error: "AI not configured" }, 501);
    }

    const { text, projectId } = await parseJson(request, requestSchema);

    // 404s another tenant's project before anything is sent to the model, and
    // gives us the project name for context. The model never sees an id.
    const project = await requireProjectForTenant(tenant.tenantId, projectId);

    // A reference date lets the prompt resolve "Friday" / "next week". Without
    // one the prompt is instructed to return null rather than guess.
    const referenceDate = new Date().toISOString().slice(0, 10);

    const prompt = JSON.stringify({
      referenceDate,
      projectName: project.name,
      text,
    });

    let raw: string;
    try {
      raw = await callFast(TASK_PARSE_SYSTEM, prompt);
    } catch (error) {
      // `callFast` has already scrubbed tenant data from the message; it is safe
      // to log but developer-facing, so the client gets a generic 502.
      console.error("[parse-task] upstream failed", error);
      throw new ApiError(
        502,
        "ai_upstream_failed",
        "The AI service could not be reached. Please try again.",
      );
    }

    const parsed = extractJsonObject(raw);
    const title = typeof parsed?.title === "string" ? parsed.title.trim() : "";

    // The one hard requirement: a title. No title means the model did not
    // produce a usable task, which is indistinguishable to the user from a
    // parse failure — both mean "try rephrasing".
    if (!parsed || title.length === 0) {
      return json({ error: "Could not parse task from that text" }, 422);
    }

    const result: ParsedTask = {
      title: title.slice(0, 180),
      description:
        typeof parsed.description === "string" ? parsed.description.trim().slice(0, 5000) : "",
      priority: normalizePriority(parsed.priority),
      dueDate: normalizeDate(parsed.dueDate),
      notes: typeof parsed.notes === "string" ? parsed.notes.trim().slice(0, 2000) : "",
    };

    return json(result);
  },
);

/**
 * Best-effort extraction of a single JSON object from a model response.
 *
 * The prompt forbids prose and code fences, but a wrapper is a common failure
 * mode and cheap to tolerate: strip a leading/trailing fence, then fall back to
 * the outermost `{ … }` span. Returns null when nothing parses — the caller
 * turns that into a 422.
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  const candidates = [stripped];
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start !== -1 && end > start) {
    candidates.push(stripped.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function normalizePriority(value: unknown): Priority {
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if ((PRIORITIES as readonly string[]).includes(upper)) {
      return upper as Priority;
    }
  }
  return "MEDIUM";
}

/** Accept only a bare `YYYY-MM-DD`; anything else becomes null. */
function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}
