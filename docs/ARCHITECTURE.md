# Architecture

How Project OS is structured and how a request flows through it.

## Principles

- **Modular monolith.** One Next.js app, clear internal boundaries. No premature
  microservices, queues, or event buses.
- **Thin edges, rich core.** Route handlers and React components stay thin;
  business logic lives in `src/lib` (domain + infrastructure).
- **Tenant isolation is structural**, not just procedural — enforced by the
  database schema as well as by runtime guards.
- **Deterministic core, AI at the edge.** The domain layer is pure and
  AI-free; the Stage 2 AI layer (`src/lib/ai/**`) sits above it and narrates its
  output. Model calls are server-side only — see `AGENTS.md`.

## Layers

```
┌───────────────────────────────────────────────────────────────┐
│ Presentation   src/app/**/page.tsx, src/components/**          │
│   React 19 (App Router). Renders data, hides unpermitted UI.   │
├───────────────────────────────────────────────────────────────┤
│ Application    src/app/api/v1/**/route.ts                      │
│   Parse + validate (Zod) → authorize (withTenantGuard) →       │
│   delegate to domain/infra → shape response (json/ApiError).   │
├───────────────────────────────────────────────────────────────┤
│ AI (Stage 2)   src/lib/ai/**                                   │
│   Server-only Anthropic SDK wrapper + system prompts. Leaf     │
│   module: no Prisma, no React, no tenant logic. Reads domain   │
│   output; the domain never reads it.                           │
├───────────────────────────────────────────────────────────────┤
│ Domain         src/lib/domain/**                               │
│   Pure, deterministic functions: project health, workload,     │
│   milestone completion, dependency impact, search ranking.     │
├───────────────────────────────────────────────────────────────┤
│ Infrastructure src/lib/{auth,api,tenant,db,rbac,validators}    │
│   Sessions, password hashing, tenant context, query helpers,   │
│   permission matrix, HTTP envelope, Prisma client.             │
├───────────────────────────────────────────────────────────────┤
│ Persistence    Prisma 7 + PostgreSQL (prisma/schema.prisma)    │
└───────────────────────────────────────────────────────────────┘
```

## Request lifecycle (mutating API call)

```
Client
  → POST /api/v1/projects/:id/tasks
    → withTenantGuard(Permission.TasksCreate, handler)
        → requireTenantContext(permission)
            → cookies() → verifySessionToken()      (who are you?)
            → load user + active membership          (which tenant?)
            → assertPermission(role, permission)     (may you?)
        → handler(request, tenant, ctx)
            → parseJson(request, taskCreateSchema)   (is the body valid?)
            → requireProjectForTenant(tenantId, id)  (tenant-scoped fetch)
            → prisma.task.create({ ... organizationId })
            → json(created, 201)
  ← 201 { ... }   (or ApiError → safe JSON via handleApiError)
```

Every org-owned read/write is scoped by `organizationId` that originates from the
server-derived tenant context — never from the request body or query string.

## Key modules

| Module | Responsibility |
| --- | --- |
| `src/lib/auth/session.ts` | Sign/verify session JWTs, cookie options |
| `src/lib/auth/context.ts` | `requireAuthenticatedUser`, `requireTenantContext` |
| `src/lib/auth/password.ts` | bcrypt hash/verify |
| `src/lib/rbac.ts` | Permission enum, role→permission matrix, assertions |
| `src/lib/api/http.ts` | `json`, `empty`, `parseJson`, `ApiError`, `handleApiError` |
| `src/lib/api/tenant-guard.ts` | `withTenantGuard` handler wrapper |
| `src/lib/tenant/queries.ts` | Tenant-scoped fetch/guards (project, task, member) |
| `src/lib/domain/work-intelligence.ts` | Deterministic health/workload/ranking |
| `src/lib/domain/view-engine.ts` | Pure filter → sort → group pipeline + timeline layout |
| `src/lib/domain/analytics.ts` | Pure analytics: throughput, cycle time, workload, aging, milestone performance (injectable `now`) |
| `src/lib/domain/search.ts` | Pure query parsing, weighted scoring, snippets/highlight ranges, total-order ranking + grouping |
| `src/lib/domain/auth-policy.ts` | Pure password assessment (score + reasons), exponential lockout backoff with a rolling window, session-epoch comparison |
| `src/lib/domain/project-intelligence.ts` | Pure health scoring: six size-normalized signals weighted to 100, ranked explainable factors, velocity trend, schedule slippage, data-sufficiency confidence. Supersedes `calculateProjectHealth` |
| `src/lib/domain/dependency-risk.ts` | Pure blocking-graph analysis: normalized edges, iterative cycle detection with paths, critical chain, ranked bottlenecks, plus tenant-wide portfolio analysis with per-project attribution and cross-project detection |
| `src/lib/dependencies/scope.ts` | The two-sided project-relevance rule for tenant-scoped edges. Single source for the `OR` on both endpoints — filtering one side silently hides inbound cross-project constraints |
| `src/lib/auth/login-guard.ts` | Impure adapter: loads/persists lockout state, appends the sign-in attempt log, salted IP hashing, decoy hash for constant-cost sign-in |
| `src/lib/security/headers.ts` | Pure security header policy (CSP, HSTS, Permissions-Policy, CORP/COOP) |
| `src/middleware.ts` | Applies security headers to every response. Deliberately no auth — Edge runtime has no Prisma |
| `src/lib/ui/commands.ts` | Typed, permission-filtered ⌘K command registry + `g`-prefix navigation map |
| `src/lib/ui/use-goto-shortcuts.ts` | `g` + key navigation hook (ignores fields, expiring prefix) |
| `src/lib/domain/automation-engine.ts` | Pure trigger→condition→action planning + deterministic dedupe keys |
| `src/lib/automation/executor.ts` | Idempotent persistence of automation plans (AutomationRun ledger); inline + scheduled dispatch |
| `src/lib/notifications/service.ts` | Notification creation with preference filtering + unread dedupe |
| `src/lib/ai/client.ts` | Server-only Anthropic wrapper: `streamQuality` (Sonnet, streamed) and `callFast` (Haiku, buffered). Lazy key read, provider errors normalized to plain `Error` |
| `src/lib/ai/prompts.ts` | Named system-prompt constants. One place to review and diff prompt wording |
| `src/lib/validators.ts` | Zod request schemas |
| `src/lib/db.ts` | Prisma client (pg driver adapter, hot-reload safe) |
| `src/components/app-shell.tsx` | Authenticated layout shell |
| `src/components/command-center.tsx` | ⌘K command surface |
| `src/components/views/**` | Board / List / Table / Timeline views + shared toolbar |

