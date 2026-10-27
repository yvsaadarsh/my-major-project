"use client";

import type { ParsedTask } from "@/lib/ui/use-ai-compose";

import { FormEvent, useState } from "react";
import { Plus } from "lucide-react";

import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import { apiRequest, type Member, type Project, type Task } from "@/lib/ui/api-client";
import { errorMessage } from "@/lib/ui/error-message";
import { can, type Role } from "@/lib/ui/permissions";

/**
 * Owns the task title, assignee, and "saving" flag. `initialTitle` seeds the
 * field for the "Create task with AI → Edit first" hand-off from the command
 * center; subsequent user edits are preserved even if the prop later clears.
 */
export function CreateTaskForm({
  role,
  project,
  members,
  initialTitle = "",
  initialDraft,
  onCreated,
  onError,
}: {
  role: Role;
  project: Project | null;
  members: Member[];
  initialTitle?: string;
  initialDraft?: ParsedTask;
  onCreated: (task: Task) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(initialDraft?.title ?? initialTitle);
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [priority, setPriority] = useState<ParsedTask["priority"]>(initialDraft?.priority ?? "MEDIUM");
  const [dueDate, setDueDate] = useState(initialDraft?.dueDate ?? "");
  const [previousDraft, setPreviousDraft] = useState(initialDraft);
  if (previousDraft !== initialDraft) {
    setPreviousDraft(initialDraft);
    if (initialDraft) { setTitle(initialDraft.title); setDescription(initialDraft.description); setPriority(initialDraft.priority); setDueDate(initialDraft.dueDate ?? ""); }
  }
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [saving, setSaving] = useState(false);

  // Adjust before children render; clearing the handoff must preserve user edits.
  const [previousTitle, setPreviousTitle] = useState(initialTitle);
  if (previousTitle !== initialTitle) {
    setPreviousTitle(initialTitle);
    if (initialTitle) setTitle(initialTitle);
  }

  const allowedToCreate = can(role, "tasks:create");
  const allowedToAssign = can(role, "tasks:assign");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project || !allowedToCreate || !title.trim()) {
      return;
    }

    setSaving(true);

    try {
      const response = await apiRequest<{ task: Task }>(
        `/api/v1/projects/${project.id}/tasks`,
        {
          method: "POST",
          body: {
            assignedToUserId: assignedToUserId || null,
            description,
            priority,
            dueDate: dueDate ? `${dueDate}T00:00:00.000Z` : null,
            status: "TODO",
            title,
          },
        },
      );

      onCreated(response.task);
      setTitle("");
      setDescription(""); setPriority("MEDIUM"); setDueDate("");
      setAssignedToUserId("");
    } catch (caught) {
      onError(errorMessage(caught, "Unable to create task."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard>
      <h2 className="text-lg font-semibold text-white">Create task</h2>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={!allowedToCreate || !project}
          placeholder="Task title"
          aria-label="Task title"
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
        />
        <textarea aria-label="Task description" placeholder="Description" value={description} onChange={e => setDescription(e.target.value)} className="w-full rounded-2xl border border-white/10 bg-slate-950 p-3 text-white" />
        <div className="grid grid-cols-2 gap-3">
          <select aria-label="Task priority" value={priority} onChange={e => setPriority(e.target.value as ParsedTask["priority"])} className="min-w-0 rounded-2xl border border-white/10 bg-slate-950 p-3 text-white">
            {["LOW", "MEDIUM", "HIGH", "URGENT"].map(value => <option key={value}>{value}</option>)}
          </select>
          <input aria-label="Task due date" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="min-w-0 rounded-2xl border border-white/10 bg-slate-950 p-3 text-white" />
        </div>
        <select
          value={assignedToUserId}
          onChange={(event) => setAssignedToUserId(event.target.value)}
          disabled={!allowedToAssign || members.length === 0}
          aria-label="Task assignee"
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
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
        <PermissionAction
          role={role}
          permission="tasks:create"
          variant="secondary"
          type="submit"
        >
          <Plus size={16} />
          {saving ? "Saving..." : "Add task"}
        </PermissionAction>
      </form>
    </SectionCard>
  );
}
