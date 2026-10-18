"use client";

import { AlertTriangle, CheckCircle, Sparkles, XCircle } from "lucide-react";

import { InlineError } from "@/components/page-state";
import {
  formatStatus,
  type ConflictKind,
  type InterpretResult,
  type PolicyConflict,
} from "@/lib/ui/api-client";

// ── Conflict badge config ──────────────────────────────────────────────────

const CONFLICT_STYLES: Record<
  ConflictKind,
  { label: string; icon: React.ReactNode; className: string }
> = {
  CONFIRMED_DUPLICATE: {
    label: "Duplicate",
    icon: <XCircle size={14} />,
    className:
      "border-rose-400/30 bg-rose-400/10 text-rose-200",
  },
  CONFIRMED_UNCONDITIONAL: {
    label: "Unconditional conflict",
    icon: <XCircle size={14} />,
    className:
      "border-rose-400/30 bg-rose-400/10 text-rose-200",
  },
  POSSIBLE_OVERLAP: {
    label: "Possible overlap",
    icon: <AlertTriangle size={14} />,
    className:
      "border-amber-400/30 bg-amber-400/10 text-amber-200",
  },
};

// ── Individual conflict row ────────────────────────────────────────────────

function ConflictRow({ conflict }: { conflict: PolicyConflict }) {
  const style = CONFLICT_STYLES[conflict.kind];

  return (
    <div
      className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${style.className}`}
    >
      <span className="mt-0.5 shrink-0">{style.icon}</span>
      <div className="min-w-0">
        <span className="font-semibold">{style.label}</span>
        <span className="ml-1 text-current/80">{conflict.message}</span>
      </div>
    </div>
  );
}

// ── PolicyDraftCard ────────────────────────────────────────────────────────

type PolicyDraftCardProps = {
  /** The successful interpretation result from the backend. */
  result: InterpretResult;
  /** Error from the save attempt (if any); preserved here so draft is not lost. */
  saveError: string | null;
  /** Whether a save is currently in flight. */
  saving: boolean;
  /** Callback to confirm and save the draft. */
  onSave: () => void;
  /** Callback to discard this draft and start over. */
  onDiscard: () => void;
};

export function PolicyDraftCard({
  result,
  saveError,
  saving,
  onSave,
  onDiscard,
}: PolicyDraftCardProps) {
  const { draft, conflicts, sourcePolicy } = result;
  const hasBlockingConflicts = conflicts.some(
    (c) =>
      c.kind === "CONFIRMED_DUPLICATE" || c.kind === "CONFIRMED_UNCONDITIONAL",
  );

  return (
    <div className="mt-4 rounded-2xl border border-teal-300/20 bg-teal-300/[0.04] p-4">
      {/* Header — clearly marks this as AI-generated, not yet saved */}
      <div className="flex items-center gap-2">
        <Sparkles size={15} className="shrink-0 text-teal-300" />
        <p className="text-sm font-semibold text-teal-100">AI-generated draft</p>
        <span className="ml-auto rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
          Not saved
        </span>
      </div>

      {/* Draft rule fields */}
      <div className="mt-3 space-y-2">
        <div>
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Rule name
          </span>
          <p className="mt-0.5 text-sm font-semibold text-white">{draft.name}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="rounded-full bg-white/[0.06] px-2.5 py-1 text-[11px] font-medium text-slate-300">
            {formatStatus(draft.trigger)}
          </div>
          <div className="rounded-full bg-white/[0.06] px-2.5 py-1 font-mono text-[11px] text-slate-300">
            {draft.condition}
          </div>
          <div className="rounded-full bg-teal-300/10 px-2.5 py-1 text-[11px] font-medium text-teal-100">
            {formatStatus(draft.action)}
          </div>
        </div>

        {/* Source policy — collapsed label + text */}
        {sourcePolicy && (
          <div>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              Original policy
            </span>
            <p className="mt-0.5 text-xs leading-5 text-slate-400">{sourcePolicy}</p>
          </div>
        )}
      </div>

      {/* Conflict warnings */}
      {conflicts.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            {conflicts.length === 1 ? "1 conflict detected" : `${conflicts.length} conflicts detected`}
          </p>
          {conflicts.map((c, i) => (
            <ConflictRow key={`${c.kind}-${c.conflictingRuleId}-${i}`} conflict={c} />
          ))}
        </div>
      )}

      {/* No conflicts — positive signal */}
      {conflicts.length === 0 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-teal-300">
          <CheckCircle size={13} />
          <span>No conflicts with existing rules</span>
        </div>
      )}

      {/* Save error (draft preserved) */}
      {saveError && (
        <div className="mt-3">
          <InlineError message={saveError} />
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-teal-300 px-4 text-xs font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : hasBlockingConflicts ? "Save anyway" : "Save rule"}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={saving}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-xs font-semibold text-slate-300 transition-all hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
