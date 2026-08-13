/**
 * Behavioral tests for the auth policy domain layer.
 *
 * Run with Node 22+:
 *   node --experimental-strip-types scripts/test-auth-policy.ts
 *
 * These are real assertions against real behaviour, not smoke tests. Every
 * threshold in auth-policy.ts is exercised from both sides of the boundary.
 */

import {
  ATTEMPT_WINDOW_SECONDS,
  LOCKOUT_BASE_SECONDS,
  LOCKOUT_MAX_SECONDS,
  LOCKOUT_THRESHOLD,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_SCORE,
  assessPassword,
  attemptsRemaining,
  describeLockout,
  initialLockoutState,
  isLocked,
  isSessionEpochCurrent,
  lockDurationSeconds,
  lockRemainingSeconds,
  registerFailure,
  registerSuccess,
  type LockoutState,
} from "../src/lib/domain/auth-policy.ts";

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

const NOW = new Date("2026-08-12T12:00:00.000Z");
const at = (secondsFromNow: number) => new Date(NOW.getTime() + secondsFromNow * 1000);

// ---------------------------------------------------------------------------
section("Password — hard rules");
// ---------------------------------------------------------------------------

{
  const short = assessPassword("Ab3$xy");
  check("too short is rejected", !short.acceptable, short);
  check(
    "too short explains the minimum",
    short.problems.some((p) => p.includes(String(PASSWORD_MIN_LENGTH))),
    short.problems,
  );
}

{
  const long = assessPassword("A1$".repeat(40));
  check("over bcrypt's 72-byte limit is rejected", !long.acceptable);
  check(
    "over-length explains the maximum",
    long.problems.some((p) => p.includes(String(PASSWORD_MAX_LENGTH))),
    long.problems,
  );
}

{
  const padded = assessPassword(" Str0ng!Phrase ");
  check("leading/trailing space is rejected", !padded.acceptable);
  check(
    "whitespace problem is specific",
    padded.problems.some((p) => p.toLowerCase().includes("space")),
    padded.problems,
  );
}

{
  const repeated = assessPassword("Passsssword12!");
  check("long repeat run is rejected", !repeated.acceptable, repeated);
  const twoInARow = assessPassword("Bookkeeper42!x");
  check("only two in a row is allowed", twoInARow.acceptable, twoInARow);
}

{
  const walk = assessPassword("qwertyuiop12!");
  check("keyboard walk is rejected", !walk.acceptable, walk);
  const digits = assessPassword("Zx9!march3456");
  check("digit run is rejected", !digits.acceptable, digits);
  const reversed = assessPassword("Zx9!poiuytrewq");
  check("reversed keyboard walk is rejected", !reversed.acceptable, reversed);
}

{
  // Decoration stripping: the year and bang must not rescue a common word.
  for (const candidate of ["password2024", "Password123!", "letmein2026", "welcome1999"]) {
    const result = assessPassword(candidate);
    check(`common password "${candidate}" is rejected`, !result.acceptable, result.problems);
  }
}

{
  const selfEmail = assessPassword("alice-Str0ng!x", { email: "alice@corp.com" });
  check("password containing email local part is rejected", !selfEmail.acceptable, selfEmail);

  const selfName = assessPassword("Chenchen99!ab", { name: "Alice Chen" });
  check("password containing surname is rejected", !selfName.acceptable, selfName);

  const shortToken = assessPassword("Str0ng!Phrasex", { email: "al@corp.com" });
  check("2-char local part does not reject everything", shortToken.acceptable, shortToken);
}

// ---------------------------------------------------------------------------
section("Password — scoring");
// ---------------------------------------------------------------------------

{
  const weak = assessPassword("lowercaseonly");
  check("single class scores low", weak.score <= 1, weak);

  const fair = assessPassword("Bluetiger42");
  check("mixed classes at 11 chars is acceptable", fair.acceptable, fair);

  const strong = assessPassword("Bluetiger42!wax");
  check("15 chars, 4 classes scores >= 3", strong.score >= 3, strong);

  const excellent = assessPassword("Bluetiger42!waxpolish");
  check("21 chars, 4 classes scores 4", excellent.score === 4, excellent);
}

{
  const lowVariety = assessPassword("ababababababab");
  check("low distinct ratio loses a point", lowVariety.score <= 2, lowVariety);
}

{
  const all = assessPassword("Bluetiger42!wax");
  check("score maps to a label", all.label === "strong" || all.label === "excellent", all.label);
  check("acceptable password has no problems", all.problems.length === 0, all.problems);
}

