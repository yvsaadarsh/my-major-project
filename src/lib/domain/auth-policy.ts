/**
 * Authentication policy domain layer.
 *
 * Pure, deterministic, dependency-free. No Prisma, no React, no network, no AI.
 * This module owns two decisions that must never differ between the API layer
 * and the UI that previews them:
 *
 *   1. Is this password acceptable, and how strong is it?
 *   2. Is this account currently locked, and for how much longer?
 *
 * Design rules:
 * - Every threshold is a named exported constant, so a security review can read
 *   the policy without reading the algorithm.
 * - `now` is always injected. Nothing here calls `Date.now()`, so lockout maths
 *   is testable at any point on the timeline.
 * - Password assessment returns *reasons*, never a bare boolean. A user who is
 *   rejected is told exactly what to fix, and the same reasons render in the UI
 *   strength meter and in the API's 422 response.
 *
 * Standards note: the length and screening rules follow NIST SP 800-63B, which
 * recommends a modest minimum length plus screening against known-bad secrets,
 * rather than forced composition rules (one upper, one digit, one symbol) that
 * push users toward predictable patterns like `Password1!`. We therefore treat
 * character variety as *scoring* input, not as a hard gate, and reserve hard
 * rejection for the things that genuinely make a password guessable.
 */

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

/** Shortest password we will ever store. Below this, nothing else matters. */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * Longest password we accept. bcrypt silently truncates input beyond 72 bytes,
 * so accepting more than that would create a false sense of security: two
 * different long passwords could hash identically. We reject early instead.
 */
export const PASSWORD_MAX_LENGTH = 72;

/** Length at which we stop awarding additional length points. */
const PASSWORD_LENGTH_SATURATION = 20;

/** Minimum score (0-4) a password needs before we will store it. */
export const PASSWORD_MIN_SCORE = 2;

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export type PasswordAssessment = {
  /** 0 = trivially guessable, 4 = excellent. */
  score: PasswordScore;
  /** Human label for the score, used by the meter and by error copy. */
  label: "very weak" | "weak" | "fair" | "strong" | "excellent";
  /** True when the password satisfies every hard rule and clears the score bar. */
  acceptable: boolean;
  /** Blocking reasons. Non-empty means `acceptable` is false. */
  problems: string[];
  /** Non-blocking advice for making an acceptable password better. */
  suggestions: string[];
};

/**
 * Passwords common enough that an attacker's first few hundred guesses would
 * find them. This is a deliberately small, high-signal list: a full breached
 * corpus belongs in a database or a k-anonymity API lookup, not in a bundle.
 * Everything here is compared after lowercasing and stripping trailing digits,
 * so `Password123` is caught by the `password` entry.
 */
const COMMON_PASSWORDS = new Set([
  "password",
  "passwd",
  "pass",
  "secret",
  "letmein",
  "welcome",
  "admin",
  "administrator",
  "root",
  "login",
  "qwerty",
  "qwertyuiop",
  "asdfgh",
  "asdfghjkl",
  "zxcvbn",
  "zxcvbnm",
  "iloveyou",
  "sunshine",
  "princess",
  "dragon",
  "monkey",
  "football",
  "baseball",
  "shadow",
  "master",
  "superman",
  "batman",
  "trustno",
  "starwars",
  "whatever",
  "freedom",
  "computer",
  "internet",
  "changeme",
  "default",
  "testing",
  "test",
  "demo",
  "sample",
  "example",
  "projectos",
  "northstar",
]);

/** Keyboard rows and common sequences used to detect "walks" like `qwerty`. */
const KEYBOARD_SEQUENCES = [
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "1234567890",
  "abcdefghijklmnopqrstuvwxyz",
];

/** Minimum run length before we call something a keyboard walk or a sequence. */
const SEQUENCE_RUN_LENGTH = 4;

/** Minimum run length before we call something a repeated character. */
const REPEAT_RUN_LENGTH = 3;

/**
 * Strip a trailing run of digits and common suffix punctuation, so that
 * `password2024!` reduces to `password` for common-list comparison. Attackers
 * append years and bangs precisely because naive policies reward it.
 */
function stripDecorations(value: string): string {
  return value
    .toLowerCase()
    .replace(/[!@#$%^&*_.\-+=?]+$/g, "")
    .replace(/\d+$/g, "");
}

/** Longest run of the same character, e.g. "aaa" -> 3. */
function longestRepeatRun(value: string): number {
  let best = value.length > 0 ? 1 : 0;
  let run = 1;

  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === value[index - 1]) {
      run += 1;
      best = Math.max(best, run);
      continue;
    }
    run = 1;
  }

  return best;
}

/**
 * Longest substring of `value` that appears (forwards or backwards) inside one
 * of the known keyboard rows or alphabets. Catches `qwer`, `4321`, `hgfed`.
 */
