/**
 * Unit tests for the REAL Gemini client wrapper (`@/lib/ai/client`), run with
 * the normal tsconfig so `@/lib/ai/client` resolves to the real module — NOT
 * the `scripts/doubles/ai-client.ts` double that `npm run test:ai` substitutes.
 *
 * These exercise the reliability and safety surface WITHOUT a network or a real
 * key, by injecting a fake GoogleGenAI through the client's test seam:
 *   - the request config carries the bounded timeout and the transient-only
 *     retry policy (and streaming disables retries);
 *   - transient vs auth vs timeout vs network errors are normalized correctly;
 *   - a configured API key is never echoed into an error message;
 *   - streaming yields text and surfaces a mid-stream failure as a clean error.
 *
 * The retry/backoff MECHANISM itself is the SDK's own tested HTTP layer; we
 * assert that we CONFIGURE it correctly (attempts bounded, only transient codes,
 * no retries while streaming), not that the SDK's loop works.
 *
 * Run:  npm run test:ai:client
 */
import { ApiError } from "@google/genai";
import {
  callFast,
  streamQuality,
  toCleanError,
  buildHttpOptions,
  isAiConfigured,
  __setClientFactoryForTests,
  QUALITY_MODEL,
  FAST_MODEL,
  RETRY_ATTEMPTS,
  RETRYABLE_STATUS_CODES,
  REQUEST_TIMEOUT_MS,
} from "@/lib/ai/client";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A fake client that records the args it was called with and returns/throws
 *  whatever the test configures. Shaped like the slice of GoogleGenAI we use. */
type GenArgs = { model: string; contents: unknown; config: Record<string, unknown> };
function fakeClient(opts: {
  onGenerate?: (args: GenArgs) => unknown;
  onStream?: (args: GenArgs) => AsyncIterable<{ text?: string }>;
}) {
  const calls: { generate: GenArgs[]; stream: GenArgs[] } = { generate: [], stream: [] };
  const client = {
    models: {
      generateContent(args: GenArgs) {
        calls.generate.push(args);
        const r = opts.onGenerate ? opts.onGenerate(args) : { text: "ok" };
        if (r instanceof Error) throw r;
        return r;
      },
      generateContentStream(args: GenArgs) {
        calls.stream.push(args);
        if (!opts.onStream) {
          return (async function* () {
            yield { text: "hello " };
            yield { text: "world" };
          })();
        }
        return opts.onStream(args);
      },
    },
  };
  return { client, calls };
}