{
  // Every acceptable password must clear the documented score bar, and every
  // rejection must carry at least one reason. This is the invariant that keeps
  // the API response and the UI meter in agreement.
  const samples = [
    "Bluetiger42!wax",
    "short",
    "password",
    "correct horse battery",
    "Zx9!march3456",
    "Bluetiger42",
    "aaaaaaaaaaaa",
    "  spaced out  ",
    "Tr0ubad0ur&Fig",
  ];

  for (const sample of samples) {
    const result = assessPassword(sample);
    if (result.acceptable) {
      check(
        `acceptable "${sample}" clears score bar`,
        result.score >= PASSWORD_MIN_SCORE && result.problems.length === 0,
        result,
      );
    } else {
      check(`rejected "${sample}" gives a reason`, result.problems.length > 0, result);
    }
  }
}

{
  const empty = assessPassword("");
  check("empty password is rejected without throwing", !empty.acceptable, empty);
  check("empty password scores 0", empty.score === 0, empty);
}

// ---------------------------------------------------------------------------
section("Lockout — thresholds and backoff");
// ---------------------------------------------------------------------------

{
  const fresh = initialLockoutState();
  check("fresh state is not locked", !isLocked(fresh, NOW));
  check("fresh state has full attempts", attemptsRemaining(fresh, NOW) === LOCKOUT_THRESHOLD);
  check("fresh state has no remaining seconds", lockRemainingSeconds(fresh, NOW) === 0);
}

{
  // Walk up to the threshold one failure at a time, all inside the window.
  let state: LockoutState = initialLockoutState();

  for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt += 1) {
    state = registerFailure(state, at(attempt));
    check(`failure ${attempt} does not lock`, !isLocked(state, at(attempt)), state);
    check(
      `failure ${attempt} decrements remaining`,
      attemptsRemaining(state, at(attempt)) === LOCKOUT_THRESHOLD - attempt,
      attemptsRemaining(state, at(attempt)),
    );
  }

  state = registerFailure(state, at(LOCKOUT_THRESHOLD));
  check("threshold failure locks", isLocked(state, at(LOCKOUT_THRESHOLD)), state);
  check(
    "first lock is the base duration",
    lockRemainingSeconds(state, at(LOCKOUT_THRESHOLD)) === LOCKOUT_BASE_SECONDS,
    lockRemainingSeconds(state, at(LOCKOUT_THRESHOLD)),
  );
  check("locked state reports 0 attempts remaining", attemptsRemaining(state, at(LOCKOUT_THRESHOLD)) === 0);
}

{
  check("below threshold has no duration", lockDurationSeconds(LOCKOUT_THRESHOLD - 1) === 0);
  check("at threshold uses base", lockDurationSeconds(LOCKOUT_THRESHOLD) === LOCKOUT_BASE_SECONDS);
  check(
    "each extra failure doubles",
    lockDurationSeconds(LOCKOUT_THRESHOLD + 1) === LOCKOUT_BASE_SECONDS * 2 &&
      lockDurationSeconds(LOCKOUT_THRESHOLD + 2) === LOCKOUT_BASE_SECONDS * 4 &&
      lockDurationSeconds(LOCKOUT_THRESHOLD + 3) === LOCKOUT_BASE_SECONDS * 8,
  );
  check(
    "duration is capped and never exceeds the max",
    lockDurationSeconds(LOCKOUT_THRESHOLD + 50) === LOCKOUT_MAX_SECONDS,
    lockDurationSeconds(LOCKOUT_THRESHOLD + 50),
  );
  check(
    "cap holds for absurd counts",
    lockDurationSeconds(100000) === LOCKOUT_MAX_SECONDS,
  );
}

{
  // Lock expiry: once the clock passes lockedUntil, the account is usable again
  // even though the failure count is still high.
  let state = initialLockoutState();
  for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD; attempt += 1) {
    state = registerFailure(state, at(attempt));
  }

  const lockedAt = at(LOCKOUT_THRESHOLD);
  check("locked immediately after", isLocked(state, lockedAt));
  check(
    "still locked one second before expiry",
    isLocked(state, new Date(lockedAt.getTime() + (LOCKOUT_BASE_SECONDS - 1) * 1000)),
  );
  check(
    "unlocked exactly at expiry",
    !isLocked(state, new Date(lockedAt.getTime() + LOCKOUT_BASE_SECONDS * 1000)),
  );
}

// ---------------------------------------------------------------------------
section("Lockout — rolling window");
// ---------------------------------------------------------------------------

