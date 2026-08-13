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
  /** Set when the generator is returned early — proves upstream cancellation. */
  cancelled: boolean;
} = {
  configured: true, fastReply: "{}", streamChunks: ["ok"], failFast: null,
  failStreamAt: null, lastSystem: null, lastUser: null, cancelled: false,
};

export function isAiConfigured(): boolean {
  return __ai.configured;
}

export async function callFast(system: string, user: string): Promise<string> {
  __ai.lastSystem = system;
  __ai.lastUser = user;
  if (__ai.failFast) throw __ai.failFast;
  return __ai.fastReply;
}

export async function* streamQuality(system: string, user: string): AsyncIterable<string> {
  __ai.lastSystem = system;
  __ai.lastUser = user;
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
