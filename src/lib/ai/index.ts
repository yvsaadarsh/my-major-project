/**
 * Public surface of the AI layer.
 *
 * Import from `@/lib/ai` rather than reaching into `./client` or `./prompts`,
 * so the internal file split stays free to change.
 *
 * SERVER ONLY — see `./client.ts`. Nothing here may be imported from a Client
 * Component, and nothing in `src/lib/domain/**` may import this module: the
 * domain layer stays pure and deterministic.
 */

export {
  callFast,
  streamQuality,
  isAiConfigured,
  FAST_MODEL,
  QUALITY_MODEL,
} from "./client";

export {
  AUTOMATION_PARSE_SYSTEM,
  FORECAST_SYSTEM,
  NARRATIVE_HEALTH_SYSTEM,
  RETROSPECTIVE_SYSTEM,
  SMART_NOTIFY_SYSTEM,
  TASK_EXTRACT_SYSTEM,
  TASK_PARSE_SYSTEM,
} from "./prompts";