{
  // Four failures, then a long gap, then one more: must NOT lock, because the
  // window rolled over and the counter restarted.
  let state = initialLockoutState();
  for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt += 1) {
    state = registerFailure(state, at(attempt));
  }
  check("four failures do not lock", !isLocked(state, at(LOCKOUT_THRESHOLD - 1)));

  const afterWindow = at(ATTEMPT_WINDOW_SECONDS + 60);
  state = registerFailure(state, afterWindow);
  check("failure after the window restarts the count", state.failedCount === 1, state);
  check("failure after the window does not lock", !isLocked(state, afterWindow), state);
  check(
    "attempts remaining resets after the window",
    attemptsRemaining(state, afterWindow) === LOCKOUT_THRESHOLD - 1,
  );
}

{
  // A failure exactly at the window boundary still counts as inside the window
  // (the check is strictly greater than), so the count continues.
  let state = initialLockoutState();
  state = registerFailure(state, NOW);
  const boundary = at(ATTEMPT_WINDOW_SECONDS);
  state = registerFailure(state, boundary);
  check("boundary failure continues the count", state.failedCount === 2, state);

  const past = at(ATTEMPT_WINDOW_SECONDS * 2 + 1);
  const next = registerFailure(state, past);
  check("one second past the window restarts", next.failedCount === 1, next);
}

{
  // A stale state whose window has expired reports full attempts even though
  // failedCount is still high — the UI should not warn a returning user.
  const stale: LockoutState = {
    failedCount: 4,
    lastFailedAt: new Date(NOW.getTime() - (ATTEMPT_WINDOW_SECONDS + 10) * 1000),
    lockedUntil: null,
  };
  check("stale failures do not warn", attemptsRemaining(stale, NOW) === LOCKOUT_THRESHOLD, stale);
}

{
  const state = registerFailure(initialLockoutState(), NOW);
  const cleared = registerSuccess();
  check("success clears the count", cleared.failedCount === 0, cleared);
  check("success clears the lock", cleared.lockedUntil === null, cleared);
  check("success differs from the failed state", state.failedCount !== cleared.failedCount);
}

// ---------------------------------------------------------------------------
section("Lockout — user-facing copy");
// ---------------------------------------------------------------------------

{
  check("zero reads as now", describeLockout(0) === "now", describeLockout(0));
  check("one second is singular", describeLockout(1) === "1 second", describeLockout(1));
  check("sub-minute stays in seconds", describeLockout(45) === "45 seconds", describeLockout(45));
  check("one minute is singular", describeLockout(60) === "about 1 minute", describeLockout(60));
  check("rounds up to minutes", describeLockout(90) === "about 2 minutes", describeLockout(90));
  check("switches to hours", describeLockout(3600) === "about 1 hour", describeLockout(3600));
  check("never returns an empty string", describeLockout(-5).length > 0);
}

// ---------------------------------------------------------------------------
section("Session epoch");
// ---------------------------------------------------------------------------

{
  check("matching epoch is current", isSessionEpochCurrent(3, 3));
  check("newer token is current", isSessionEpochCurrent(4, 3));
  check("older token is stale", !isSessionEpochCurrent(2, 3));
  check("legacy token with no epoch survives epoch 0", isSessionEpochCurrent(undefined, 0));
  check("legacy token is revoked once epoch is bumped", !isSessionEpochCurrent(undefined, 1));
  check("null epoch behaves like 0", !isSessionEpochCurrent(null, 2));
}

// ---------------------------------------------------------------------------
section("Determinism");
// ---------------------------------------------------------------------------

{
  // Same input, same output — 200 times. Nothing in here may read the clock or
  // depend on iteration order.
  const candidate = "Tr0ubad0ur&Fig";
  const first = JSON.stringify(assessPassword(candidate, { email: "zoe@corp.com" }));
  let stable = true;

  for (let index = 0; index < 200; index += 1) {
    if (JSON.stringify(assessPassword(candidate, { email: "zoe@corp.com" })) !== first) {
      stable = false;
      break;
    }
  }
  check("assessPassword is deterministic over 200 runs", stable);

  let lockStable = true;
  const seed = registerFailure(initialLockoutState(), NOW);
  const expected = JSON.stringify(registerFailure(seed, at(5)));
  for (let index = 0; index < 200; index += 1) {
    if (JSON.stringify(registerFailure(seed, at(5))) !== expected) {
      lockStable = false;
      break;
    }
  }
  check("registerFailure is deterministic over 200 runs", lockStable);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
