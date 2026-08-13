-- Saved views: per-user (optionally shared) filter/sort/group presets for the
-- views system. A view is either project-scoped (`project_id`) or org-level
-- (`project_id` NULL, meaning "applies to any project").

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "view_type" AS ENUM ('BOARD', 'LIST', 'TABLE', 'TIMELINE');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "saved_views" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "project_id" TEXT,
  "owner_user_id" TEXT NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "view_type" "view_type" NOT NULL DEFAULT 'BOARD',
  "config" JSONB NOT NULL,
  "is_shared" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "saved_views_organization_id_project_id_idx" ON "saved_views"("organization_id", "project_id");
CREATE INDEX IF NOT EXISTS "saved_views_organization_id_owner_user_id_idx" ON "saved_views"("organization_id", "owner_user_id");
CREATE INDEX IF NOT EXISTS "saved_views_organization_id_is_shared_idx" ON "saved_views"("organization_id", "is_shared");

-- AddForeignKey
ALTER TABLE "saved_views" DROP CONSTRAINT IF EXISTS "saved_views_organization_id_fkey";
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_views" DROP CONSTRAINT IF EXISTS "saved_views_owner_user_id_fkey";
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A saved view can only be owned by a member of its own organization.
ALTER TABLE "saved_views" DROP CONSTRAINT IF EXISTS "saved_views_owner_user_id_organization_id_fkey";
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_owner_user_id_organization_id_fkey" FOREIGN KEY ("owner_user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A saved view can only point at a project inside its own organization.
ALTER TABLE "saved_views" DROP CONSTRAINT IF EXISTS "saved_views_project_id_organization_id_fkey";
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
