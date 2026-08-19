"use client";

import { FormEvent, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";

import { ModalShell } from "@/components/modal-shell";
import type { Member } from "@/lib/ui/api-client";

/**
 * Pick an assignee from the organization's active members.
 *
 * Replaces a `window.prompt` that pasted every member's email address into its
 * message and then matched what the user typed back against that list. A select
 * removes the transcription step, and no longer puts the full member roster on
 * screen just to choose one person.
 */
export function AssignTaskDialog({
  members,
  membersLoading,
  currentAssigneeId,
  saving,
  onSubmit,
  onClose,
}: {
  members: Member[];
  membersLoading: boolean;
  currentAssigneeId: string | null | undefined;
  saving: boolean;
  onSubmit: (userId: string | null) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(currentAssigneeId ?? "");

  const unchanged = (selected || null) === (currentAssigneeId ?? null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || unchanged) {
      return;
    }
    onSubmit(selected || null);
  }

  return (
    <ModalShell
      title="Assign task"
      icon={<UserPlus className="shrink-0 text-teal-300" size={17} />}
      onClose={onClose}
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label
            htmlFor="assign-task-member"
            className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500"
          >
            Assignee
          </label>

          {membersLoading ? (
            <p className="mt-2 flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-400">
              <Loader2 className="animate-spin" size={15} />
              Loading members…
            </p>
          ) : (
            <select
              id="assign-task-member"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={saving}
              className="mt-2 h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
            >
              <option className="bg-slate-950 text-white" value="">
                Unassigned
              </option>
              {members.map((member) => (
                <option
                  className="bg-slate-950 text-white"
                  key={member.id}
                  value={member.user.id}
                >
                  {member.user.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="submit"
            disabled={saving || membersLoading || unchanged}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-slate-600"
          >
            {saving ? "Saving..." : "Assign"}
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
