# Project OS

A multi-tenant, **AI** project & work-management platform. Organizations manage
projects, milestones, tasks, dependencies, members, automations and activity —
with tenant isolation enforced at the database level.

The deterministic project-management core is implemented, with a server-side
Google Gemini layer for policy drafting, What-If Simulation, task composition,
retrospectives, health narratives, forecasts and notification narration. Model
output is untrusted; tenant guards and deterministic calculations remain authoritative.
See [cloud validation](docs/CLOUD-VALIDATION.md) for current evidence and limitations.

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
| AI | Google Gemini via `@google/genai`, server-side only |

## Prerequisites

- Node.js 24 LTS (validated here with 24.19.0; Prisma requires a supported modern Node release)
- A reachable PostgreSQL 14+ instance
- `npm` (a `package-lock.json` is committed)

## Getting started

```bash
# 1. Install dependencies
npm ci

# 2. Configure environment
cp .env.example .env
#   then edit .env — set DATABASE_URL and a 32+ char SESSION_SECRET
#   (generate one with: openssl rand -base64 48)

# 3. Generate the Prisma client
npm run db:generate

# 4. Apply committed migrations to a disposable development database
npm run db:deploy
# Use db:migrate only when authoring a new schema migration.

# 5. Seed disposable demo data (resets the demo organization and users)
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
| `npm run db:deploy` | Apply committed migrations to the explicitly selected database |
| `npm run db:seed` | Load demo data |
| `npm run db:studio` | Open Prisma Studio |

## Validation and cloud setup

`npm run test:domain`, `npm run test:ai`, `npm run test:ai:client` and
`npm run test:ui` exercise deterministic logic, mocked routes, the Gemini client
and React state lifecycles. Run `npm run lint`, `npm run typecheck`, and
`npm run build` as separate checks. Mocked tests do not verify live Gemini.

`npm run test:e2e` requires a seeded **disposable** PostgreSQL database, a
production build, and Chromium. Set `PW_CHROMIUM` to an existing browser if
needed (this cloud environment uses `/usr/bin/chromium`). Set `DATABASE_URL`
explicitly for the test server. Tests create records and must never target a
shared or production database. Live AI tests can skip when prerequisites are absent.

The Codex environment retains dependencies and PostgreSQL data, but services
must restart. Saved environment startup instructions describe the local database
and readiness checks. Installation needs `registry.npmjs.org` and
`binaries.prisma.sh`; fonts are bundled locally by `geist` and need no Google
Fonts download. `GEMINI_API_KEY` is optional for core development and required
for live AI, with outbound HTTPS to `generativelanguage.googleapis.com`. Enter
it securely in environment settings; never commit it or send it to the browser.
See [live verification](docs/LIVE-AI-VERIFICATION.md) and
[deployment](docs/DEPLOYMENT.md). No production deployment is part of cloud setup.

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
