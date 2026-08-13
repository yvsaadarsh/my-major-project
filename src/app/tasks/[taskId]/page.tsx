"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Activity,
  CheckCircle2,
  GitBranch,
  ListTree,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
} from "lucide-react";

import { AppShell, RoleNotice } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import {
  apiRequest,
  formatStatus,
  type ActivityEvent,
  type Dependency,
  type Member,
  type Task,
} from "@/lib/ui/api-client";
import { can } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";

function humanizeActivity(event: ActivityEvent) {
  const actor = event.actor?.name ?? "Someone";
  const metadata = event.metadata ?? {};

  switch (event.action) {
    case "task.created":
      return `${actor} created this task`;
    case "task.status_changed":
      return `${actor} moved status ${formatStatus(String(metadata.fromStatus ?? "?"))} → ${formatStatus(String(metadata.toStatus ?? "?"))}`;
    case "task.updated": {
      const fields = typeof metadata.changedFields === "string" ? metadata.changedFields : "";
      return fields ? `${actor} updated ${fields}` : `${actor} updated this task`;
    }
    case "dependency.created":
      return `${actor} added a ${formatStatus(String(metadata.type ?? "BLOCKS"))} dependency`;
    default:
      return `${actor} · ${event.action}`;
  }
}

export default function TaskViewPage() {
  const params = useParams<{ taskId: string }>();
  const router = useRouter();
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });
  const [task, setTask] = useState<Task | null>(null);
  const [siblingTasks, setSiblingTasks] = useState<Task[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [comment, setComment] = useState("");
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [dependencyTargetId, setDependencyTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dependencyError, setDependencyError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function loadRelatedData(current: Task) {
    const projectId = current.project?.id;

    if (!projectId) {
      return;
    }

    try {
      const [depsResponse, activityResponse, tasksResponse] = await Promise.all([
        apiRequest<{ dependencies: Dependency[] }>(
          `/api/v1/projects/${projectId}/dependencies`,
        ),
        apiRequest<{ activity: ActivityEvent[] }>(`/api/v1/tasks/${current.id}/activity`),
        apiRequest<{ tasks: Task[] }>(`/api/v1/projects/${projectId}/tasks`),
      ]);

      setDependencies(depsResponse.dependencies);
      setActivity(activityResponse.activity);
      setSiblingTasks(tasksResponse.tasks.filter((item) => item.id !== current.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load task context.");
    }
  }

  async function loadTask() {
    setError(null);
    setLoading(true);

    try {
      let taskId = params.taskId;

      if (taskId === "latest") {
        const myTasks = await apiRequest<{ tasks: Task[] }>("/api/v1/dashboard/my-tasks");
        const firstTask = myTasks.tasks[0];

        if (!firstTask) {
          setTask(null);
          return;
        }

        taskId = firstTask.id;
        router.replace(`/tasks/${taskId}`);
      }

      const response = await apiRequest<{ task: Task }>(`/api/v1/tasks/${taskId}`);
      setTask(response.task);
      await loadRelatedData(response.task);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load task.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (organization) {
      queueMicrotask(() => {
        void loadTask();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization, params.taskId]);

  async function markDone() {
    if (!task || !can(role, "tasks:updateAssignedStatus")) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await apiRequest<{ task: Task }>(`/api/v1/tasks/${task.id}`, {
        method: "PATCH",
        body: { status: "DONE" },
      });
      setTask((current) => (current ? { ...current, ...response.task } : response.task));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update task.");
    } finally {
      setSaving(false);
    }
  }

  async function editTask() {
    if (!task || !can(role, "tasks:update")) return;
    const newTitle = window.prompt("Enter new task title:", task.title);
    if (!newTitle || newTitle === task.title) return;

    setSaving(true);
    try {
      await apiRequest(`/api/v1/tasks/${task.id}`, { method: "PATCH", body: { title: newTitle } });
      await loadTask();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to edit task.");
    } finally {
      setSaving(false);
    }
  }

  async function assignTask() {
    if (!task || !can(role, "tasks:assign")) return;
    setSaving(true);
    try {
      const { members } = await apiRequest<{members: Member[]}>("/api/v1/members");
      const emailList = members.map(m => m.user.email).join(`\n`);
      const email = window.prompt(`Enter assignee email:\n${emailList}`);
      if (!email) return;

      const target = members.find(
        (m) => m.user.email.toLowerCase() === email.trim().toLowerCase(),
      );
      if (!target) {
        alert("User not found in organization");
        return;
      }

      await apiRequest(`/api/v1/tasks/${task.id}`, { method: "PATCH", body: { assignedToUserId: target.user.id } });
      await loadTask();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to assign task.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteTask() {
    if (!task || !can(role, "tasks:delete")) {
      return;
    }

    if (!window.confirm("Delete this task? This cannot be undone.")) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest(`/api/v1/tasks/${task.id}`, { method: "DELETE" });
      router.push("/projects");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete task.");
    } finally {
      setSaving(false);
    }
  }

  async function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task || !comment.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest(`/api/v1/tasks/${task.id}/comments`, {
        method: "POST",
        body: { body: comment },
      });
      setComment("");
      await loadTask();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to add comment.");
    } finally {
      setSaving(false);
    }
  }

  async function createSubtask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task?.project?.id || !can(role, "tasks:create") || !subtaskTitle.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest(`/api/v1/projects/${task.project.id}/tasks`, {
        method: "POST",
        body: {
          title: subtaskTitle,
          description: "Subtask created from the task workspace.",
          priority: "MEDIUM",
          status: "TODO",
          parentTaskId: task.id,
        },
      });
      setSubtaskTitle("");
      await loadTask();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create subtask.");
    } finally {
      setSaving(false);
    }
  }

  async function completeSubtask(subtaskId: string) {
    if (!can(role, "tasks:update")) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest(`/api/v1/tasks/${subtaskId}`, {
        method: "PATCH",
        body: { status: "DONE" },
      });
      await loadTask();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update subtask.");
    } finally {
      setSaving(false);
    }
  }

  async function addDependency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task?.project?.id || !can(role, "tasks:update") || !dependencyTargetId) {
      return;
    }

    setSaving(true);
    setDependencyError(null);

    try {
      await apiRequest(`/api/v1/projects/${task.project.id}/dependencies`, {
        method: "POST",
        body: {
          sourceTaskId: task.id,
          targetTaskId: dependencyTargetId,
          type: "BLOCKS",
        },
      });
      setDependencyTargetId("");
      await loadTask();
    } catch (caught) {
      setDependencyError(
        caught instanceof Error ? caught.message : "Unable to add dependency.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  const subtasks = task?.subtasks ?? [];
  const subtaskTotal = subtasks.length;
  const subtaskCompleted = subtasks.filter((item) => item.status === "DONE").length;
  const subtaskCompletion = subtaskTotal
    ? Math.round((subtaskCompleted / subtaskTotal) * 100)
    : 0;

  const blocking = dependencies.filter((dependency) => dependency.sourceTask.id === task?.id);
  const blockedBy = dependencies.filter((dependency) => dependency.targetTask.id === task?.id);
  const existingTargetIds = new Set(blocking.map((dependency) => dependency.targetTask.id));
  const dependencyOptions = siblingTasks.filter((item) => !existingTargetIds.has(item.id));

  return (
    <AppShell
      eyebrow="Task view"
      organizationName={organization?.name}
      role={role}
      title={task?.title ?? "Task view"}
      description="A detailed task workspace where visible controls come from the active membership role."
    >
      {error && <InlineError message={error} />}

      {!task && !loading ? (
        <EmptyState
          title="No task available"
          description="Create a project task first, then the task view will load the latest assigned item."
          action={<Link className="text-sm font-semibold text-teal-200" href="/projects">Open project board</Link>}
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <div className="space-y-6">
          <SectionCard>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium text-teal-200">
                  {task?.project?.name ?? "Project"}
                </p>
                {task?.parentTask && (
                  <Link
                    href={`/tasks/${task.parentTask.id}`}
                    className="mt-2 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs font-semibold text-slate-300 transition-all hover:border-teal-300/30 hover:text-teal-100"
                  >
                    <ListTree size={13} />
                    Parent: {task.parentTask.title}
                  </Link>
                )}
                <h2 className="mt-3 text-2xl font-semibold text-white">
                  {task?.title ?? "Loading task..."}
                </h2>
                <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-400">
                  {task?.description ?? "No description added yet."}
                </p>
              </div>
              {task && (
                <span className="rounded-full bg-blue-300/10 px-3 py-1 text-xs font-semibold text-blue-200">
                  {formatStatus(task.status)}
                </span>
              )}
            </div>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {[
                ["Priority", task ? formatStatus(task.priority) : "..."],
                ["Assignee", task?.assignedTo?.name ?? "Unassigned"],
                ["Due", task?.dueDate ? new Date(task.dueDate).toLocaleDateString() : "No due date"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{label}</p>
                  <p className="mt-2 text-sm font-semibold text-white">{value}</p>
                </div>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                onClick={() => void markDone()}
                disabled={!task || saving || !can(role, "tasks:updateAssignedStatus")}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-slate-600"
              >
                <CheckCircle2 size={16} />
                {saving ? "Saving..." : "Mark done"}
              </button>
              <PermissionAction onClick={editTask} role={role} permission="tasks:update" variant="secondary">
                <Pencil size={16} />
                Edit task
              </PermissionAction>
              <PermissionAction onClick={assignTask} role={role} permission="tasks:assign" variant="secondary">
                <UserPlus size={16} />
                Assign
              </PermissionAction>
              <PermissionAction
                onClick={deleteTask}
                role={role}
                permission="tasks:delete"
                variant="danger"
              >
                <Trash2 size={16} />
                Delete
              </PermissionAction>
            </div>

            {!can(role, "tasks:update") && (
              <div className="mt-5">
                <RoleNotice text="Team Members can update status on assigned tasks, while edits and reassignment stay locked." />
              </div>
            )}
          </SectionCard>

          <SectionCard>
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <ListTree className="text-teal-300" size={18} />
                Subtasks
              </h2>
              <span className="text-xs font-semibold text-slate-400">
                {subtaskCompleted}/{subtaskTotal} done
              </span>
            </div>

            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-teal-300 transition-all"
                style={{ width: `${subtaskCompletion}%` }}
              />
            </div>

            <div className="mt-5 space-y-3">
              {subtasks.length ? (
                subtasks.map((subtask) => (
                  <div
                    key={subtask.id}
                    className="flex items-center justify-between gap-3 rounded-3xl border border-white/10 bg-white/[0.035] p-4"
                  >
                    <Link
                      href={`/tasks/${subtask.id}`}
                      className="min-w-0 flex-1"
                    >
                      <p className="truncate text-sm font-semibold text-white">{subtask.title}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatStatus(subtask.status)} · {subtask.assignedTo?.name ?? "Unassigned"}
                      </p>
                    </Link>
                    {subtask.status === "DONE" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-teal-300/10 px-3 py-1 text-xs font-semibold text-teal-200">
                        <CheckCircle2 size={13} />
                        Done
                      </span>
                    ) : (
                      can(role, "tasks:update") && (
                        <button
                          onClick={() => void completeSubtask(subtask.id)}
                          disabled={saving}
                          className="inline-flex h-9 items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white transition-all hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:text-slate-600"
                        >
                          <CheckCircle2 size={13} />
                          Mark done
                        </button>
                      )
                    )}
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">No subtasks yet.</p>
              )}
            </div>

            {can(role, "tasks:create") && (
              <form onSubmit={createSubtask} className="mt-5 flex flex-col gap-3 sm:flex-row">
                <input
                  value={subtaskTitle}
                  onChange={(event) => setSubtaskTitle(event.target.value)}
                  placeholder="New subtask title"
                  className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60"
                />
                <PermissionAction role={role} permission="tasks:create" type="submit" variant="secondary">
                  <Plus size={16} />
                  Add subtask
                </PermissionAction>
              </form>
            )}
          </SectionCard>

          <SectionCard>
            <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
              <GitBranch className="text-teal-300" size={18} />
              Dependencies
            </h2>

            {dependencyError && (
              <div className="mt-4">
                <InlineError message={dependencyError} />
              </div>
            )}

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  This task blocks
                </p>
                <div className="mt-3 space-y-2">
                  {blocking.length ? (
                    blocking.map((dependency) => (
                      <Link
                        key={dependency.id}
                        href={`/tasks/${dependency.targetTask.id}`}
                        className="block rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-sm text-slate-200 transition-all hover:border-teal-300/30"
                      >
                        <span className="text-[11px] font-semibold text-amber-200">
                          {formatStatus(dependency.type)}
                        </span>{" "}
                        {dependency.targetTask.title}
                      </Link>
                    ))
                  ) : (
                    <p className="text-sm text-slate-500">Nothing downstream.</p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Blocked by
                </p>
                <div className="mt-3 space-y-2">
                  {blockedBy.length ? (
                    blockedBy.map((dependency) => (
                      <Link
                        key={dependency.id}
                        href={`/tasks/${dependency.sourceTask.id}`}
                        className="block rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2 text-sm text-slate-200 transition-all hover:border-teal-300/30"
                      >
                        <span className="text-[11px] font-semibold text-rose-200">
                          {formatStatus(dependency.type)}
                        </span>{" "}
                        {dependency.sourceTask.title}
                      </Link>
                    ))
                  ) : (
                    <p className="text-sm text-slate-500">Nothing upstream.</p>
                  )}
                </div>
              </div>
            </div>

            {can(role, "tasks:update") && (
              <form onSubmit={addDependency} className="mt-5 flex flex-col gap-3 sm:flex-row">
                <select
                  value={dependencyTargetId}
                  onChange={(event) => setDependencyTargetId(event.target.value)}
                  disabled={dependencyOptions.length === 0}
                  className="h-11 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                >
                  <option className="bg-slate-950 text-white" value="">
                    Add a task this one blocks...
                  </option>
                  {dependencyOptions.map((option) => (
                    <option className="bg-slate-950 text-white" key={option.id} value={option.id}>
                      {option.title}
                    </option>
                  ))}
                </select>
                <PermissionAction role={role} permission="tasks:update" type="submit" variant="secondary">
                  <Plus size={16} />
                  Link
                </PermissionAction>
              </form>
            )}
          </SectionCard>
          </div>

          <div className="space-y-6">
          <SectionCard>
            <h2 className="text-xl font-semibold text-white">Comments</h2>
            <div className="mt-5 space-y-4">
              {task?.comments?.length ? (
                task.comments.map((item) => (
                  <div key={item.id} className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                    <p className="text-sm leading-6 text-slate-300">{item.body}</p>
                    <p className="mt-3 text-xs text-slate-500">
                      {item.author.name} · {new Date(item.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">No comments yet.</p>
              )}
            </div>

            <form onSubmit={addComment} className="mt-8 rounded-3xl border border-white/10 bg-white/[0.035] p-4">
              <div className="flex items-center gap-3">
                <MessageSquare className="text-teal-300" size={18} />
                <p className="text-sm font-semibold text-white">Add comment</p>
              </div>
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                className="mt-4 min-h-28 w-full rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60"
                placeholder="Write a tenant-scoped note..."
              />
              <div className="mt-4">
                <PermissionAction
                  role={role}
                  permission="tasks:comment"
                  variant="secondary"
                  type="submit"
                >
                  {saving ? "Saving..." : "Add comment"}
                </PermissionAction>
              </div>
            </form>
          </SectionCard>

          <SectionCard>
            <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
              <Activity className="text-teal-300" size={18} />
              Activity
            </h2>
            <div className="mt-5 space-y-4">
              {activity.length ? (
                activity.map((event) => (
                  <div key={event.id} className="flex gap-3">
                    <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-300/70" />
                    <div>
                      <p className="text-sm text-slate-200">{humanizeActivity(event)}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {new Date(event.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-slate-500">No activity recorded yet.</p>
              )}
            </div>
          </SectionCard>
          </div>
        </div>
      )}
    </AppShell>
  );
}
