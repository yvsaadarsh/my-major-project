/**
 * Behavioral tests for the model-output parsing helpers.
 *
 * Run with Node 22+:
 *   node --experimental-strip-types scripts/test-parse-helpers.ts
 *
 * These functions sit directly on the trust boundary described in AGENTS.md
 * rule 5: model output is untrusted input. Every case below is a shape a model
 * has plausibly returned — fenced JSON, prose wrapped around an object, a
 * lowercase priority, a date in the wrong format — and the assertion is that
 * none of them can produce a value the rest of the system would trust.
 *
 * `parse-helpers.ts` imports nothing, which is what makes this testable without
 * a database, a key, or a request.
 */

import {
  PRIORITIES,
  extractJsonObject,
  normalizeDate,
  normalizePriority,
} from "../src/lib/ai/parse-helpers.ts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${name}`);
  if (detail !== undefined) {
    console.error(`        got: ${JSON.stringify(detail)}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
section("extractJsonObject — the happy path");
{
  check(
    "parses a bare object",
    extractJsonObject('{"title":"Ship it"}')?.title === "Ship it",
  );
  check(
    "tolerates surrounding whitespace",
    extractJsonObject('  \n {"title":"Ship it"} \n ')?.title === "Ship it",
  );
}

// ---------------------------------------------------------------------------
section("extractJsonObject — fenced output");
{
  check(
    "strips a ```json fence",
    extractJsonObject('```json\n{"title":"Ship it"}\n```')?.title === "Ship it",
  );
  check(
    "strips a bare ``` fence",
    extractJsonObject('```\n{"title":"Ship it"}\n```')?.title === "Ship it",
  );
  check(
    "strips an uppercase ```JSON fence",
    extractJsonObject('```JSON\n{"title":"Ship it"}\n```')?.title === "Ship it",
  );
}

// ---------------------------------------------------------------------------
section("extractJsonObject — prose around the object");
{
  const withPreamble = extractJsonObject(
    'Sure! Here is the task you asked for:\n{"title":"Ship it"}\nLet me know if that works.',
  );

  check("recovers an object buried in prose", withPreamble?.title === "Ship it", withPreamble);

  const nested = extractJsonObject('junk {"a":{"b":2}} junk');
  check("spans to the outermost brace", JSON.stringify(nested) === '{"a":{"b":2}}', nested);
}

// ---------------------------------------------------------------------------
section("extractJsonObject — everything that must return null");
{
  check("empty string", extractJsonObject("") === null);
  check("whitespace only", extractJsonObject("   \n  ") === null);
  check("plain prose with no braces", extractJsonObject("I could not do that.") === null);
  check("truncated object", extractJsonObject('{"title":"Ship') === null);
  check("a JSON string is not an object", extractJsonObject('"just a string"') === null);
  check("a JSON number is not an object", extractJsonObject("42") === null);
  check("JSON null is not an object", extractJsonObject("null") === null);
  check("a closing brace before an opening one", extractJsonObject("} {") === null);
}

// ---------------------------------------------------------------------------
section("extractJsonObject — a wrapping array is unwrapped, not rejected");
{
  // The top-level array is rejected by the `!Array.isArray` guard, but the
  // brace-span fallback then recovers the object inside it. That is the
  // intended outcome — a model that wrapped its single task in a list still
  // produced a usable task — and the route's own `title` check remains the
  // thing that decides whether the result is worth returning.
  const single = extractJsonObject('[{"title":"Ship it"}]');
  check("recovers the object from a one-element array", single?.title === "Ship it", single);

  // The limit of that leniency: with two elements the span covers both, which
  // is not valid JSON, so nothing is returned.
  const two = extractJsonObject('[{"title":"a"},{"title":"b"}]');
  check("a two-element array yields null", two === null, two);
}

// ---------------------------------------------------------------------------
section("normalizePriority — the known vocabulary");
{
  for (const priority of PRIORITIES) {
    check(`accepts ${priority}`, normalizePriority(priority) === priority);
  }

  check("uppercases lowercase input", normalizePriority("high") === "HIGH");
  check("trims surrounding whitespace", normalizePriority("  urgent  ") === "URGENT");
  check("handles mixed case", normalizePriority("MeDiUm") === "MEDIUM");
}

// ---------------------------------------------------------------------------
section("normalizePriority — everything else falls back to MEDIUM");
{
  check("an unknown word", normalizePriority("CRITICAL") === "MEDIUM");
  check("an empty string", normalizePriority("") === "MEDIUM");
  check("null", normalizePriority(null) === "MEDIUM");
  check("undefined", normalizePriority(undefined) === "MEDIUM");
  check("a number", normalizePriority(3) === "MEDIUM");
  check("an object", normalizePriority({ priority: "HIGH" }) === "MEDIUM");
  check("an array", normalizePriority(["HIGH"]) === "MEDIUM");
}

// ---------------------------------------------------------------------------
section("normalizeDate — accepts only a bare calendar date");
{
  check("a plain YYYY-MM-DD", normalizeDate("2026-08-19") === "2026-08-19");
  check("trims surrounding whitespace", normalizeDate("  2026-08-19 ") === "2026-08-19");
}

// ---------------------------------------------------------------------------
section("normalizeDate — everything else is null");
{
  check("a full ISO datetime", normalizeDate("2026-08-19T00:00:00.000Z") === null);
  check("a US-style date", normalizeDate("08/19/2026") === null);
  check("a spelled-out date", normalizeDate("August 19, 2026") === null);
  check("a relative phrase", normalizeDate("next Friday") === null);
  check("a single-digit month", normalizeDate("2026-8-19") === null);
  check("an empty string", normalizeDate("") === null);
  check("null", normalizeDate(null) === null);
  check("undefined", normalizeDate(undefined) === null);
  check("a Date object", normalizeDate(new Date()) === null);
  check("a number", normalizeDate(1755561600000) === null);
}

// ---------------------------------------------------------------------------
section("normalizeDate — shape is checked, calendar validity is not");
{
  // Documented, deliberate: the regex guards the *format* so the value is safe
  // to hand to `new Date(...)` downstream. It is not a calendar validator, and
  // a caller must not assume it rejects an impossible day.
  check("a well-formed but impossible date still passes", normalizeDate("2026-02-31") === "2026-02-31");
}

// ---------------------------------------------------------------------------
section("determinism");
{
  const raw = '```json\n{"title":"Ship it","priority":"high","dueDate":"2026-08-19"}\n```';
  const first = JSON.stringify(extractJsonObject(raw));

  let stable = true;
  for (let index = 0; index < 200; index += 1) {
    if (JSON.stringify(extractJsonObject(raw)) !== first) {
      stable = false;
      break;
    }
  }

  check("extractJsonObject is deterministic over 200 runs", stable);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
