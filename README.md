# Project OS

A multi-tenant, **AI** project & work-management platform. Organizations manage
projects, milestones, tasks, dependencies, members, automations and activity —
with tenant isolation enforced at the database level.

> **Stage 1 (now):** build the best possible non-AI foundation.
> **Stage 2 (later):** AI is added as a separate layer on top. No AI code lives in
> this repository today, by design — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tech stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router, React 19) |
| Language | TypeScript (strict) |
| Database | PostgreSQL via Prisma 7 + `@prisma/adapter-pg` |
| Auth | Session JWT (`jose`, HS256, HTTP-only cookie) + bcrypt password hashing |
| Validation | Zod |
| Authorization | Role-based permission matrix (`src/lib/rbac.ts`) |
| Styling | Tailwind CSS v4 |
| Icons | lucide-react |

## Prerequisites

- Node.js 20+
- A reachable PostgreSQL 14+ instance
- `npm` (a `package-lock.json` is committed)

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#   then edit .env — set DATABASE_URL and a 32+ char SESSION_SECRET
#   (generate one with: openssl rand -base64 48)

# 3. Generate the Prisma client
npm run db:generate

# 4. Apply migrations to your database
npm run db:migrate      # dev (creates/updates the DB from prisma/migrations)
# or, against an existing prod DB:
# npm run db:deploy

# 5. Seed demo data (optional but recommended)
npm run db:seed

# 6. Start the dev server
npm run dev
# open http://localhost:3000
```

### Demo logins (after `npm run db:seed`)

| Email | Password | Role |
| --- | --- | --- |
| `ada@northwind.test` | `Password123!` | ADMIN |
| `grace@northwind.test` | `Password123!` | MANAGER |
| `linus@northwind.test` | `Password123!` | MEMBER |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server (webpack) |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` type checking |
| `npm run db:generate` | Generate the Prisma client into `src/generated/prisma` |
| `npm run db:migrate` | Create/apply a dev migration |
| `npm run db:deploy` | Apply committed migrations (prod) |
| `npm run db:seed` | Load demo data |
| `npm run db:studio` | Open Prisma Studio |

## Project layout

```
prisma/
  schema.prisma          # data model (see docs/DATABASE.md)
  migrations/            # SQL migration history
  seed.ts                # demo data
src/
  app/
    api/v1/              # versioned REST API (route handlers)
    (pages)/             # dashboard, projects, members, work-os, onboarding, ...
  components/            # app shell, command center, UI primitives
  lib/
    api/                 # http helpers (json, errors) + withTenantGuard
    auth/                # sessions, password hashing, tenant context
    domain/              # deterministic work intelligence (health, workload)
    tenant/              # tenant-scoped query helpers
    ui/                  # client-side data + permission helpers
    rbac.ts              # permission matrix
    validators.ts        # Zod request schemas
docs/                    # audit, architecture, security, database, roadmap
```

## Documentation

- [`docs/BASELINE_AUDIT.md`](docs/BASELINE_AUDIT.md) — honest state of the codebase
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, request lifecycle, conventions
- [`docs/SECURITY.md`](docs/SECURITY.md) — tenant isolation, auth, authorization
- [`docs/DATABASE.md`](docs/DATABASE.md) — entities, relationships, indexes
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased plan toward the full vision
- [`AGENTS.md`](AGENTS.md) — engineering context for coding agents

## License

Private / unpublished.
