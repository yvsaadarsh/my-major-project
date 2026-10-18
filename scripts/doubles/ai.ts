/**
 * TEST DOUBLE — the `@/lib/ai` barrel.
 *
 * Substituting the barrel (rather than `./client`) is deliberate: the routes
 * import from `@/lib/ai`, and the real barrel re-exports `./client` by relative
 * path, which a path mapping cannot intercept.
 *
 * The **prompts are the real ones**, re-exported from source — so the tests that
 * assert prompt wiring are checking the genuine system prompts, not copies.
 */
export * from "../../src/lib/ai/prompts";

export const QUALITY_MODEL = "claude-sonnet-4-5";
export const FAST_MODEL = "claude-haiku-4-5-20251001";

export const __ai: {
  configured: boolean;
  fastReply: string;
  streamChunks: string[];
  failFast: Error | null;
  /** Index at which the stream throws; 0 means "before the first chunk". */
  failStreamAt: number | null;
  lastSystem: string | null;
  lastUser: string | null;
  /**
   * Every call in order, so a route that makes more than one model call can be
   * asserted per call. `lastSystem`/`lastUser` only ever describe the final
   * call, which is misleading for the simulate route: its interpretation call
   * is followed by a narration call that would overwrite them.
   */
  calls: Array<{ system: string; user: string }>;
  /** Set when the generator is returned early — proves upstream cancellation. */
  cancelled: boolean;
} = {
  configured: true, fastReply: "{}", streamChunks: ["ok"], failFast: null,
  failStreamAt: null, lastSystem: null, lastUser: null, calls: [], cancelled: false,
};

export function isAiConfigured(): boolean {
  return __ai.configured;
}

export async function callFast(system: string, user: string): Promise<string> {
  __ai.lastSystem = system;
  __ai.lastUser = user;
  __ai.calls.push({ system, user });
  if (__ai.failFast) throw __ai.failFast;
  return __ai.fastReply;
}

export async function* streamQuality(system: string, user: string): AsyncIterable<string> {
  __ai.lastSystem = system;
  __ai.lastUser = user;
  __ai.calls.push({ system, user });
  __ai.cancelled = false;
  try {
    for (let i = 0; i < __ai.streamChunks.length; i++) {
      if (__ai.failStreamAt === i) throw new Error("upstream failed");
      yield __ai.streamChunks[i];
    }
  } finally {
    __ai.cancelled = true;
  }
}
