-- Cross-project dependencies.
--
-- A task dependency used to be pinned to a single project, and both endpoints
-- were required to live in it. That made a whole class of real risk invisible:
-- a platform task gating a product launch in another project could not be
-- expressed, so the dependency graph never showed it.
--
-- After this migration an edge belongs to the tenant, not to a project.
--
-- Tenant isolation is untouched. `organization_id` stays on the row and remains
-- half of both task foreign keys, so the database still forces both endpoints
-- into the same organization. Cross-project is now legal; cross-tenant is still
-- structurally impossible.
--
-- No data is lost or rewritten: every existing edge already had both endpoints
-- in one project, so dropping the column only removes a redundant denormalized
-- copy of `tasks.project_id`. Existing rows remain valid under the new model,
-- which is why this needs no backfill and is safe to run against live data.

-- 1. Drop the composite FK to projects. Must go before the column.
ALTER TABLE "task_dependencies"
  DROP CONSTRAINT IF EXISTS "task_dependencies_project_id_organization_id_fkey";

-- 2. Drop the index that led with the column being removed. Postgres would drop
--    it implicitly with the column, but doing it explicitly keeps the intent
--    readable and makes the migration idempotent.
DROP INDEX IF EXISTS "task_dependencies_organization_id_project_id_idx";

-- 3. Drop the column itself.
ALTER TABLE "task_dependencies"
  DROP COLUMN IF EXISTS "project_id";

-- The remaining indexes are what the new access pattern needs. "Dependencies
-- relevant to project X" resolves as a join on either endpoint:
--   sourceTask.projectId = X OR targetTask.projectId = X
-- so both directions must be indexed. Both already exist from the original
-- migration; asserted here so a fresh database and a migrated one agree.
CREATE INDEX IF NOT EXISTS "task_dependencies_organization_id_source_task_id_idx"
  ON "task_dependencies"("organization_id", "source_task_id");
CREATE INDEX IF NOT EXISTS "task_dependencies_organization_id_target_task_id_idx"
  ON "task_dependencies"("organization_id", "target_task_id");

-- Last known health band per project, so PROJECT_HEALTH_CHANGED can fire on a
-- real transition.
--
-- The automation executor previously compared each project's freshly computed
-- band against a hardcoded constant ("Healthy"), which meant the trigger did not
-- detect change at all: it fired for every project that was not currently
-- Healthy, on every run, and never fired for a project that genuinely degraded
-- from Healthy. Storing the previous band makes the comparison meaningful.
--
-- Nullable on purpose: NULL means "never evaluated", which is different from
-- "was Healthy". The executor treats the first observation as a baseline and
-- does not raise an event for it, so enabling a rule cannot retroactively alert
-- on history the system never saw.
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "last_health_band" TEXT;
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "last_health_score" INTEGER;
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "last_health_at" TIMESTAMP(3);