function longestSequenceRun(value: string): number {
  const lowered = value.toLowerCase();
  let best = 0;

  for (const sequence of KEYBOARD_SEQUENCES) {
    const reversed = [...sequence].reverse().join("");

    for (const haystack of [sequence, reversed]) {
      // Try every window of the candidate, longest first is unnecessary — we
      // just track the maximum length that matches.
      for (let start = 0; start < lowered.length; start += 1) {
        for (let end = start + best + 1; end <= lowered.length; end += 1) {
          const window = lowered.slice(start, end);
          if (window.length > best && haystack.includes(window)) {
            best = window.length;
          }
        }
      }
    }
  }

  return best;
}

/** Count how many distinct character classes appear. */
function characterClasses(value: string): {
  lower: boolean;
  upper: boolean;
  digit: boolean;
  symbol: boolean;
  count: number;
} {
  const lower = /[a-z]/.test(value);
  const upper = /[A-Z]/.test(value);
  const digit = /\d/.test(value);
  const symbol = /[^A-Za-z0-9]/.test(value);

  return {
    count: [lower, upper, digit, symbol].filter(Boolean).length,
    digit,
    lower,
    symbol,
    upper,
  };
}

/**
 * Split an identity string (email or display name) into comparable tokens, so
 * `alice.chen@corp.com` yields `alice`, `chen`, `corp`. Tokens shorter than 3
 * characters are dropped — matching on `a` or `co` would reject everything.
 */
function identityTokens(values: Array<string | undefined>): string[] {
  const tokens: string[] = [];

  for (const value of values) {
    if (!value) {
      continue;
    }

    for (const token of value.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 3) {
        tokens.push(token);
      }
    }
  }

  return tokens;
}

const SCORE_LABELS: Record<PasswordScore, PasswordAssessment["label"]> = {
  0: "very weak",
  1: "weak",
  2: "fair",
  3: "strong",
  4: "excellent",
};

/**
 * Assess a candidate password.
 *
 * Hard rules (any one of these blocks the password regardless of score):
 * - shorter than PASSWORD_MIN_LENGTH or longer than PASSWORD_MAX_LENGTH
 * - leading or trailing whitespace (almost always a paste accident)
 * - a single repeated character, or a pure keyboard walk
 * - present in the common-password list after stripping year/bang decorations
 * - contains the user's own email local part or a word from their name
 *
 * Soft scoring (0-4) then reflects length and variety, and the password must
 * reach PASSWORD_MIN_SCORE to be stored.
 *
 * @param password the raw candidate, exactly as typed
 * @param identity optional email/name used to reject self-referential passwords
 */
