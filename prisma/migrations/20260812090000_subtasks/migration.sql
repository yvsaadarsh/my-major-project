-- Add self-referencing subtask support to tasks.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "parent_task_id" TEXT;

CREATE INDEX IF NOT EXISTS "tasks_organization_id_parent_task_id_idx"
  ON "tasks"("organization_id", "parent_task_id");

-- A subtask must belong to the same organization as its parent task.
-- Deleting a parent task cascades to its subtasks.
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_parent_task_id_organization_id_fkey";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_organization_id_fkey"
  FOREIGN KEY ("parent_task_id", "organization_id")
  REFERENCES "tasks"("id", "organization_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
