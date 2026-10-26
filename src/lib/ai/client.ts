/**
 * Google Gemini SDK wrapper — the only place in the codebase that talks to a model.
 *
 * Deliberately a leaf module: no Prisma, no React, no tenant logic, no domain
 * imports. Callers hand it two strings and get text back. That keeps tenant
 * scoping and authorization where they belong (the guard + query layers) and
 * makes this file trivial to reason about.
 *
 * SERVER ONLY. `GEMINI_API_KEY` has no `NEXT_PUBLIC_` prefix, so importing this
 * from a Client Component fails at build rather than shipping a key — but do not
 * rely on that as the safety net. Call it from route handlers, server actions or
 * server components. The CSP (`connect-src 'self'`) assumes the browser never
 * reaches generativelanguage.googleapis.com; keep it that way.
 *
 * ## Reliability
 *
 * Every call is bounded two ways, using the SDK's own documented options (no
 * hand-rolled second retry layer — that would multiply attempts):
 *   - `httpOptions.timeout` caps each request (env `GEMINI_TIMEOUT_MS`).
 *   - `httpOptions.retryOptions` retries ONLY transient failures (timeout 408,
 *     rate limit 429, transient 5xx) a small, bounded number of times with the
 *     SDK's exponential backoff. Malformed (400) and auth/permission (401/403)
 *     failures are never retried. Streaming disables retries so a partially
 *     emitted response is never duplicated.
 */

import { GoogleGenAI, ApiError } from "@google/genai";

/**
 * A Pro model for output a human reads as prose — narratives, retrospectives,
 * forecasts. Slower and pricier, noticeably better at not sounding generic.
 * Overridable via `GEMINI_QUALITY_MODEL`.
 */
export const QUALITY_MODEL = process.env.GEMINI_QUALITY_MODEL?.trim() || "gemini-2.5-pro";

/**
 * A Flash model for short, structured, or high-volume work — JSON extraction,
 * one-line notifications. Fast enough to sit in a request path.
 * Overridable via `GEMINI_FAST_MODEL`.
 */
export const FAST_MODEL = process.env.GEMINI_FAST_MODEL?.trim() || "gemini-2.5-flash";

const QUALITY_MAX_TOKENS = 1024;
const FAST_MAX_TOKENS = 512;

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Per-request timeout in milliseconds. Bounded; env-overridable. */
export const REQUEST_TIMEOUT_MS = positiveIntEnv("GEMINI_TIMEOUT_MS", 30_000);

/**
 * Total attempts for a non-streaming call, INCLUDING the original (so 3 means
 * up to 2 retries). Hard-capped at 5 so a misconfigured env can never make the
 * client retry a slow endpoint into a pile-up.
 */
export const RETRY_ATTEMPTS = Math.min(positiveIntEnv("GEMINI_RETRY_ATTEMPTS", 3), 5);

/**
 * The ONLY statuses worth retrying: request timeout, rate limit, and transient
 * server errors. Deliberately excludes 400 (malformed — a retry repeats the
 * same bad request) and 401/403 (auth/permission — a retry cannot fix a key).
 */
export const RETRYABLE_STATUS_CODES = [408, 429, 500, 502, 503, 504];

/**
 * Cached across calls so we reuse the underlying connection pool. Built lazily:
 * constructing at module scope would throw during `next build`, which imports
 * every module without a runtime environment.
 */
type ClientFactory = () => GoogleGenAI;
let clientFactory: ClientFactory | null = null;
let cachedClient: GoogleGenAI | null = null;

function defaultFactory(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "GEMINI_API_KEY is not set. AI features require it — copy .env.example " +
        "to .env and add a key from https://aistudio.google.com/apikey",
    );
  }
  return new GoogleGenAI({ apiKey });
}

function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  cachedClient = (clientFactory ?? defaultFactory)();
  return cachedClient;
}

/**
 * Test seam ONLY. Injects a fake client (and clears the cache) so the retry,
 * timeout, config and error-normalization behaviour can be exercised without a
 * network or a real key. Pass `null` to restore the real factory.
 */
export function __setClientFactoryForTests(factory: ClientFactory | null): void {
  clientFactory = factory;
  cachedClient = null;
}

/**
 * The shared HTTP policy: bounded timeout plus the SDK's own transient-only
 * retry. Centralized so both entry points apply one policy and a test can
 * assert it without reaching the network. `retry` is false for streaming, where
 * a retried request could duplicate already-emitted text.
 */
