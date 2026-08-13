# Baseline audit

An honest assessment of the codebase inherited from the previous build, and what
was changed to establish a trustworthy baseline (Day 1 of the roadmap).

_Last updated: 2026-08-11._

## Summary

The inherited repository is a **strong, unfinished foundation** — not a demo, but
not production-ready either. The data model and tenant-isolation strategy are
genuinely well designed; the previous run stopped before stabilizing the build or
writing any documentation, and left the repository not compiling.

Verdict: **keep and continue.** No rewrite is warranted.

## What is strong (kept as-is)

- **Database-enforced tenant isolation.** Child entities reference their parents
  with composite foreign keys `(id, organization_id)`. A task literally cannot
  reference a project belonging to another organization. This is the single most
  important property of a multi-tenant system and it is done correctly.
- **Sensible indexing.** Composite indexes are led by `organization_id`, matching
  the tenant-scoped access pattern.
- **Auth core.** Session JWTs via `jose` (HS256), bcrypt (cost 12) password
  hashing, server-side tenant context from a signed HTTP-only cookie.
- **Authorization as data.** A single permission matrix (`src/lib/rbac.ts`) maps
  roles → permissions, plus a `withTenantGuard` wrapper that centralizes auth,
  tenant resolution, permission checks and error handling.
- **Consistent API envelope.** `json`/`empty` helpers, `ApiError`, and a
  `handleApiError` that maps ApiError/ZodError/DB-unavailable/unknown to safe JSON
  with `Cache-Control: no-store`. No stack traces leak to clients.
- **Comprehensive validation.** Zod schemas for every mutating request
  (`src/lib/validators.ts`).
- **Deterministic "work intelligence" (correctly non-AI).** `src/lib/domain/
  work-intelligence.ts` computes project health with explainable reasons, workload
  buckets, milestone completion, transitive dependency impact, and search ranking.

## What was broken or missing (addressed in Day 1)

| Issue | Severity | Status |
| --- | --- | --- |
| `src/lib/rbac.ts` had stray duplicate lines after the last function, breaking compilation | Blocker | **Fixed** |
| `src/lib/ui/permissions.ts` had the same stray-duplicate-line corruption after its last function | Blocker | **Fixed** |
| `prisma.config.ts` imports `dotenv/config` but `dotenv` was not a dependency | Blocker (tooling) | **Fixed** (added `dotenv`) |
| No `.env.example` — required `DATABASE_URL` / `SESSION_SECRET` undocumented | High | **Fixed** |
| No seed script — empty app on first run | High | **Fixed** (`prisma/seed.ts`) |
| README was the stock create-next-app template | Medium | **Fixed** |
| `AGENTS.md` was a 6-line placeholder | Medium | **Fixed** |
| No `typecheck` / `db:seed` scripts | Medium | **Fixed** |
| No architecture/security/database docs | Medium | **Fixed** (this `docs/` suite) |

## Known weaknesses / technical debt (not yet addressed)

These are real and tracked for later roadmap phases — see `docs/ROADMAP.md`.

- **No automated tests.** No unit, integration, or E2E tests exist. Highest-value
  next investment: unit tests on `work-intelligence.ts` and RBAC, plus an
  integration test proving Tenant A cannot read Tenant B.
- **Session cookie `secure: false`.** Correct for local HTTP dev, unsafe for
  production. Must be gated on environment before deploy.
- **No rate limiting** on auth, invitations, or sensitive mutations.
- **No session revocation / device management** — JWTs are valid until expiry.
- **No background job runner.** Automations, notifications and digests are
  modeled but there is no worker/queue to execute them on a schedule.
- **No object storage / attachments** despite the domain implying documents.
- **Client data-fetching is ad hoc** (`src/lib/ui/api-client.ts`) with no shared
  cache/invalidation strategy; some pages rely on `demo-data.ts` fallbacks.
- **RBAC is role-fixed** (ADMIN/MANAGER/MEMBER). Custom roles / project-level
  roles / guests are not yet supported.
- **Observability** is `console.error` only — no structured logs, request IDs, or
  error tracking.
- **Build not verified in this environment.** The Linux sandbox used for this
  session could not run `npm`/`tsc`; the fixes above are static (source-level)
  corrections. Run `npm run typecheck && npm run build` locally to confirm green.

## Recommended immediate next steps

1. `npm install && npm run db:generate && npm run typecheck` locally to confirm the
   build is green after the Day-1 fixes.
2. Add the first tests (domain + a tenant-isolation integration test).
3. Environment-gate the cookie `secure` flag.
4. Then proceed with roadmap Phase "Deep task/project layer".
