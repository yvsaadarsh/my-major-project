"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";

import { formatStatus, type Milestone } from "@/lib/ui/api-client";

/** Milestone states a retrospective can be generated for. */
export const CLOSED_MILESTONE_STATUSES = new Set(["DONE", "MISSED"]);

/**
 * Lifecycle of a streamed retrospective.
 *
 * `unavailable` covers both "AI is not configured" (501) and any upstream
 * failure. Unlike the additive sections elsewhere, this one cannot silently
 * disappear — the user explicitly clicked to open it, so it says so plainly
 * instead of showing an empty sheet.
 */
type RetroState = "loading" | "streaming" | "done" | "unavailable";

/**
 * Streamed milestone retrospective, in a modal.
 *
 * The prompt returns three headed sections, so the body is rendered line by
 * line: a short line with no trailing period is treated as a heading. This is
 * presentation only — no markdown parser, which would flicker as partial syntax
 * arrives mid-stream.
 */
export function RetrospectiveModal({
  milestone,
  projectId,
  onClose,
}: {
  milestone: Milestone;
  projectId: string;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<RetroState>("loading");

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      // Inside the async body: a synchronous setState in an effect body trips
      // react-hooks/set-state-in-effect.
      setText("");
      setState("loading");

      try {
        const response = await fetch(
          `/api/v1/projects/${projectId}/milestones/${milestone.id}/retrospective`,
          { cache: "no-store", credentials: "include", signal: controller.signal },
        );

        if (!response.ok || !response.body) {
          setState("unavailable");
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        setState("streaming");

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          // `stream: true` so a multi-byte character split across chunks is not
          // decoded into a replacement character.
          accumulated += decoder.decode(value, { stream: true });
          setText(accumulated);
        }

        accumulated += decoder.decode();
        setText(accumulated);
        setState(accumulated.trim().length > 0 ? "done" : "unavailable");
      } catch {
        // Includes the abort below, where the component is already gone and the
        // setter is a no-op.
        setState("unavailable");
      }
    })();

    return () => controller.abort();
  }, [milestone.id, projectId]);

  // Escape closes, matching the command palette's behaviour.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const lines = text.split("\n");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 px-3 pt-16 backdrop-blur-sm sm:px-6 sm:pt-24"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-label="AI retrospective"
        aria-modal="true"
        role="dialog"
        className="w-full max-w-2xl overflow-hidden rounded-3xl border border-violet-300/20 bg-slate-950 shadow-2xl shadow-black/50 soft-border"
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/10 bg-violet-400/[0.06] px-5 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-white">
              <Sparkles className="shrink-0 text-violet-300" size={17} />
              AI Retrospective
              <span className="rounded-full border border-violet-300/30 bg-violet-300/[0.1] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-200">
                AI
              </span>
            </p>
            <p className="mt-1 truncate text-xs text-slate-400">
              {milestone.name} · {formatStatus(milestone.status)}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close retrospective"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-400 transition-all hover:bg-white/10 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div
          className="max-h-[60vh] overflow-y-auto px-5 py-5"
          aria-busy={state === "loading" || state === "streaming"}
          aria-live="polite"
        >
          {state === "unavailable" ? (
            <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-400">
              This retrospective isn&apos;t available right now.
            </p>
          ) : text.length === 0 ? (
            <div className="space-y-3" aria-hidden>
              {["w-2/5", "w-full", "w-11/12", "w-3/5"].map((width) => (
                <div
                  key={width}
                  className={`h-3.5 animate-pulse rounded-full bg-violet-300/15 ${width}`}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {lines.map((line, index) => {
                const trimmed = line.trim();

                if (trimmed.length === 0) {
                  return <div key={index} className="h-2" />;
                }

                // The prompt emits three short headings on their own lines.
                const isHeading = trimmed.length < 40 && !/[.:!?]$/.test(trimmed);

                return isHeading ? (
                  <p
                    key={index}
                    className="pt-2 text-xs font-semibold uppercase tracking-[0.14em] text-violet-200"
                  >
                    {trimmed}
                  </p>
                ) : (
                  <p key={index} className="text-sm leading-7 text-slate-200">
                    {trimmed}
                    {/* Typing cursor rides the last line while text is arriving. */}
                    {state === "streaming" && index === lines.length - 1 && (
                      <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-violet-300 align-middle" />
                    )}
                  </p>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-white/10 bg-white/[0.02] px-5 py-3 text-[11px] text-slate-500">
          Generated from computed milestone statistics. Review before sharing.
        </div>
      </div>
    </div>
  );
}