async function main() {
  console.log("AI CLIENT — reliability & safety unit tests\n");

  // ── config policy ─────────────────────────────────────────────────────────
  const retryCfg = buildHttpOptions(true);
  const streamCfg = buildHttpOptions(false);
  check("timeout is bounded and positive", REQUEST_TIMEOUT_MS > 0 && REQUEST_TIMEOUT_MS <= 120_000,
    String(REQUEST_TIMEOUT_MS));
  check("retry attempts are small and bounded (<=5, >=1)", RETRY_ATTEMPTS >= 1 && RETRY_ATTEMPTS <= 5,
    String(RETRY_ATTEMPTS));
  check("non-stream config applies the retry attempts", retryCfg.retryOptions.attempts === RETRY_ATTEMPTS);
  check("stream config disables retries (attempts === 1)", streamCfg.retryOptions.attempts === 1);
  check("only transient codes are retryable (429 & 503 in, 400/401/403/404 out)",
    [429, 503].every((c) => RETRYABLE_STATUS_CODES.includes(c)) &&
      [400, 401, 403, 404].every((c) => !RETRYABLE_STATUS_CODES.includes(c)));
  check("both configs carry the bounded timeout",
    retryCfg.timeout === REQUEST_TIMEOUT_MS && streamCfg.timeout === REQUEST_TIMEOUT_MS);

  // ── callFast: happy path + config wiring ───────────────────────────────────
  {
    const { client, calls } = fakeClient({ onGenerate: () => ({ text: "  trimmed me  " }) });
    __setClientFactoryForTests(() => client as never);
    const out = await callFast("SYS", "USER");
    check("callFast returns trimmed model text", out === "trimmed me", JSON.stringify(out));
    const arg = calls.generate[0];
    check("callFast uses the FAST model", arg.model === FAST_MODEL, arg?.model);
    check("callFast sends systemInstruction + maxOutputTokens",
      arg.config.systemInstruction === "SYS" && typeof arg.config.maxOutputTokens === "number");
    const http = arg.config.httpOptions as { timeout: number; retryOptions: { attempts: number } };
    check("callFast request carries timeout + retry attempts",
      http.timeout === REQUEST_TIMEOUT_MS && http.retryOptions.attempts === RETRY_ATTEMPTS);
    check("callFast returns '' when the model produced no text",
      (await (async () => {
        const f = fakeClient({ onGenerate: () => ({ text: undefined }) });
        __setClientFactoryForTests(() => f.client as never);
        return callFast("S", "U");
      })()) === "");
  }

  // ── callFast: error classification (no retry for auth/malformed) ────────────
  async function callFastThrowing(err: unknown): Promise<string> {
    const { client } = fakeClient({ onGenerate: () => err as Error });
    __setClientFactoryForTests(() => client as never);
    try {
      await callFast("S", "U");
      return "<no throw>";
    } catch (e) {
      return (e as Error).message;
    }
  }
  check("401 → key-rejected message",
    (await callFastThrowing(new ApiError({ message: "bad key", status: 401 }))).includes("rejected the API key"));
  check("403 → key-rejected message",
    (await callFastThrowing(new ApiError({ message: "forbidden", status: 403 }))).includes("rejected the API key"));
  check("429 → rate-limited message",
    (await callFastThrowing(new ApiError({ message: "slow down", status: 429 }))).includes("rate limited"));
  check("503 → retryable service-error message",
    (await callFastThrowing(new ApiError({ message: "unavailable", status: 503 }))).includes("retryable"));
  check("timeout/abort → timed-out message",
    (await callFastThrowing(Object.assign(new Error("deadline exceeded"), { name: "AbortError" }))).includes("timed out"));
  check("DNS/egress → could-not-reach message",
    (await callFastThrowing(Object.assign(new Error("fetch failed"), { cause: "ENOTFOUND" }))).includes("could not reach"));

  // ── redaction: the key never reaches an error message ───────────────────────
  {
    const prior = process.env.GEMINI_API_KEY;
    const sentinel = "fake-test-key-NOT-A-SECRET-1234567890";
    process.env.GEMINI_API_KEY = sentinel;
    const leaky = new ApiError({ message: `bad request near ${sentinel} here`, status: 400 });
    const cleaned = toCleanError(leaky, "callFast").message;
    check("toCleanError scrubs the API key from a 400 message",
      !cleaned.includes(sentinel) && cleaned.includes("[redacted-key]"));
    const leaky2 = toCleanError(new Error(`oops ${sentinel}`), "x").message;
    check("toCleanError scrubs the key from a generic Error", !leaky2.includes(sentinel));
    check("isAiConfigured true when key set", isAiConfigured() === true);
    if (prior === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prior;
  }

  // ── streamQuality: yields text, uses QUALITY model, no-retry, surfaces error ─
  {
    const { client, calls } = fakeClient({});
    __setClientFactoryForTests(() => client as never);
    let acc = "";
    for await (const t of streamQuality("SYS", "USER")) acc += t;
    check("streamQuality concatenates text chunks", acc === "hello world", JSON.stringify(acc));
    const arg = calls.stream[0];
    check("streamQuality uses the QUALITY model", arg.model === QUALITY_MODEL, arg?.model);
    const http = arg.config.httpOptions as { retryOptions: { attempts: number } };
    check("streamQuality disables retries (no duplicate output)", http.retryOptions.attempts === 1);
  }
  {
    const { client } = fakeClient({
      onStream: () =>
        (async function* () {
          yield { text: "partial" };
          throw new ApiError({ message: "mid-stream boom", status: 500 });
        })(),
    });
    __setClientFactoryForTests(() => client as never);
    let threw = "";
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of streamQuality("S", "U")) {
        /* consume */
      }
    } catch (e) {
      threw = (e as Error).message;
    }
    check("streamQuality surfaces a mid-stream failure as a clean error",
      threw.includes("streamQuality failed") && threw.includes("retryable"));
  }

  __setClientFactoryForTests(null);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exitCode = 1;
});
