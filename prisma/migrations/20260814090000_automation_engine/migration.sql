-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "automation_run_status" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable: notification type + dedupe key
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "type" VARCHAR(80) NOT NULL DEFAULT 'general';
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "dedupe_key" VARCHAR(200);

-- CreateTable: automation_runs (audit + idempotency ledger)
CREATE TABLE IF NOT EXISTS "automation_runs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "rule_id" TEXT NOT NULL,
  "dedupe_key" VARCHAR(200) NOT NULL,
  "status" "automation_run_status" NOT NULL,
  "detail" TEXT,
  "entity_type" VARCHAR(80),
  "entity_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: notification_preferences
CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
  "email_enabled" BOOLEAN NOT NULL DEFAULT false,
  "muted_types" TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "automation_runs_organization_id_rule_id_dedupe_key_key" ON "automation_runs"("organization_id", "rule_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "automation_runs_organization_id_rule_id_idx" ON "automation_runs"("organization_id", "rule_id");
CREATE INDEX IF NOT EXISTS "automation_runs_organization_id_created_at_idx" ON "automation_runs"("organization_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_organization_id_user_id_key" ON "notification_preferences"("organization_id", "user_id");

CREATE INDEX IF NOT EXISTS "notifications_organization_id_recipient_user_id_type_idx" ON "notifications"("organization_id", "recipient_user_id", "type");

-- AddForeignKey: automation_runs
ALTER TABLE "automation_runs" DROP CONSTRAINT IF EXISTS "automation_runs_organization_id_fkey";
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "automation_runs" DROP CONSTRAINT IF EXISTS "automation_runs_rule_id_fkey";
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "automation_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: notification_preferences
ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_organization_id_fkey";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_user_id_fkey";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification_preferences" DROP CONSTRAINT IF EXISTS "notification_preferences_user_id_organization_id_fkey";
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_organization_id_fkey" FOREIGN KEY ("user_id", "organization_id") REFERENCES "organization_members"("user_id", "organization_id") ON DELETE CASCADE ON UPDATE CASCADE;