## API surface (v1)

Auth: `auth/register`, `auth/login`, `auth/logout`, `auth/me`.
Org: `organizations`, `organizations/current`.
Members: `members`, `members/roster`, `members/invite`, `members/:id`,
`members/:id/role`.
Projects: `projects`, `projects/:id`, `projects/:id/tasks`,
`projects/:id/milestones`, `projects/:id/dependencies`.
Tasks: `tasks/:id`, `tasks/:id/comments`, `tasks/:id/activity`.
Views: `views`, `views/:id`.
Dashboard: `dashboard/summary`, `dashboard/my-tasks`, `dashboard/project-progress`.
Analytics: `analytics/overview`, `analytics/projects/:id`.
Intelligence: `intelligence/overview`, `intelligence/projects/:id` — read-only
health scoring and dependency risk. Both declare `readOnly: true`.
Work OS: `work-os/overview`.
Search: `command/search` (`?q=`, `?types=`, `?projectId=`) — tenant-scoped, and
each entity type gated on its own permission rather than one blanket flag.
Automations: `automations`, `automations/:id`, `automations/run`.
Notifications: `notifications`, `notifications/:id`, `notifications/read-all`,
`notifications/preferences`.

## Conventions

- **Versioning.** All endpoints live under `/api/v1`. Breaking changes go to a new
  version namespace; do not silently change `v1` contracts.
- **Validation.** No handler trusts a raw body — always `parseJson(req, schema)`.
- **Errors.** Throw `ApiError`; let `handleApiError` translate. Distinguish
  validation (422), auth (401), forbidden (403), not-found (404), conflict (409),
  DB-unavailable (503), internal (500).
- **Caching.** API responses are `no-store` by default.
- **Naming.** DB columns are snake_case via Prisma `@map`; TS is camelCase.

## AI layer (Stage 2)

`src/lib/ai/**` is a leaf module wrapping the Anthropic SDK. Two entry points:
`streamQuality` (claude-sonnet-4-5, streamed, for prose a user watches appear)
and `callFast` (claude-haiku-4-5, buffered, for short or structured output).

Non-negotiables:

- **Server-side only.** `ANTHROPIC_API_KEY` is a server env var with no `NEXT_PUBLIC_`
  prefix, so it cannot reach a client bundle. Importing this module into a Client
  Component is a bug.
- **CSP unchanged.** `connect-src 'self'` still holds: the browser talks to our API,
  our server talks to Anthropic. Needing to widen `connect-src` would mean a model
  call escaped to the client.
- **The domain layer never imports it.** Numbers stay deterministic; AI describes them.
- **Output is untrusted.** Anything JSON-shaped gets parsed and Zod-validated before
  it goes near Prisma.

## Extensibility hooks for later (built, not yet wired)

- `ActivityLog` and audit-style writes give the AI/analytics layer a clean
  event history to consume.
- The permission matrix is the single seam for evolving to custom roles and, later,
  plan entitlements — without touching call sites.
- Domain functions are pure and side-effect-free, so they are trivially testable
  and reusable by future services.

See `docs/SECURITY.md` and `docs/DATABASE.md` for deeper detail, and
`docs/SHORTCUTS.md` for the keyboard surface and search ranking rules.
