"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, ListTree, Pencil, Trash2, UserPlus } from "lucide-react";

import { AppShell, RoleNotice } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import { ActivityPanel } from "@/components/tasks/activity-panel";
import { CommentsPanel } from "@/components/tasks/comments-panel";
import { SubtasksPanel } from "@/components/tasks/subtasks-panel";
import { TaskDependenciesPanel } from "@/components/tasks/task-dependencies-panel";
import { formatStatus } from "@/lib/ui/api-client";
import { can } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";
import { useTaskWorkspace } from "@/lib/ui/use-task-workspace";

export default function TaskViewPage() {
  const params = useParams<{ taskId: string }>();
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });

  const {
    task,
    siblingTasks,
    dependencies,
    activity,
    comment,
    subtaskTitle,
    dependencyTargetId,
    error,
    dependencyError,
    loading,
    saving,
    setComment,
    setSubtaskTitle,
    setDependencyTargetId,
    markDone,
    editTask,
    assignTask,
    deleteTask,
    addComment,
    createSubtask,
    completeSubtask,
    addDependency,
  } = useTaskWorkspace({ taskId: params.taskId, organization, role });

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  const subtasks = task?.subtasks ?? [];

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
          action={
            <Link className="text-sm font-semibold text-teal-200" href="/projects">
              Open project board
            </Link>
          }
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
                  [
                    "Due",
                    task?.dueDate
                      ? new Date(task.dueDate).toLocaleDateString()
                      : "No due date",
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-3xl border border-white/10 bg-white/[0.035] p-4"
                  >
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
                <PermissionAction
                  onClick={editTask}
                  role={role}
                  permission="tasks:update"
                  variant="secondary"
                >
                  <Pencil size={16} />
                  Edit task
                </PermissionAction>
                <PermissionAction
                  onClick={assignTask}
                  role={role}
                  permission="tasks:assign"
                  variant="secondary"
                >
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

            <SubtasksPanel
              role={role}
              saving={saving}
              subtaskTitle={subtaskTitle}
              subtasks={subtasks}
              onCompleteSubtask={completeSubtask}
              onCreateSubtask={createSubtask}
              onSubtaskTitleChange={setSubtaskTitle}
            />

            <TaskDependenciesPanel
              dependencies={dependencies}
              dependencyError={dependencyError}
              dependencyTargetId={dependencyTargetId}
              onAddDependency={addDependency}
              onDependencyTargetChange={setDependencyTargetId}
              role={role}
              siblingTasks={siblingTasks}
              taskId={task?.id}
            />
          </div>

          <div className="space-y-6">
            <CommentsPanel
              comment={comment}
              comments={task?.comments}
              onAddComment={addComment}
              onCommentChange={setComment}
              role={role}
              saving={saving}
            />

            <ActivityPanel activity={activity} />
          </div>
        </div>
      )}
    </AppShell>
  );
}
