/**
 * Focused tests for the smart-notification narrator (AI feature #7).
 *
 * The narrator is a safety-sensitive AI consumer: its output is persisted, and
 * an AI failure must never break an automation. Two invariants are tested here
 * without a network, by injecting a fake client through the client test seam:
 *
 *   - `sanitizeGeneratedBody` treats model output as untrusted: it collapses
 *     whitespace and returns `null` (→ the executor's deterministic sentence)
 *     for empty or over-long output, so junk never lands in the database.
 *   - `healthChangeNarrator` returns `null` when AI is not configured, sanitizes
 *     real output, and MEMOISES so several rules on one transition pay for a
 *     single model call (the cost safeguard).
 *
 * Run via test:domain.
 */
import {
  sanitizeGeneratedBody,
  healthChangeNarrator,
  MAX_GENERATED_BODY_CHARS,
  type HealthChangeContext,
} from "@/lib/ai/notification-narrator";
import { __setClientFactoryForTests } from "@/lib/ai/client";

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

const ctx: HealthChangeContext = {
  projectName: "Northwind Launch",
  previousBand: "Healthy",
  currentBand: "At Risk",
  score: 61,
  topFactor: { name: "Overdue tasks", pointsCost: 18 },
  openCount: 7,
  overdueCount: 2,
};

/** Fake client returning a fixed text for generateContent; counts calls. */
function fakeClientReturning(text: string) {
  const calls = { n: 0 };
  const client = {
    models: {
      generateContent() {
        calls.n += 1;
        return { text };
      },
      generateContentStream() {
        throw new Error("narrator must not stream");
      },
    },
  };
  return { client, calls };
}

async function main() {
  console.log("NOTIFICATION NARRATOR — fallback safety & memoisation\n");

  // ── sanitizeGeneratedBody ───────────────────────────────────────────────
  check("collapses whitespace/newlines to single spaces",
    sanitizeGeneratedBody("Project   moved\n\nto At Risk.") === "Project moved to At Risk.");
  check("trims and returns a normal sentence",
    sanitizeGeneratedBody("  Health dropped to 61.  ") === "Health dropped to 61.");
  check("empty string → null (fallback)", sanitizeGeneratedBody("") === null);
  check("whitespace-only → null (fallback)", sanitizeGeneratedBody("   \n  \t ") === null);
  check("over-long output → null (fallback)",
    sanitizeGeneratedBody("x".repeat(MAX_GENERATED_BODY_CHARS + 1)) === null);
  check("exactly max length → kept",
    sanitizeGeneratedBody("x".repeat(MAX_GENERATED_BODY_CHARS))?.length === MAX_GENERATED_BODY_CHARS);

  // ── healthChangeNarrator: not configured → null, no call ──────────────────
  const priorKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  {
    const f = fakeClientReturning("should not be called");
    __setClientFactoryForTests(() => f.client as never);
    const narrate = healthChangeNarrator(ctx);
    const r = await narrate();
    check("unconfigured → null (deterministic fallback)", r === null);
    check("unconfigured → no model call billed", f.calls.n === 0, `calls=${f.calls.n}`);
  }

  // ── configured: sanitizes real output + memoises ──────────────────────────
  process.env.GEMINI_API_KEY = "fake-test-key-NOT-A-SECRET-narrator";
  {
    const f = fakeClientReturning("Northwind Launch slipped to At Risk; 2 tasks overdue.");
    __setClientFactoryForTests(() => f.client as never);
    const narrate = healthChangeNarrator(ctx);
    const first = await narrate();
    const second = await narrate();
    check("configured → sanitized model sentence returned",
      first === "Northwind Launch slipped to At Risk; 2 tasks overdue.", String(first));
    check("memoised: two invocations → one model call (cost safeguard)", f.calls.n === 1, `calls=${f.calls.n}`);
    check("memoised value is stable across calls", first === second);
  }

  // ── configured but model returns junk → null (fallback, nothing persisted) ─
  {
    const f = fakeClientReturning("   ".repeat(5));
    __setClientFactoryForTests(() => f.client as never);
    const narrate = healthChangeNarrator(ctx);
    const r = await narrate();
    check("blank model output → null (no junk persisted)", r === null);
  }
  {
    const f = fakeClientReturning("y".repeat(MAX_GENERATED_BODY_CHARS + 50));
    __setClientFactoryForTests(() => f.client as never);
    const r = await healthChangeNarrator(ctx)();
    check("over-long model output → null (no junk persisted)", r === null);
  }

  __setClientFactoryForTests(null);
  if (priorKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = priorKey;

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