export function assessPassword(
  password: string,
  identity: { email?: string; name?: string } = {},
): PasswordAssessment {
  const problems: string[] = [];
  const suggestions: string[] = [];

  // ── Hard rules ────────────────────────────────────────────────────────────

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters.`);
  }

  if (password !== password.trim()) {
    problems.push("Remove the space at the start or end.");
  }

  const repeatRun = longestRepeatRun(password);
  if (password.length > 0 && repeatRun >= REPEAT_RUN_LENGTH) {
    problems.push(`Avoid repeating the same character ${repeatRun} times in a row.`);
  }

  const sequenceRun = longestSequenceRun(password);
  if (sequenceRun >= SEQUENCE_RUN_LENGTH) {
    problems.push("Avoid keyboard patterns and straight runs like \"qwerty\" or \"3456\".");
  }

  const stripped = stripDecorations(password);
  if (stripped.length > 0 && COMMON_PASSWORDS.has(stripped)) {
    problems.push("This is one of the most commonly used passwords.");
  }

  const tokens = identityTokens([identity.email?.split("@")[0], identity.name]);
  const lowered = password.toLowerCase();
  const matchedToken = tokens.find((token) => lowered.includes(token));
  if (matchedToken) {
    problems.push("Do not include your name or email address in your password.");
  }

  // ── Soft scoring ──────────────────────────────────────────────────────────

  const classes = characterClasses(password);
  let points = 0;

  // Length is the single strongest signal, so it carries the most weight.
  const effectiveLength = Math.min(password.length, PASSWORD_LENGTH_SATURATION);
  if (effectiveLength >= PASSWORD_MIN_LENGTH) {
    points += 1;
  }
  if (effectiveLength >= 14) {
    points += 1;
  }
  if (effectiveLength >= PASSWORD_LENGTH_SATURATION) {
    points += 1;
  }

  // Variety adds a point at two classes and another at four.
  if (classes.count >= 2) {
    points += 1;
  }
  if (classes.count >= 4) {
    points += 1;
  }

  // A distinct-character ratio below half means lots of reuse inside the
  // password itself, which shrinks the real search space.
  const distinctRatio =
    password.length === 0 ? 0 : new Set(password).size / password.length;
  if (distinctRatio < 0.5) {
    points -= 1;
  }

  const score = Math.max(0, Math.min(4, points)) as PasswordScore;

  // ── Suggestions (advice, never blocking) ──────────────────────────────────

  if (password.length < 16) {
    suggestions.push("Longer is stronger — aim for 16 characters or a short phrase.");
  }
  if (classes.count < 3) {
    suggestions.push("Mix in another character type, such as a digit or symbol.");
  }
  if (distinctRatio < 0.6 && password.length > 0) {
    suggestions.push("Use more distinct characters instead of repeating a few.");
  }

  const acceptable = problems.length === 0 && score >= PASSWORD_MIN_SCORE;

  if (problems.length === 0 && score < PASSWORD_MIN_SCORE) {
    problems.push("This password is too easy to guess — make it longer or more varied.");
  }

  return {
    acceptable,
    label: SCORE_LABELS[score],
    problems,
    score,
    suggestions,
  };
}

// ---------------------------------------------------------------------------
// Brute-force lockout
// ---------------------------------------------------------------------------

/** Consecutive failures inside the window before the first lock applies. */
export const LOCKOUT_THRESHOLD = 5;

/** Lock duration for the first offence past the threshold. */
export const LOCKOUT_BASE_SECONDS = 60;

/** Hard cap on lock duration, so an account is never bricked. */
export const LOCKOUT_MAX_SECONDS = 60 * 60;

/**
 * Rolling window for counting failures. A failure older than this is forgotten,
 * so an honest user who fumbles a password once a week never accumulates a
 * lock, while a burst of guesses is caught immediately.
 */
export const ATTEMPT_WINDOW_SECONDS = 15 * 60;

export type LockoutState = {
  /** Consecutive failures inside the current window. */
  failedCount: number;
  /** When the current lock expires, or null when not locked. */
  lockedUntil: Date | null;
  /** Timestamp of the most recent failure, used to age out the window. */
  lastFailedAt: Date | null;
};

/** A clean slate: no failures, no lock. */
export function initialLockoutState(): LockoutState {
  return { failedCount: 0, lastFailedAt: null, lockedUntil: null };
}

export function isLocked(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/** Whole seconds remaining on the lock, rounded up. 0 when not locked. */
export function lockRemainingSeconds(state: LockoutState, now: Date): number {
  if (!isLocked(state, now) || state.lockedUntil === null) {
    return 0;
  }

  return Math.ceil((state.lockedUntil.getTime() - now.getTime()) / 1000);
}

/** True when the last failure is old enough that the window has rolled over. */
function windowExpired(state: LockoutState, now: Date): boolean {
  if (state.lastFailedAt === null) {
    return true;
  }

  return now.getTime() - state.lastFailedAt.getTime() > ATTEMPT_WINDOW_SECONDS * 1000;
}

/**
 * Lock duration for a given failure count, doubling each failure past the
 * threshold and capped at LOCKOUT_MAX_SECONDS.
 *
 *   failures 5 -> 60s, 6 -> 120s, 7 -> 240s, ... 11+ -> 3600s
 */
export function lockDurationSeconds(failedCount: number): number {
  if (failedCount < LOCKOUT_THRESHOLD) {
    return 0;
  }

  const doublings = failedCount - LOCKOUT_THRESHOLD;
  const raw = LOCKOUT_BASE_SECONDS * 2 ** doublings;

  return Math.min(raw, LOCKOUT_MAX_SECONDS);
}

/**
 * Fold one failed attempt into the state.
 *
 * If the rolling window has expired the counter restarts at 1, so old failures
 * never combine with new ones to trigger a surprise lock.
 */
export function registerFailure(state: LockoutState, now: Date): LockoutState {
  const failedCount = windowExpired(state, now) ? 1 : state.failedCount + 1;
  const duration = lockDurationSeconds(failedCount);

  return {
    failedCount,
    lastFailedAt: now,
    lockedUntil: duration > 0 ? new Date(now.getTime() + duration * 1000) : null,
  };
}

/** A successful sign-in clears everything. */
export function registerSuccess(): LockoutState {
  return initialLockoutState();
}

/**
 * How many attempts remain before the next lock. Useful for a warning banner
 * ("2 attempts left") without revealing whether the email exists — the caller
 * only shows this once the password has been checked for a real account.
 */
export function attemptsRemaining(state: LockoutState, now: Date): number {
  const effectiveCount = windowExpired(state, now) ? 0 : state.failedCount;

  return Math.max(0, LOCKOUT_THRESHOLD - effectiveCount);
}

/**
 * Format a lock duration for end users. Deliberately coarse: telling an
 * attacker the exact millisecond adds nothing, and "about 2 minutes" is what a
 * person actually wants to read.
 */
export function describeLockout(seconds: number): string {
  if (seconds <= 0) {
    return "now";
  }
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Session invalidation
// ---------------------------------------------------------------------------

/**
 * A session token carries the epoch it was minted under. Bumping the user's
 * stored epoch invalidates every token issued before it, which is how "sign out
 * everywhere" and "password changed" revoke existing sessions without a session
 * table. Tokens are otherwise stateless.
 */
export function isSessionEpochCurrent(
  tokenEpoch: number | null | undefined,
  userEpoch: number,
): boolean {
  // Tokens minted before this feature existed have no epoch. Treating them as
  // epoch 0 keeps existing sessions valid until the user's epoch is first
  // bumped, so shipping this does not sign everybody out.
  const claimed = typeof tokenEpoch === "number" ? tokenEpoch : 0;

  return claimed >= userEpoch;
}

/** The epoch a fresh user starts at. */
export const INITIAL_SESSION_EPOCH = 0;
