-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "membership_role" AS ENUM ('ADMIN', 'MANAGER', 'MEMBER');

-- CreateEnum
CREATE TYPE "membership_status" AS ENUM ('ACTIVE', 'INVITED', 'DISABLED');

-- CreateEnum
CREATE TYPE "project_status" AS ENUM ('ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');

-- CreateEnum
CREATE TYPE "task_priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(140) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "membership_role" NOT NULL DEFAULT 'MEMBER',
    "status" "membership_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "status" "project_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "description" TEXT,
    "status" "task_status" NOT NULL DEFAULT 'TODO',
    "priority" "task_priority" NOT NULL DEFAULT 'MEDIUM',
    "assigned_to_user_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "due_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "author_user_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "entity_type" VARCHAR(80) NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organization_members_organization_id_role_idx" ON "organization_members"("organization_id", "role");

-- CreateIndex
CREATE INDEX "organization_members_organization_id_status_idx" ON "organization_members"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_user_id_organization_id_key" ON "organization_members"("user_id", "organization_id");

-- CreateIndex
CREATE INDEX "projects_organization_id_status_idx" ON "projects"("organization_id", "status");

-- CreateIndex
CREATE INDEX "projects_organization_id_created_at_idx" ON "projects"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "projects_id_organization_id_key" ON "projects"("id", "organization_id");

-- CreateIndex
CREATE INDEX "tasks_organization_id_project_id_idx" ON "tasks"("organization_id", "project_id");

-- CreateIndex
CREATE INDEX "tasks_organization_id_assigned_to_user_id_idx" ON "tasks"("organization_id", "assigned_to_user_id");

-- CreateIndex
CREATE INDEX "tasks_organization_id_status_idx" ON "tasks"("organization_id", "status");

-- CreateIndex
CREATE INDEX "tasks_organization_id_created_at_idx" ON "tasks"("organization_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_id_organization_id_key" ON "tasks"("id", "organization_id");

-- CreateIndex
CREATE INDEX "task_comments_organization_id_task_id_idx" ON "task_comments"("organization_id", "task_id");

-- CreateIndex
CREATE INDEX "task_comments_organization_id_created_at_idx" ON "task_comments"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_logs_organization_id_created_at_idx" ON "activity_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "activity_logs_organization_id_entity_type_entity_id_idx" ON "activity_logs"("organization_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_organization_id_fkey" FOREIGN KEY ("created_by_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_user_id_organization_id_fkey" FOREIGN KEY ("assigned_to_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_organization_id_fkey" FOREIGN KEY ("created_by_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_organization_id_fkey" FOREIGN KEY ("author_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_organization_id_fkey" FOREIGN KEY ("task_id", "organization_id") REFERENCES "tasks"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_user_id_organization_id_fkey" FOREIGN KEY ("actor_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
