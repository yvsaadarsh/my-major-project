"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";

import { ModalShell } from "@/components/modal-shell";

/**
 * Rename a task.
 *
 * Replaces a `window.prompt`: that dialog is unstyled, unlabelled for
 * assistive tech, and blocks the whole tab while it is open.
 */
export function EditTaskDialog({
  currentTitle,
  saving,
  onSubmit,
  onClose,
}: {
  currentTitle: string;
  saving: boolean;
  onSubmit: (title: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(currentTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queueMicrotask(() => inputRef.current?.select());
  }, []);

  const trimmed = title.trim();
  const unchanged = trimmed === currentTitle;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed || unchanged || saving) {
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <ModalShell
      title="Edit task"
      icon={<Pencil className="shrink-0 text-teal-300" size={17} />}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label
            htmlFor="edit-task-title"
            className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500"
          >
            Title
          </label>
          <input
            id="edit-task-title"
            ref={inputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={saving}
            className="mt-2 h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="submit"
            disabled={!trimmed || unchanged || saving}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-slate-600"
          >
            {saving ? "Saving..." : "Save title"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex h-11 items-center justify-center rounded-2xl px-4 text-sm font-medium text-slate-400 transition-all hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
