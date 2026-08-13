/**
 * Anthropic SDK wrapper — the only place in the codebase that talks to a model.
 *
 * Deliberately a leaf module: no Prisma, no React, no tenant logic, no domain
 * imports. Callers hand it two strings and get text back. That keeps tenant
 * scoping and authorization where they belong (the guard + query layers) and
 * makes this file trivial to reason about.
 *
 * SERVER ONLY. `ANTHROPIC_API_KEY` has no `NEXT_PUBLIC_` prefix, so importing
 * this from a Client Component fails at build rather than shipping a key — but
 * do not rely on that as the safety net. Call it from route handlers, server
 * actions or server components. The CSP (`connect-src 'self'`) assumes the
 * browser never reaches api.anthropic.com; keep it that way.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Sonnet for output a human reads as prose — narratives, retrospectives,
 * forecasts. Slower and pricier, noticeably better at not sounding generic.
 */
export const QUALITY_MODEL = "claude-sonnet-4-5";

/**
 * Haiku for short, structured, or high-volume work — JSON extraction, one-line
 * notifications. Fast enough to sit in a request path.
 */
export const FAST_MODEL = "claude-haiku-4-5-20251001";

const QUALITY_MAX_TOKENS = 1024;
const FAST_MAX_TOKENS = 512;

/**
 * Cached across calls so we reuse the underlying connection pool. Built lazily:
 * constructing at module scope would throw during `next build`, which imports
 * every module without a runtime environment.
 */
let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. AI features require it — copy .env.example " +
        "to .env and add a key from https://console.anthropic.com/settings/keys",
    );
  }

  cachedClient = new Anthropic({ apiKey });
  return cachedClient;
}

/**
 * Normalize anything the SDK throws into a plain `Error` with a message that is
 * safe to log.
 *
 * Two reasons this is not a passthrough. First, `APIError` stringifies with the
 * request body attached, and our prompts can contain tenant data — that must not
 * land in a log line. Second, callers should not have to import the SDK's error
 * classes to handle a failure.
 *
 * The message is still developer-facing. Do not put it in an HTTP response body;
 * throw `ApiError` from the route handler instead.
 */
function toCleanError(error: unknown, operation: string): Error {
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? "unknown";

    // Map the cases an operator actually needs to distinguish.
    if (error.status === 401) {
      return new Error(
        `${operation} failed: Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.`,
      );
    }
    if (error.status === 429) {
      return new Error(
        `${operation} failed: rate limited by Anthropic (429). Retry with backoff.`,
      );
    }
    if (typeof error.status === "number" && error.status >= 500) {
      return new Error(
        `${operation} failed: Anthropic service error (${status}). This is retryable.`,
      );
    }

    return new Error(`${operation} failed: Anthropic API error ${status} — ${error.message}`);
  }

  if (error instanceof Anthropic.APIConnectionError) {
    return new Error(`${operation} failed: could not reach Anthropic. Check network egress.`);
  }

  if (error instanceof Error) {
    return new Error(`${operation} failed: ${error.message}`);
  }

  return new Error(`${operation} failed: unknown error`);
}

/**
 * Stream a high-quality completion, yielding text as it arrives.
 *
 * Use where the user watches the words appear. The caller owns the transport —
 * pipe the chunks into a `ReadableStream` in a route handler.
 *
 * Yields only text deltas; non-text blocks and streaming metadata are dropped.
 * Errors surface on the first `next()` that hits them, so wrap the `for await`,
 * not just the call that creates the iterable.
 *
 * Abandoning the loop (`break`, or the client disconnecting) closes the upstream
 * request via the generator's `return`, so a cancelled request stops billing
 * rather than running to completion in the background.
 */
export async function* streamQuality(
  systemPrompt: string,
  userPrompt: string,
): AsyncIterable<string> {
  const client = getClient();

  try {
    const stream = await client.messages.create({
      model: QUALITY_MODEL,
      max_tokens: QUALITY_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      stream: true,
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
  } catch (error) {
    throw toCleanError(error, "streamQuality");
  }
}

/**
 * Run a fast completion and return the whole text.
 *
 * Use for short or structured output — JSON extraction, a one-line notification —
 * where streaming buys nothing and the caller needs the full string before it can
 * do anything (you cannot `JSON.parse` half a document).
 *
 * Returns concatenated text blocks, trimmed. Returns `""` if the model produced
 * no text, which is a real outcome worth handling rather than an error.
 */
export async function callFast(systemPrompt: string, userPrompt: string): Promise<string> {
  const client = getClient();

  try {
    const message = await client.messages.create({
      model: FAST_MODEL,
      max_tokens: FAST_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  } catch (error) {
    throw toCleanError(error, "callFast");
  }
}

/**
 * Whether a key is configured. Lets a caller degrade gracefully — hide an AI
 * panel, skip an enrichment step — instead of throwing on a missing key.
 */
export function isAiConfigured(): boolean {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}
