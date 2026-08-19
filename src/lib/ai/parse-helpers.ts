/**
 * Helpers for turning raw model output into structured, trusted values.
 *
 * Lives in the AI leaf module because it is entirely about the model contract —
 * extracting a JSON object from a possibly-fenced response, then coercing each
 * field into a known vocabulary. Independently unit-testable, and reusable when
 * a second parse route is added.
 *
 * Nothing here touches Prisma, tenants, or React. It takes strings and returns
 * validated values; callers still own the trust boundary.
 */

export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Best-effort extraction of a single JSON object from a model response.
 *
 * The prompt forbids prose and code fences, but a wrapper is a common failure
 * mode and cheap to tolerate: strip a leading/trailing fence, then fall back to
 * the outermost `{ … }` span. Returns null when nothing parses — the caller
 * turns that into a 422.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
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

export function normalizePriority(value: unknown): Priority {
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if ((PRIORITIES as readonly string[]).includes(upper)) {
      return upper as Priority;
    }
  }
  return "MEDIUM";
}

/** Accept only a bare `YYYY-MM-DD`; anything else becomes null. */
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}
