<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Project OS — engineering context

Persistent context for any engineer or coding agent working in this repository.
Read this before making changes.

## What this is

A multi-tenant project & work-management SaaS. Organizations own projects,
milestones, tasks, dependencies, members, automations and activity. Tenant
isolation is a core security property, enforced in the database.

## Stage 2 — the AI layer (supersedes the former "no AI" rule)

Stage 1 built a deterministic, non-AI foundation. That foundation is done, and
the blanket prohibition on LLM SDKs no longer applies. AI is now an **additive
layer on top of** the platform — it consumes the deterministic core, it does not
replace or live inside it.

The rules that replace the old ban:

1. **Server-side only.** All model calls happen on the server (route handlers,
   server actions, server components). The browser never holds an API key and
   never talks to a model provider directly.
2. **CSP stays as-is.** `connect-src 'self'` in `src/lib/security/headers.ts`
   remains unchanged. If a change to `connect-src` ever looks necessary, that is
   proof a model call has leaked into the client — fix the call, not the policy.
3. **The domain layer stays pure.** Nothing in `src/lib/domain/**` may import the
   AI layer. Health scores, dependency risk, analytics and ranking remain
   deterministic and testable. AI *narrates* those outputs; it never computes them.
4. **`src/lib/ai/**` is a leaf.** It holds the SDK wrapper and prompts only — no
   Prisma, no React, no tenant logic. Callers supply already-authorized,
   already-tenant-scoped data.
5. **Tenant rules are unchanged and still absolute.** Model output is untrusted
   input: validate it (Zod) before it reaches the database, and never let a model
   choose an `organizationId`.
6. **No model output is authoritative.** Treat generated text as a presentation
   detail. Never persist it as a source of truth for a number a domain function
   can compute.

Still out of scope until explicitly asked for: embeddings, vector databases, RAG,
autonomous agents that write to the database unsupervised.

## Architecture (layers)

```
Presentation   src/app/**/page.tsx, src/components/**
Application     src/app/api/v1/**/route.ts  (thin: parse → authorize → delegate)
Domain          src/lib/domain/**           (pure, deterministic, testable)
Infrastructure  src/lib/auth, src/lib/api, src/lib/tenant, src/lib/db
Persistence     Prisma 7 + PostgreSQL
```

Business logic belongs in `src/lib` (domain/infra), **not** inside React
components or route handlers. Route handlers should stay thin.

## Commands

```
npm run dev         # dev server
npm run build       # production build (prisma generate + next build — no DB needed)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run db:generate # prisma client -> src/generated/prisma
npm run db:migrate  # dev migration
npm run db:deploy   # apply migrations (prod)
npm run db:seed     # demo data
```

## Tenant isolation — non-negotiable rules

1. **Never trust an organization id from the client.** Tenant context comes only
   from `requireTenantContext()` (`src/lib/auth/context.ts`), derived from the
   signed session cookie.
2. Every org-owned query MUST be scoped by `organizationId`. Use the helpers in
   `src/lib/tenant/queries.ts` (`requireProjectForTenant`, `requireTaskForTenant`,
   …) rather than raw `findUnique` by id.
3. The schema enforces isolation structurally: child rows reference parents via
   **composite foreign keys** `(id, organization_id)`, so a task can never point
   at a project in another organization. Preserve this pattern for new entities.
4. Wrap API handlers in `withTenantGuard(permission, handler)`
   (`src/lib/api/tenant-guard.ts`) so auth, tenant resolution, permission checks
   and error handling are consistent.

## Authentication

- Sessions are HS256 JWTs signed with `SESSION_SECRET` (≥32 chars), stored in an
  HTTP-only cookie `pm_session` (`src/lib/auth/session.ts`).
- Passwords hashed with bcrypt cost 12 (`src/lib/auth/password.ts`).
- `secure: false` on the cookie today (HTTP dev). **Set `secure: true` before any
  production deployment over HTTPS.**

## Authorization

- Roles: `ADMIN`, `MANAGER`, `MEMBER` (`MembershipRole`).
- Permissions are a matrix in `src/lib/rbac.ts`. Add new permissions there and
  grant them per role — do not scatter `if (role === ...)` checks through the code.
- Enforce server-side with `assertPermission` / `withTenantGuard`. The UI may hide
  actions (`src/lib/ui/permissions.ts`) but the server is authoritative.

## API conventions

- Versioned under `src/app/api/v1/`.
- Validate every request body with a Zod schema from `src/lib/validators.ts` via
  `parseJson(request, schema)`.
- Responses: `json(data, status)` / `empty(status)` from `src/lib/api/http.ts`,
  all `Cache-Control: no-store`.
- Errors: throw `ApiError(status, code, message, details?)`; `handleApiError`
  maps ApiError / ZodError / DB-unavailable / unknown to safe JSON. Never leak
  stack traces or SQL to clients.

## Database

- **Migrations are a release step, not a build step.** `npm run build` runs
  `prisma generate && next build` and never opens a database connection, so a
  sleeping or unreachable database cannot break an unrelated deploy. Apply
  migrations deliberately with `npm run db:deploy` *before* promoting the
  release that depends on them.
- This makes the deploy ordering explicit, and it is the safe order anyway:
  migrations must be backward-compatible with the currently-running code, since
  old and new code briefly overlap during a rollout. Add a column before the code
  reads it; drop one only after the last release that referenced it is gone.
- Prisma schema: `prisma/schema.prisma`. Snake_case columns via `@map`.
- Migrations live in `prisma/migrations` and use idempotent guards
  (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`).
- Generate a new migration with `npm run db:migrate`. Never edit applied
  migrations; add a new one.

## Forbidden patterns

- Model calls from the browser, or any widening of CSP `connect-src` to reach a
  model provider.
- Importing `src/lib/ai/**` from `src/lib/domain/**`, or replacing a deterministic
  calculation with a generated one.
- Persisting unvalidated model output, or letting model output determine an
  `organizationId`.
- Cross-tenant queries (an org-owned query without an `organizationId` filter).
- Trusting client-supplied org/user ids for authorization.
- Business logic inside components or route handlers.
- `if (plan === ...)` / `if (role === ...)` scattered in the UI instead of the
  central permission / (future) entitlement layer.
- Editing already-applied migrations.

## Where to add things

| You want to add… | Put it in… |
| --- | --- |
| A new entity | `prisma/schema.prisma` (composite FK pattern) + migration |
| A new permission | `src/lib/rbac.ts` |
| A request shape | `src/lib/validators.ts` (Zod) |
| A tenant-scoped fetch | `src/lib/tenant/queries.ts` |
| Deterministic calc (health, workload, ranking) | `src/lib/domain/**` |
| A new endpoint | `src/app/api/v1/**/route.ts` wrapped in `withTenantGuard` |
| A system prompt | `src/lib/ai/prompts.ts` (named constant, not inline) |
| A model call | `src/lib/ai/client.ts` (`streamQuality` / `callFast`) — server-side callers only |

See `docs/` for the full audit, architecture, security and database references.
