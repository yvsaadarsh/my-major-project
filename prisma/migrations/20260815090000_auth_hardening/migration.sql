-- Day 7: auth hardening
--
-- Adds brute-force lockout state and stateless-session invalidation to users,
-- plus an append-only sign-in attempt log for incident forensics.
--
-- Every statement is idempotent so `prisma migrate deploy` is safe to re-run
-- against a database that partially applied this migration.

-- CreateEnum: login_outcome
DO $$ BEGIN
  CREATE TYPE "login_outcome" AS ENUM ('SUCCESS', 'INVALID_PASSWORD', 'UNKNOWN_EMAIL', 'LOCKED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable: lockout state on users.
-- Defaults are chosen so existing rows become "no failures, not locked" without
-- a backfill pass, and so no live session is invalidated by shipping this
-- (session_epoch starts at 0 and legacy tokens are treated as epoch 0).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failed_login_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_failed_login_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP(3);

-- CreateTable: login_attempts
CREATE TABLE IF NOT EXISTS "login_attempts" (
  "id" TEXT NOT NULL,
  "email" VARCHAR(320) NOT NULL,
  "user_id" TEXT,
  "outcome" "login_outcome" NOT NULL,
  "ip_hash" VARCHAR(64),
  "user_agent" VARCHAR(400),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- Indexes supporting the three questions this table exists to answer:
--   "what happened to this address?", "what happened to this user?",
--   "what happened in this time range?"
CREATE INDEX IF NOT EXISTS "login_attempts_email_created_at_idx"
  ON "login_attempts" ("email", "created_at");
CREATE INDEX IF NOT EXISTS "login_attempts_user_id_created_at_idx"
  ON "login_attempts" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "login_attempts_created_at_idx"
  ON "login_attempts" ("created_at");

-- A deleted user keeps their attempt history but loses the link, so the log
-- stays useful for forensics without resurrecting personal data.
DO $$ BEGIN
  ALTER TABLE "login_attempts"
    ADD CONSTRAINT "login_attempts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Partial index for the hot lockout lookup: only locked accounts matter.
CREATE INDEX IF NOT EXISTS "users_locked_until_idx"
  ON "users" ("locked_until") WHERE "locked_until" IS NOT NULL;
