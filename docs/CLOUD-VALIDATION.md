# Cloud validation — 2026-10-26

Continued from `29c5c9ea17e7027908b29790237b6bce0fb601e5` on
`handoff/chatgpt-2026-10-26`; parent
`14064e2c299aa6c1a1e931224edcaae2442d8223` verified. The earlier cloud checkout
was `36ccb6c5830efd75868bf7be77dbb7ffea9944a6` on `work`; that branch was preserved.
All results below were executed in Codex cloud, not inferred from the handoff.

## Environment and evidence

Node 24.19.0, npm 11.9.0, PostgreSQL 17.11, Prisma 7.8.0, Next.js 16.2.4,
and system Chromium. Database writes targeted only the newly created disposable
`projectos_review_20261026` on loopback. No production database was accessed.

| Check / command | Exit | Status | Evidence |
| --- | --- | --- | --- |
| `npm ci --cache /workspace/.npm` | 0 | PASS | Frozen lockfile installation, postinstall client generation; repeated successfully |
| `npm run db:generate` (also in build/postinstall) | 0 | PASS | Prisma engine and checksum downloads work; client generated |
| `npx prisma validate` | 0 | PASS | Schema valid; existing relation warning below |
| `npm run db:deploy` | 0 | PASS | Nine migrations applied via Prisma; repeated run has no pending migrations |
| `npx prisma migrate status` | 0 | PASS | Up to date; all nine stored SHA-256 checksums separately matched committed SQL, finished and not rolled back |
| `npm run db:seed` | 0 | PASS | Seeded only the disposable database |
| `npm run test:domain` | 0 | PASS | 436 assertions: 83 auth + 41 headers + 219 intelligence + 35 narrative + 45 parsing + 13 notification narrator |
| `npm run test:ai` | 0 | PASS | 263 assertions using AI and database doubles |
| `npm run test:ai:client` | 0 | PASS | 24 assertions using an injected Gemini client |
| `npm run test:ui` | 0 | PASS | 21 React checks: cancellation, stale responses, tenant changes, retry, storage persistence/failure and draft-title handoff |
| `npm run lint` | 0 | PASS | Baseline 16 errors / 5 warnings; final 0 / 0, no new rule suppressions |
| `npm run typecheck` | 0 | PASS | TypeScript succeeds |
| `npm run build` | 0 | PASS | Standard Prisma + Next production build; no checksum/TLS bypass |
| `PW_CHROMIUM=/usr/bin/chromium npm run test:e2e` with explicit disposable `DATABASE_URL` | 0 | PASS | 7 passed, 3 skipped; skipped live-AI scenarios remain BLOCKED |
| `npm run test:ai:live` | 0 | BLOCKED | Runner explicitly reports NOT RUN: no `GEMINI_API_KEY`; zero live-model assertions |
| Environment publication | — | NOT RUN | Draft persistence is separate from publication; no publish operation is available to this agent |

The historical 612 assertions came from an older checkout: 423 domain + 189
mocked route assertions. They are not added to the current 744 assertion total.
Browser tests are reported separately, not counted as those assertions.

## What the browser tests prove

Real production-server requests and PostgreSQL writes verified page hydration
(analytics, intelligence, Work OS, notifications and members), search URL handoff,
project view persistence, task draft handoff, project/task creation and task status
updates. A separately registered tenant cannot list, read or update the first
tenant's task; unauthorized access returns 401 and cross-tenant access returns 404.
Member policy/simulation/apply restrictions return 403. Manual rules start disabled
and can be explicitly activated. The simulation workspace renders its controls.
The page regression test recorded no uncaught browser page errors.

One intermediate tenant test accidentally inherited Playwright's admin storage
state. It was corrected to explicitly create an empty context, and passed with
real separate registration and tenant creation. No authorization check was weakened.
No comprehensive visual/accessibility audit or production deployment was performed.

## Changes

- Reporting, automation, intelligence, search and notification pages use the new
  `src/lib/ui/use-api-query.ts` request lifecycle. It derives loading from request
  keys and aborts/ignores obsolete responses. Action errors remain separate.
- `src/lib/ui/use-project-view.ts` subscribes to persisted project view preferences;
  projects, search, command cursor, lockout notice and task title state no longer
  need the flagged synchronous effect updates. Member loading dependencies are explicit.
- Removed unused session-domain parsing and an unused risk-weight constant;
  session cookies remain host-only with production Secure behavior unchanged.
- Added `scripts/test-ui.ts`, its React Testing Library/jsdom development dependencies,
  and `e2e/core-workflows.spec.ts`. Existing domain and AI test assertions were retained.
- README, architecture, roadmap, deployment, live-AI guidance, `.env.example` and
  AGENTS.md now describe Gemini, actual validation and host-only cookies. The Day-1
  audit is explicitly historical. The original handoff remains unchanged as evidence.

## Remaining limitations and next steps

1. **BLOCKED — live Gemini.** Existing binding names and local environment were
   checked without printing values: `GEMINI_API_KEY` is absent. An unauthenticated
   HTTPS connectivity probe to `generativelanguage.googleapis.com` received proxy
   CONNECT HTTP 403. A secure secret requirement and destination were saved in the
   environment draft. Supply the development key and apply access in environment
   settings, then rerun the live suite and per-feature checks. Do not treat mocked
   tests, fallbacks, or the three skipped E2E cases as live success.
2. **Existing schema warning:** `Task.milestone` uses composite `SetNull` with required
   `organizationId`. Milestone deletion semantics need a separate deliberate schema
   migration and regression test. No milestone-delete behavior was claimed here.
3. **Existing Next warning:** middleware file convention is deprecated in favor of
   proxy. Builds succeed; migration was outside this focused repair.
4. **NOT RUN — publication/new-task restoration.** Install/startup configuration is
   saved for review. The platform's environment settings own publication. Review and
   publish after accepting the live-AI limitation, or complete live validation first.

The original Prisma HTTP 403 is resolved: the checksum endpoint returned HTTP 200
and verified installation succeeded. Google Fonts access is unnecessary on this
checkpoint because `geist` ships local fonts. The existing domain entries were
preserved. Local setup uses loopback-only PostgreSQL trust authentication in this
isolated machine; this is not a production database configuration.

Command logs are retained outside the repository under
`/workspace/.onboarding/results`. Auth storage, `.env`, dependencies and generated
outputs remain ignored. Git history is preserved; no merge, force-push or production
deployment is part of this work. The final chat report records the commit and push
result so this document does not need to embed its own commit hash.
