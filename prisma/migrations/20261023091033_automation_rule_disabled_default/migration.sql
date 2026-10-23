-- Migration: default automation_rules.enabled to false (D-8 defense-in-depth)
--
-- The application already creates automation rules as disabled drafts: the
-- create validator (automationRuleCreateSchema) defaults `enabled` to false and
-- every creation path passes the value explicitly. This migration aligns the
-- database column default with that behaviour, so a future insert that omits
-- `enabled` — a createMany, a raw INSERT, or a direct DB tool — cannot produce
-- a live rule. The database is then the last line that also fails closed.
--
-- Scope: this changes the DEFAULT applied to future inserts that omit the
-- column only. It does NOT rewrite existing rows — rules that are currently
-- enabled stay enabled (deliberately: silently disabling live automations
-- would itself be a hazard). There is intentionally no UPDATE statement here.
--
-- Backward-compatible: no currently-running code relies on this column default
-- (both old and new application code pass `enabled` explicitly), so the usual
-- migrate-before-deploy ordering is safe.
--
-- Rollback: ALTER TABLE automation_rules ALTER COLUMN enabled SET DEFAULT true;
-- (reversible; affects no existing rows).

ALTER TABLE automation_rules
  ALTER COLUMN enabled SET DEFAULT false;
