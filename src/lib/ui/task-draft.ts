import type { ParsedTask } from './use-ai-compose';

/** Tab-local draft handoff; keep task descriptions out of URLs and access logs. */
export function saveTaskDraft(projectId: string, task: ParsedTask): string {
  const id = crypto.randomUUID();
  sessionStorage.setItem(`projectos:task-draft:${id}`, JSON.stringify({projectId, task}));
  return id;
}

export function readTaskDraft(id: string, projectId: string): ParsedTask | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(`projectos:task-draft:${id}`) ?? 'null');
    const task = value?.task;
    if (value?.projectId !== projectId || !task || typeof task.title !== 'string' ||
      typeof task.description !== 'string' || !['LOW','MEDIUM','HIGH','URGENT'].includes(task.priority) ||
      !(task.dueDate === null || (typeof task.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)))) return null;
    return task;
  } catch { return null; }
}
