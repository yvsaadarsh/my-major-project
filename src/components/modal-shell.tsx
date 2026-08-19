"use client";

import { ReactNode, useEffect } from "react";
import { X } from "lucide-react";

/**
 * The dialog frame shared by the app's small modals.
 *
 * Matches the behaviour the retrospective modal and the command palette
 * already established: a click on the backdrop closes, Escape closes, and the
 * dialog carries `role`/`aria-modal`/`aria-label` for assistive tech.
 *
 * Deliberately not a focus trap — these dialogs hold one or two controls and
 * are dismissible from the keyboard, so the complexity is not yet earned. The
 * first field is autofocused by the caller instead.
 */
export function ModalShell({
  title,
  icon,
  children,
  onClose,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
        aria-label={title}
        aria-modal="true"
        role="dialog"
        className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-slate-950 shadow-2xl shadow-black/50 soft-border"
      >
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
          {icon}
          <p className="min-w-0 flex-1 text-sm font-semibold text-white">{title}</p>
          <button
            type="button"
            aria-label="Close dialog"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-400 transition-all hover:bg-white/10 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-5">{children}</div>
      </div>
    </div>
  );
}
