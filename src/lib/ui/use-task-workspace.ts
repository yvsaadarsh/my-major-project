"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  apiRequest,
  type ActivityEvent,
  type Dependency,
  type Member,
  type Task,
} from "@/lib/ui/api-client";
import { can, type Role } from "@/lib/ui/permissions";

/**
 * Every piece of state and every mutation the task workspace performs.
 *
 * The page below this hook is a renderer: it reads the returned values and
 * wires the callbacks to buttons and forms. Nothing here touches layout.
 *
 * Note on `saving`: one flag is shared by all eight mutations, exactly as the
 * page did inline. It is a coarse "a write is in flight" signal rather than a
 * per-control one — splitting it would change which controls disable during a
 * write, so it stays as it is.
 *
 * Note on the reloads: six of the eight mutations finish with `loadTask()`, a
 * full re-fetch of the task plus its dependencies, activity and siblings. That
 * is preserved verbatim; it is the existing refresh contract, not something
 * this extraction should quietly change.
 */
export function useTaskWorkspace({
  taskId,
  organization,
  role,
}: {
  taskId: string | undefined;
  organization: unknown;
  role: Role;
}) {
  const router = useRouter();

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
      let resolvedId = taskId;

      if (resolvedId === "latest") {
        const myTasks = await apiRequest<{ tasks: Task[] }>("/api/v1/dashboard/my-tasks");
        const firstTask = myTasks.tasks[0];

        if (!firstTask) {
          setTask(null);
          return;
        }

        resolvedId = firstTask.id;
        router.replace(`/tasks/${resolvedId}`);
      }

      const response = await apiRequest<{ task: Task }>(`/api/v1/tasks/${resolvedId}`);
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
  }, [organization, taskId]);

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
      const { members } = await apiRequest<{ members: Member[] }>("/api/v1/members");
      const emailList = members.map((m) => m.user.email).join(`\n`);
      const email = window.prompt(`Enter assignee email:\n${emailList}`);
      if (!email) return;

      const target = members.find(
        (m) => m.user.email.toLowerCase() === email.trim().toLowerCase(),
      );
      if (!target) {
        alert("User not found in organization");
        return;
      }

      await apiRequest(`/api/v1/tasks/${task.id}`, {
        method: "PATCH",
        body: { assignedToUserId: target.user.id },
      });
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

  return {
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
  };
}
