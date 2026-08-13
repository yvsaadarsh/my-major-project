// TEST DOUBLE — scriptable model. No network.
export const QUALITY_MODEL = "claude-sonnet-4-5";
export const FAST_MODEL = "claude-haiku-4-5-20251001";
export const __ai: {
  configured: boolean; fastReply: string; streamChunks: string[];
  failFast: Error | null; failStreamAt: number | null;
  lastSystem: string | null; lastUser: string | null; cancelled: boolean;
} = { configured: true, fastReply: "{}", streamChunks: ["ok"], failFast: null, failStreamAt: null,
      lastSystem: null, lastUser: null, cancelled: false };
export function isAiConfigured(): boolean { return __ai.configured; }
export async function callFast(system: string, user: string): Promise<string> {
  __ai.lastSystem = system; __ai.lastUser = user;
  if (__ai.failFast) throw __ai.failFast;
  return __ai.fastReply;
}
export async function* streamQuality(system: string, user: string): AsyncIterable<string> {
  __ai.lastSystem = system; __ai.lastUser = user; __ai.cancelled = false;
  try {
    for (let i = 0; i < __ai.streamChunks.length; i++) {
      if (__ai.failStreamAt === i) throw new Error("upstream exploded mid-stream");
      yield __ai.streamChunks[i];
    }
  } finally {
    // Generator return() lands here — proves the route cancels upstream.
    __ai.cancelled = true;
  }
}
