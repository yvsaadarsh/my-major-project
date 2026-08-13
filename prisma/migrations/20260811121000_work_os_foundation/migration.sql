-- Bring the initial migration history in line with the current schema.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "start_date" TIMESTAMP(3);
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "end_date" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "rating" INTEGER;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "milestone_id" TEXT;
ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "milestone_status" AS ENUM ('PLANNED', 'ON_TRACK', 'AT_RISK', 'MISSED', 'DONE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "dependency_type" AS ENUM ('BLOCKS', 'DEPENDS_ON', 'RELATED_TO');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "automation_trigger" AS ENUM ('TASK_OVERDUE', 'TASK_STATUS_CHANGED', 'PROJECT_HEALTH_CHANGED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "automation_action" AS ENUM ('NOTIFY_MANAGER', 'UPDATE_MILESTONE_PROGRESS', 'WRITE_AUDIT_EVENT');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "milestones" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" TEXT,
  "due_date" TIMESTAMP(3) NOT NULL,
  "status" "milestone_status" NOT NULL DEFAULT 'PLANNED',
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "task_dependencies" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_task_id" TEXT NOT NULL,
  "target_task_id" TEXT NOT NULL,
  "type" "dependency_type" NOT NULL DEFAULT 'BLOCKS',
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "recipient_user_id" TEXT NOT NULL,
  "title" VARCHAR(180) NOT NULL,
  "body" TEXT NOT NULL,
  "priority" "task_priority" NOT NULL DEFAULT 'MEDIUM',
  "href" VARCHAR(400) NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "automation_rules" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "trigger" "automation_trigger" NOT NULL,
  "condition" VARCHAR(500) NOT NULL,
  "action" "automation_action" NOT NULL,
  "runs_this_month" INTEGER NOT NULL DEFAULT 0,
  "last_run_at" TIMESTAMP(3),
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "milestones_id_organization_id_key" ON "milestones"("id", "organization_id");
CREATE INDEX IF NOT EXISTS "milestones_organization_id_project_id_idx" ON "milestones"("organization_id", "project_id");
CREATE INDEX IF NOT EXISTS "milestones_organization_id_status_idx" ON "milestones"("organization_id", "status");
CREATE INDEX IF NOT EXISTS "milestones_organization_id_due_date_idx" ON "milestones"("organization_id", "due_date");

CREATE UNIQUE INDEX IF NOT EXISTS "task_dependencies_organization_id_source_task_id_target_task_id_type_key" ON "task_dependencies"("organization_id", "source_task_id", "target_task_id", "type");
CREATE INDEX IF NOT EXISTS "task_dependencies_organization_id_project_id_idx" ON "task_dependencies"("organization_id", "project_id");
CREATE INDEX IF NOT EXISTS "task_dependencies_organization_id_source_task_id_idx" ON "task_dependencies"("organization_id", "source_task_id");
CREATE INDEX IF NOT EXISTS "task_dependencies_organization_id_target_task_id_idx" ON "task_dependencies"("organization_id", "target_task_id");

CREATE INDEX IF NOT EXISTS "tasks_organization_id_milestone_id_idx" ON "tasks"("organization_id", "milestone_id");
CREATE INDEX IF NOT EXISTS "tasks_organization_id_due_date_idx" ON "tasks"("organization_id", "due_date");

CREATE INDEX IF NOT EXISTS "notifications_organization_id_recipient_user_id_read_at_idx" ON "notifications"("organization_id", "recipient_user_id", "read_at");
CREATE INDEX IF NOT EXISTS "notifications_organization_id_created_at_idx" ON "notifications"("organization_id", "created_at");

CREATE INDEX IF NOT EXISTS "automation_rules_organization_id_enabled_idx" ON "automation_rules"("organization_id", "enabled");
CREATE INDEX IF NOT EXISTS "automation_rules_organization_id_trigger_idx" ON "automation_rules"("organization_id", "trigger");

-- AddForeignKey
ALTER TABLE "milestones" DROP CONSTRAINT IF EXISTS "milestones_created_by_user_id_fkey";
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "milestones" DROP CONSTRAINT IF EXISTS "milestones_created_by_user_id_organization_id_fkey";
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_user_id_organization_id_fkey" FOREIGN KEY ("created_by_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "milestones" DROP CONSTRAINT IF EXISTS "milestones_organization_id_fkey";
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "milestones" DROP CONSTRAINT IF EXISTS "milestones_project_id_organization_id_fkey";
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_milestone_id_organization_id_fkey";
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_milestone_id_organization_id_fkey" FOREIGN KEY ("milestone_id", "organization_id") REFERENCES "milestones"("id", "organization_id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_created_by_user_id_fkey";
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_created_by_user_id_organization_id_fkey";
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_created_by_user_id_organization_id_fkey" FOREIGN KEY ("created_by_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_organization_id_fkey";
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_project_id_organization_id_fkey";
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_source_task_id_organization_id_fkey";
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_source_task_id_organization_id_fkey" FOREIGN KEY ("source_task_id", "organization_id") REFERENCES "tasks"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_dependencies" DROP CONSTRAINT IF EXISTS "task_dependencies_target_task_id_organization_id_fkey";
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_target_task_id_organization_id_fkey" FOREIGN KEY ("target_task_id", "organization_id") REFERENCES "tasks"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_organization_id_fkey";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_recipient_user_id_fkey";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_recipient_user_id_organization_id_fkey";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_organization_id_fkey" FOREIGN KEY ("recipient_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_rules" DROP CONSTRAINT IF EXISTS "automation_rules_created_by_user_id_fkey";
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automation_rules" DROP CONSTRAINT IF EXISTS "automation_rules_created_by_user_id_organization_id_fkey";
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_created_by_user_id_organization_id_fkey" FOREIGN KEY ("created_by_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "automation_rules" DROP CONSTRAINT IF EXISTS "automation_rules_organization_id_fkey";
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