export function buildHttpOptions(retry: boolean): {
  timeout: number;
  retryOptions: { attempts: number; httpStatusCodes: number[] };
} {
  return {
    timeout: REQUEST_TIMEOUT_MS,
    retryOptions: {
      // attempts === 1 means "no retries" per the SDK contract.
      attempts: retry ? RETRY_ATTEMPTS : 1,
      httpStatusCodes: RETRYABLE_STATUS_CODES,
    },
  };
}

/**
 * Remove the API key from any text before it becomes an Error message. The SDK
 * puts the server's error string on `ApiError.message` (not our request body),
 * but a defence-in-depth scrub means a key can never reach a log line even if a
 * future SDK version echoes more.
 */
function redactSecrets(text: string): string {
  const key = process.env.GEMINI_API_KEY;
  if (key && key.length >= 8 && text.includes(key)) {
    return text.split(key).join("[redacted-key]");
  }
  return text;
}

/**
 * Normalize anything the SDK throws into a plain `Error` with a message that is
 * safe to log: a status code and the server's short message (scrubbed), never
 * the request body, the key, or the SDK's full error object.
 *
 * Developer-facing. Do not put it in an HTTP response body; throw `ApiError`
 * from the route handler instead.
 */
export function toCleanError(error: unknown, operation: string): Error {
  if (error instanceof ApiError) {
    const status = error.status ?? "unknown";
    if (error.status === 401 || error.status === 403) {
      return new Error(
        `${operation} failed: Google rejected the API key (${status}). Check GEMINI_API_KEY.`,
      );
    }
    if (error.status === 429) {
      return new Error(
        `${operation} failed: rate limited by Google (429) after retries. Retry later.`,
      );
    }
    if (typeof error.status === "number" && error.status >= 500) {
      return new Error(
        `${operation} failed: Gemini service error (${status}) after retries. This is retryable.`,
      );
    }
    return new Error(
      `${operation} failed: Gemini API error ${status} — ${redactSecrets(error.message)}`,
    );
  }

  if (error instanceof Error) {
    const msg = error.message || "";
    // The SDK surfaces a deadline/cancellation as an AbortError or a timeout
    // message. Distinguish it from an unreachable host so an operator knows
    // whether to raise the timeout or fix egress.
    if (error.name === "AbortError" || /timed? ?out|deadline|abort/i.test(msg)) {
      return new Error(
        `${operation} failed: Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
      );
    }
    if (
      error.name === "TypeError" ||
      /fetch failed|network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)
    ) {
      return new Error(`${operation} failed: could not reach Gemini. Check network egress.`);
    }
    return new Error(`${operation} failed: ${redactSecrets(msg)}`);
  }

  return new Error(`${operation} failed: unknown error`);
}

/**
 * Stream a high-quality completion, yielding text as it arrives.
 *
 * Bounded by `REQUEST_TIMEOUT_MS`; retries are disabled here so a partially
 * emitted response is never duplicated. Pass `options.signal` to cancel —
 * abandoning the `for await` (break / client disconnect) also closes the
 * upstream request via the generator's `return`, so a cancelled request stops
 * billing rather than running to completion.
 *
 * Errors surface on the first `next()` that hits them, so wrap the `for await`,
 * not just the call that creates the iterable.
 */
export async function* streamQuality(
  systemPrompt: string,
  userPrompt: string,
  options?: { signal?: AbortSignal },
): AsyncIterable<string> {
  const client = getClient();

  try {
    const stream = await client.models.generateContentStream({
      model: QUALITY_MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: QUALITY_MAX_TOKENS,
        httpOptions: buildHttpOptions(false),
        ...(options?.signal ? { abortSignal: options.signal } : {}),
      },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield text;
    }
  } catch (error) {
    throw toCleanError(error, "streamQuality");
  }
}

/**
 * Run a fast completion and return the whole text.
 *
 * Bounded by `REQUEST_TIMEOUT_MS` and retried (transient failures only) up to
 * `RETRY_ATTEMPTS` by the SDK. Returns the response text, trimmed; returns `""`
 * if the model produced no text, which is a real outcome worth handling rather
 * than an error. Pass `options.signal` to cancel.
 */
export async function callFast(
  systemPrompt: string,
  userPrompt: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const client = getClient();

  try {
    const response = await client.models.generateContent({
      model: FAST_MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: FAST_MAX_TOKENS,
        httpOptions: buildHttpOptions(true),
        ...(options?.signal ? { abortSignal: options.signal } : {}),
      },
    });

    return (response.text ?? "").trim();
  } catch (error) {
    throw toCleanError(error, "callFast");
  }
}

/**
 * Whether a key is configured. Lets a caller degrade gracefully — hide an AI
 * panel, skip an enrichment step — instead of throwing on a missing key.
 */
export function isAiConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}
