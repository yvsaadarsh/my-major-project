"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Boxes, CheckCircle2, LockKeyhole, ShieldAlert, X } from "lucide-react";

import { InlineError } from "@/components/page-state";
import { apiRequest, ClientApiError } from "@/lib/ui/api-client";
import {
  assessPassword,
  describeLockout,
  PASSWORD_MIN_LENGTH,
  type PasswordAssessment,
} from "@/lib/domain/auth-policy";

type AuthMode = "login" | "register";

/** Bar colour per score. Index is the score, so 0 is the weakest. */
const METER_COLORS = [
  "bg-rose-400",
  "bg-rose-400",
  "bg-amber-300",
  "bg-teal-300",
  "bg-emerald-300",
] as const;

const METER_TEXT = [
  "text-rose-300",
  "text-rose-300",
  "text-amber-200",
  "text-teal-200",
  "text-emerald-200",
] as const;

/**
 * Live password strength meter.
 *
 * Renders straight from `assessPassword` — the same pure function the register
 * and change-password endpoints call — so the meter can never tell the user a
 * password is fine and then have the API reject it.
 */
function PasswordMeter({ assessment }: { assessment: PasswordAssessment }) {
  const filled = assessment.score + 1;

  return (
    <div className="mt-3" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-1 gap-1.5" role="presentation">
          {[0, 1, 2, 3, 4].map((index) => (
            <span
              key={index}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                index < filled ? METER_COLORS[assessment.score] : "bg-white/10"
              }`}
            />
          ))}
        </div>
        <span className={`text-xs font-semibold capitalize ${METER_TEXT[assessment.score]}`}>
          {assessment.label}
        </span>
      </div>

      {assessment.problems.length > 0 && (
        <ul className="mt-2.5 space-y-1.5">
          {assessment.problems.map((problem) => (
            <li key={problem} className="flex items-start gap-2 text-xs text-rose-300">
              <X className="mt-0.5 shrink-0" size={13} aria-hidden />
              <span>{problem}</span>
            </li>
          ))}
        </ul>
      )}

      {assessment.problems.length === 0 && (
        <p className="mt-2.5 flex items-start gap-2 text-xs text-emerald-300">
          <CheckCircle2 className="mt-0.5 shrink-0" size={13} aria-hidden />
          <span>This password meets the requirements.</span>
        </p>
      )}

      {assessment.problems.length === 0 && assessment.suggestions.length > 0 && (
        <p className="mt-1.5 text-xs text-slate-500">{assessment.suggestions[0]}</p>
      )}
    </div>
  );
}

/**
 * Lockout notice with a live countdown.
 *
 * Distinct from a normal error because the user has not done anything wrong that
 * retyping will fix — they need to wait. Showing the remaining time, ticking
 * down, is far kinder than a static "try again later".
 */
function LockoutNotice({ seconds }: { seconds: number }) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    setRemaining(seconds);
  }, [seconds]);

  useEffect(() => {
    if (remaining <= 0) {
      return;
    }

    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);

  return (
    <div
      className="flex items-start gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3"
      role="alert"
    >
      <ShieldAlert className="mt-0.5 shrink-0 text-amber-300" size={16} aria-hidden />
      <div className="text-sm">
        <p className="font-semibold text-amber-200">Too many failed attempts</p>
        <p className="mt-1 text-slate-300" aria-live="polite">
          {remaining > 0
            ? `For your protection this account is locked. Try again in ${describeLockout(remaining)}.`
            : "You can try signing in again now."}
        </p>
      </div>
    </div>
  );
}

/** Pull `retryAfterSeconds` out of a 423 body without trusting its shape. */
function retryAfterFrom(details: unknown): number | null {
  if (details && typeof details === "object" && "retryAfterSeconds" in details) {
    const value = (details as { retryAfterSeconds: unknown }).retryAfterSeconds;

    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.ceil(value);
    }
  }

  return null;
}

/** Collect every password problem the server reported, not just the first. */
function passwordProblemsFrom(details: unknown): string[] {
  if (details && typeof details === "object" && "problems" in details) {
    const value = (details as { problems: unknown }).problems;

    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
  }

  return [];
}

export default function AuthPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("register");

  // Fields start empty. The previous build pre-filled a demo name, email and
  // password, which trains users to accept whatever is in the box and would let
  // a real deployment be signed into with a published credential.
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [lockoutSeconds, setLockoutSeconds] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // Only assess while registering: judging a sign-in password would imply the
  // stored one must satisfy today's policy, and would nag users who registered
  // under an older, looser rule.
  const assessment = useMemo(
    () => assessPassword(password, { email, name }),
    [email, name, password],
  );

  const showMeter = mode === "register" && password.length > 0;

  // Only block once the user has actually typed something. Disabling the button
  // on an untouched form looks broken and hides the native "please fill in this
  // field" prompt that handles the empty case perfectly well.
  const blockSubmit =
    mode === "register" && password.length > 0 && !assessment.acceptable;

  function switchMode(next: AuthMode) {
    setMode(next);
    setError(null);
    setServerProblems([]);
    setLockoutSeconds(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setServerProblems([]);
    setLockoutSeconds(null);

    // Client-side gate is a courtesy, not the control. The API re-runs the same
    // assessment, so bypassing this changes nothing.
    if (blockSubmit) {
      setError("Choose a stronger password before continuing.");
      return;
    }

    setLoading(true);

    try {
      const response = await apiRequest<{ needsOrganization: boolean }>(
        mode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login",
        {
          method: "POST",
          body:
            mode === "register"
              ? { email, name, password }
              : { email, password },
        },
      );

      // Confirm the browser can actually read the new session before navigating,
      // so a cookie problem surfaces here rather than as a redirect loop.
      await apiRequest("/api/v1/auth/me", { cache: "no-store" });
      router.push(response.needsOrganization ? "/onboarding" : "/dashboard");
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        if (caught.code === "account_locked") {
          setLockoutSeconds(retryAfterFrom(caught.details) ?? 60);
          setPassword("");
          return;
        }

        if (caught.code === "weak_password") {
          setServerProblems(passwordProblemsFrom(caught.details));
          setError(caught.message);
          return;
        }

        setError(caught.message);
        return;
      }

      setError(caught instanceof Error ? caught.message : "Authentication failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="dark-grid grid min-h-screen place-items-center px-4 py-10 text-slate-100">
      <div className="w-full max-w-5xl rounded-[2rem] border border-white/10 bg-slate-950/70 p-5 soft-border backdrop-blur-xl">
        <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-[1.5rem] border border-white/10 bg-white/[0.035] p-7">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-teal-300 text-slate-950">
              <Boxes size={20} />
            </div>
            <p className="mt-8 text-xs font-semibold uppercase tracking-[0.28em] text-teal-300">
              ProjectOS
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-normal text-white">
              Multi-tenant project work, wired end to end.
            </h1>
            <p className="mt-4 text-sm leading-7 text-slate-400">
              Register, create your organization, invite members, create a project, and use the same backend tenant guard the API enforces.
            </p>
            <div className="mt-8 space-y-3 text-sm text-slate-300">
              {[
                "Secure HTTP-only session cookie",
                "Tenant resolved from membership, not browser input",
                "RBAC reflected in every command surface",
                "Sign-in attempts rate limited and audited",
              ].map((item) => (
                <div key={item} className="flex items-center gap-3">
                  <LockKeyhole className="shrink-0 text-teal-300" size={16} aria-hidden />
                  {item}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[1.5rem] border border-white/10 bg-slate-950/80 p-7">
            <div className="flex gap-2 rounded-2xl bg-white/[0.04] p-1" role="tablist">
              {(["register", "login"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={mode === item}
                  onClick={() => switchMode(item)}
                  className={`h-11 flex-1 rounded-xl text-sm font-semibold transition-all ${
                    mode === item
                      ? "bg-white text-slate-950"
                      : "text-slate-400 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  {item === "register" ? "Create account" : "Sign in"}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="mt-7 space-y-4">
              {mode === "register" && (
                <label className="block">
                  <span className="text-sm font-medium text-slate-300">Name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    placeholder="Your full name"
                    className="mt-2 h-13 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60"
                    required
                  />
                </label>
              )}

              <label className="block">
                <span className="text-sm font-medium text-slate-300">Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete={mode === "register" ? "email" : "username"}
                  placeholder="you@company.com"
                  className="mt-2 h-13 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60"
                  required
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-slate-300">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  placeholder={
                    mode === "register"
                      ? `At least ${PASSWORD_MIN_LENGTH} characters`
                      : "Your password"
                  }
                  aria-describedby={showMeter ? "password-strength" : undefined}
                  className="mt-2 h-13 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60"
                  required
                />
                {showMeter && (
                  <div id="password-strength">
                    <PasswordMeter assessment={assessment} />
                  </div>
                )}
              </label>

              {lockoutSeconds !== null && <LockoutNotice seconds={lockoutSeconds} />}

              {lockoutSeconds === null && error && <InlineError message={error} />}

              {/* Problems the server found that the local meter did not surface —
                  should be rare, but never silently drop them. */}
              {serverProblems.length > 1 && (
                <ul className="space-y-1.5">
                  {serverProblems.slice(1).map((problem) => (
                    <li key={problem} className="flex items-start gap-2 text-xs text-rose-300">
                      <X className="mt-0.5 shrink-0" size={13} aria-hidden />
                      <span>{problem}</span>
                    </li>
                  ))}
                </ul>
              )}

              <button
                disabled={loading || blockSubmit}
                className="inline-flex h-13 w-full items-center justify-center gap-2 rounded-2xl bg-teal-300 px-5 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Working..." : mode === "register" ? "Continue to onboarding" : "Open workspace"}
                <ArrowRight size={16} aria-hidden />
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
