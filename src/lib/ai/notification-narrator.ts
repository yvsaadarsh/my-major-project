/**
 * Generated phrasing for notification bodies.
 *
 * Belongs to the AI leaf (AGENTS.md rule 4): it holds the model call and the
 * validation of what comes back, and nothing else. No Prisma, no React, no
 * tenant logic — callers hand it already-computed, already-authorized values
 * and get back a string or `null`.
 *
 * The `null` return is the contract that keeps rule 6 honest: a narrator never
 * *replaces* the deterministic notification body, it only *offers* one. Any
 * failure — no API key, upstream error, output that breaks the length guard —
 * collapses to `null` and the caller keeps the sentence it already computed.
 *
 * SERVER ONLY, like the rest of `src/lib/ai/**`.
 */

// Imported from the sibling modules directly rather than through `./index`:
// a file inside the AI layer reaching for its own barrel is a latent import
// cycle the moment that barrel re-exports this one.
import { callFast, isAiConfigured } from "./client";
import { SMART_NOTIFY_SYSTEM } from "./prompts";

/**
 * Produces a replacement notification body, or `null` to keep the deterministic
 * one.
 *
 * Deliberately a *thunk*: a model call costs money and latency, and by the time
 * an action is dispatched it may still be deduped away or skipped. The executor
 * therefore invokes this only at the moment it is genuinely about to notify.
 */
export type NotificationNarrator = () => Promise<string | null>;

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
export const MAX_GENERATED_BODY_CHARS = 240;

/**
 * Model output is untrusted input (see AGENTS.md) and this string is persisted,
 * so it is validated before it can reach the database.
 *
 * Collapses whitespace: the prompt asks for one sentence, and a stray newline
 * would break the notification list layout.
 */
export function sanitizeGeneratedBody(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim();

  if (collapsed.length === 0 || collapsed.length > MAX_GENERATED_BODY_CHARS) {
    return null;
  }

  return collapsed;
}

/** Already-computed health figures for one project transition. */
export type HealthChangeContext = {
  projectName: string;
  previousBand: string;
  currentBand: string;
  score: number;
  topFactor: { name: string; pointsCost: number } | null;
  openCount: number;
  overdueCount: number;
};

/**
 * Build the narrator for one project health transition.
 *
 * Memoised: several rules can subscribe to the same transition, and they would
 * otherwise each pay for an identical model call and produce differently-worded
 * notifications for one event.
 */
export function healthChangeNarrator(context: HealthChangeContext): NotificationNarrator {
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
