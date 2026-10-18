/**
 * TEST DOUBLE — `@/lib/ai/client`.
 *
 * The `@/lib/ai` barrel is already doubled, which covers every route that
 * imports from the barrel. `src/lib/ai/automation-policy.ts` instead imports
 * `callFast` from `@/lib/ai/client` directly, so without this mapping the
 * policy interpreter would reach the real Anthropic client and every
 * interpretation test could only ever observe an `ai_error`.
 *
 * Everything is re-exported from the barrel double, so a single `__ai` object
 * controls the model's behaviour for both import paths.
 */
export { __ai, callFast, isAiConfigured, streamQuality, FAST_MODEL, QUALITY_MODEL } from "./ai";
