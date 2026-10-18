-- Migration: add source_policy column to automation_rules
--
-- Stores the original natural-language policy text that was used to generate
-- an automation rule via the AI-assisted interpret endpoint (Feature 2).
-- NULL for rules created without the interpret endpoint.
--
-- This column is additive and nullable so the migration is backward-compatible:
-- old application code continues to work without reading or writing this column.
-- New code writes it when a rule is created via /automations/interpret.
--
-- Idempotent guard — safe to run twice.

ALTER TABLE automation_rules
  ADD COLUMN IF NOT EXISTS source_policy VARCHAR(2000) DEFAULT NULL;
