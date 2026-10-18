"use client";

import { AlertTriangle, ArrowRight, CheckCircle } from "lucide-react";

import { InlineError } from "@/components/page-state";
import { can } from "@/lib/ui/permissions";
import type { Role } from "@/lib/ui/permissions";
import type {
  SimulateResult,
  SimulationDiff as SimDiffData,
} from "@/lib/ui/api-client";

// ── Colour helpers ────────────────────────────────────────────────────────────

const BAND_STYLES: Record<SimDiffData["baseline"]["band"], string> = {
  "At risk": "border-orange-300/30 bg-orange-300/10 text-orange-200",
  Critical: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  Healthy: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
  Watch: "border-amber-300/30 bg-amber-300/10 text-amber-200",
};

const VERDICT_STYLES: Record<SimDiffData["verdict"], string> = {
  safe: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
  watch: "border-amber-300/30 bg-amber-300/10 text-amber-200",
  block: "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

const SEVERITY_STYLES: Record<SimDiffData["severity"], string> = {
  none: "border-slate-300/20 bg-slate-300/5 text-slate-400",
  low: "border-teal-300/30 bg-teal-300/10 text-teal-200",
  medium: "border-amber-300/30 bg-amber-300/10 text-amber-200",
  high: "border-orange-300/30 bg-orange-300/10 text-orange-200",
  critical: "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

// ── Props ─────────────────────────────────────────────────────────────────────

type SimulationResultPanelProps = {
  result: SimulateResult;
  /** Normalised role — already confirmed defined before this renders. */
  role: Role;
  applying: boolean;
  applyError: string | null;
  /** Set when apply returned HTTP 409 — distinct from a generic error. */
  staleError: string | null;
  onApply: () => void;
  /** Discard the current result and let the user start over. */
  onDiscard: () => void;
};

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Renders a simulation result.
 *
 * Handles two distinct statuses from the backend:
 *  • `needs_clarification` — AI needs more information; shown as a prompt, not
 *    an error, so the user knows to refine their scenario.
 *  • `simulated` — full diff, health comparison, narration, and Apply controls.
 */
export function SimulationResultPanel({
  result,
  role,
  applying,
  applyError,
  staleError,
  onApply,
  onDiscard,
}: SimulationResultPanelProps) {
  const canApply = can(role, "projects:apply");

  // ── Clarification branch ──────────────────────────────────────────────────
  if (result.status === "needs_clarification") {
    return (
      <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-300/[0.04] p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-300" />
          <div>
            <p className="text-sm font-semibold text-amber-100">
              Clarification needed
            </p>
            <p className="mt-1 text-sm leading-6 text-amber-100/80">
              {result.clarificationQuestion}
            </p>
            <p className="mt-2 text-xs text-amber-200/60">
              Refine your scenario description to answer this question, then run
              the simulation again.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDiscard}
          className="mt-3 text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
        >
          Start over
        </button>
      </div>
    );
  }

  // ── Simulated branch ──────────────────────────────────────────────────────
  const { diff, interpretedIntent, narration } = result;

  return (
    <div className="mt-4 space-y-3">
      {/* Interpreted intent */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Interpreted as
        </p>
        <p className="mt-1.5 text-sm text-slate-200">{interpretedIntent}</p>
      </div>

      {/* Health comparison */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Health impact
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          {/* Before */}
          <div className="flex flex-col items-center gap-1">
            <span className="text-2xl font-semibold tabular-nums text-white">
              {diff.baseline.score}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${BAND_STYLES[diff.baseline.band]}`}
            >
              {diff.baseline.band}
            </span>
            <span className="text-[10px] text-slate-500">Before</span>
          </div>

          {/* Delta arrow */}
          <div className="flex flex-col items-center gap-0.5">
            <ArrowRight size={16} className="text-slate-600" />
            <span
              className={`text-xs font-semibold tabular-nums ${
                diff.healthDelta >= 0 ? "text-emerald-300" : "text-rose-300"
              }`}
            >
              {diff.healthDelta >= 0 ? "+" : ""}
              {Math.round(diff.healthDelta)}
            </span>
          </div>

          {/* After */}
          <div className="flex flex-col items-center gap-1">
            <span className="text-2xl font-semibold tabular-nums text-white">
              {diff.modified.score}
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${BAND_STYLES[diff.modified.band]}`}
            >
              {diff.modified.band}
            </span>
            <span className="text-[10px] text-slate-500">After</span>
          </div>

          {/* Verdict + severity badges */}
          <div className="ml-auto flex flex-wrap gap-2">
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold capitalize ${VERDICT_STYLES[diff.verdict]}`}
            >
              {diff.verdict}
            </span>
            <span
              className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold capitalize ${SEVERITY_STYLES[diff.severity]}`}
            >
              {diff.severity} severity
            </span>
          </div>
        </div>

        {/* Supporting chips */}
        <div className="mt-3 flex flex-wrap gap-2">
          {diff.bandChanged && (
            <div className="flex items-center gap-1.5 rounded-xl border border-amber-300/20 bg-amber-300/[0.05] px-3 py-1.5">
              <AlertTriangle size={12} className="shrink-0 text-amber-300" />
              <span className="text-xs text-amber-200">Health band changes</span>
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-1.5">
            <span className="text-xs text-slate-400">
              {diff.affectedTaskCount} task
              {diff.affectedTaskCount === 1 ? "" : "s"} affected
            </span>
          </div>
        </div>
      </div>

      {/* Signal changes */}
      {diff.signalChanges.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Signal changes
          </p>
          <ul className="mt-3 space-y-2">
            {diff.signalChanges.map((sig) => (
              <li key={sig.name} className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-300">{sig.name}</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs text-slate-500">
                    {sig.before}
                  </span>
                  <span className="text-slate-600">→</span>
                  <span className="font-mono text-xs text-slate-300">
                    {sig.after}
                  </span>
                  {sig.delta !== 0 && (
                    <span
                      className={`text-xs font-semibold tabular-nums ${
                        sig.delta > 0 ? "text-emerald-300" : "text-rose-300"
                      }`}
                    >
                      ({sig.delta > 0 ? "+" : ""}
                      {sig.delta})
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* AI narration */}
      <div className="rounded-2xl border border-violet-300/20 bg-violet-300/[0.04] p-4">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-400">
          AI narration
        </p>
        <p className="mt-2 text-sm leading-7 text-slate-200">{narration}</p>
      </div>

      {/* No conflicts notice */}
      {diff.verdict === "safe" && !diff.bandChanged && (
        <div className="flex items-center gap-2 text-xs text-emerald-300">
          <CheckCircle size={13} />
          <span>No health-band change — safe to apply</span>
        </div>
      )}

      {/* Error states */}
      {staleError && (
        <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle
              size={14}
              className="mt-0.5 shrink-0 text-amber-300"
            />
            <div>
              <p className="text-sm font-semibold text-amber-100">
                Snapshot is stale
              </p>
              <p className="mt-1 text-xs leading-5 text-amber-200/80">
                {staleError}
              </p>
            </div>
          </div>
        </div>
      )}
      {applyError && (
        <div className="mt-1">
          <InlineError message={applyError} />
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2 pt-1">
        {canApply && !staleError && (
          <button
            type="button"
            onClick={onApply}
            disabled={applying}
            className="inline-flex h-9 items-center gap-2 rounded-xl bg-teal-300 px-4 text-xs font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {applying ? "Applying…" : "Apply change"}
          </button>
        )}
        <button
          type="button"
          onClick={onDiscard}
          disabled={applying}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-semibold text-slate-300 transition-all hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {staleError ? "Re-run simulation" : "Discard"}
        </button>
      </div>
    </div>
  );
}
