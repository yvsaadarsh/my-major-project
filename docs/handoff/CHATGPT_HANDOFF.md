# ProjectOS — ChatGPT Continuation Brief

> Checkpoint handoff from the Claude Code environment. This document describes
> the **actual committed state** of the handoff branch. It does not describe
> uncommitted work as transferred. No secrets are included.

## A. Project identity

| | |
|---|---|
| Repository | `https://github.com/yvsaadarsh/my-major-project` |
| Source branch (base) | `phase-d3-fixes` |
| Base commit (parent of checkpoint) | `14064e2c299aa6c1a1e931224edcaae2442d8223` |
| Handoff branch | `handoff/chatgpt-2026-10-26` |
| Handoff commit | the single checkpoint commit at the tip of the handoff branch (SHA reported in the agent's final message and verifiable with `git log -1 handoff/chatgpt-2026-10-26`) |
| Pushed & remotely verified | see the agent's final report — push status is stated there with evidence |

Note: `phase-d3-fixes` was a **local-only** branch (the remote had only `main`),
so the handoff branch carries the full `phase-d3-fixes` history (commits
`1b7ccc2 … 14064e2`) **plus** this checkpoint commit.

## B. Architecture and implementation

- **Stack:** Next.js 16 (App Router) + React 19 + TypeScript 5; Prisma 7 with the
  `@prisma/adapter-pg` driver adapter over PostgreSQL 16; Zod validation; custom
  HS256 JWT auth (`pm_session` cookie); RBAC in `src/lib/rbac.ts`;
  `withTenantGuard` for tenant scoping.
- **Layering:** presentation (`src/app/**`, `src/components/**`) → thin API
  routes (`src/app/api/v1/**`) → pure deterministic domain (`src/lib/domain/**`)
  → infra (`src/lib/auth|api|tenant|db`) → Prisma/Postgres. The domain layer is
  deterministic and must never import the AI layer.
- **AI provider:** **Google Gemini** via `@google/genai` **v2.31.0**. The sole
  model-talking module is `src/lib/ai/client.ts`. No `@anthropic-ai/sdk`
  dependency or import remains. Key env var: **`GEMINI_API_KEY`** (server-only;
  no `NEXT_PUBLIC_` prefix; CSP `connect-src 'self'`). Models: `gemini-2.5-pro`
  (quality/streamed) and `gemini-2.5-flash` (fast/structured), overridable via
  `GEMINI_QUALITY_MODEL` / `GEMINI_FAST_MODEL`. Reliability knobs:
  `GEMINI_TIMEOUT_MS` (default 30000), `GEMINI_RETRY_ATTEMPTS` (default 3,
  transient-only 408/429/5xx, capped at 5). Streaming disables retries.
- **Core features already implemented:** AI Policy Studio (`/automations`),
  What-If Simulation (`/intelligence/[projectId]`), AI task parsing / compose,
  milestone retrospective, project health narrative, forecast, and smart
  notification narration — all routed through the single Gemini client.

## C. Work completed

### Committed before this checkpoint (history through `14064e2`)
Phases A–F: shared frontend foundations, AI Policy Studio UI, What-If Simulation
workspace, Phase D1 simulation concurrency + intent/change consistency, Phase D3
domain-test runner + D-6/D-7/D-9/D-10 fixes, Phase D4 live-model suite scaffold,
D-8 (AI rules save disabled; DB-layer default), and the Phase F Playwright E2E.

### Included in this checkpoint commit (previously uncommitted)
Reviewed ProjectOS work (18 modified + 5 new files, including this brief):

- `src/lib/ai/client.ts` — **Anthropic→Gemini rewrite + hardening**: bounded
  timeout + SDK transient-only retry (configured, not a second layer), key
  redaction in errors, optional `AbortSignal`, a test seam
  (`__setClientFactoryForTests`), env-overridable models.
- `src/app/api/v1/intelligence/projects/[projectId]/apply/route.ts` —
  **concurrency error-mapping fix**: `isWriteConflict` recognises Prisma `P2034`,
  SQLSTATE `40001`/`40P01` on `.code`, driver-adapter `originalCode`/`kind`
  (`TransactionWriteConflict`) → serialization aborts return **409**, not 500.
- `scripts/doubles/db.ts`, `scripts/doubles/auth-context.ts` — **lint: removed
  all `@typescript-eslint/no-explicit-any` errors** (typed to `Args`/`unknown`/
  inferred/`MembershipRole`); one narrow, documented `Row` exception remains.
- `scripts/doubles/ai-client.ts`, `scripts/test-ai-routes.ts`,
  `scripts/test-ai-live.ts` — Gemini rename + the live suite now gates on
  `GEMINI_API_KEY` and self-skips BLOCKED.
- `src/app/.../narrative/route.ts`, `src/app/intelligence/[projectId]/page.tsx`,
  `src/lib/automation/executor.ts`, `src/lib/security/headers.ts` — provider
  rename in comments only.
- `.env.example` — `ANTHROPIC_API_KEY`→`GEMINI_API_KEY` + optional model/
  reliability knobs (placeholders only).
- `docs/DEPLOYMENT.md` — documents `GEMINI_API_KEY` as a required Vercel env var.
- `package.json` / `package-lock.json` — `@google/genai` in, `@anthropic-ai/sdk`
  out; added `test:ai:client`; added the narrator test to `test:domain`.
- `e2e/policy-studio.spec.ts`, `e2e/simulation.spec.ts`,
  `e2e/stale-replay.spec.ts` — Gemini rename in skip messages / selectors.
- **New:** `scripts/test-ai-client.ts` (24 unit tests for the Gemini client:
  timeout/retry config, error classification, key redaction, streaming),
  `scripts/test-notification-narrator.ts` (13 tests: fallback-null safety,
  sanitize, memoisation), `docs/LIVE-AI-VERIFICATION.md` (runbook),
  `scripts/live-verify.ps1` (Windows live-verification script), and this brief.

## D. Verification

**Reproduced in the Claude environment at checkpoint time (offline, no Gemini):**

| Command | Result | Provenance |
|---|---|---|
| `npx tsc --noEmit` | PASS (exit 0) | — |
| `npm run test:ai` | PASS 263/263 | mocked AI (doubles) + in-memory DB double |
| `npm run test:ai:client` | PASS 24/24 | injected fake client (no network) |
| `npm run test:domain` | PASS 436/436 | pure logic |
| `npm run lint` | FAIL 16 errors / 5 warnings | **pre-existing** Next `setState-in-effect` across ~11 UI files (not from this work) |
| `npx next build` | PASS (with offline flag) | `npm run build` needs network for Prisma engine; `PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1 npx next build` succeeds. Not re-run at checkpoint. |
| migrations | PASS applying all 9 SQL files to a fresh disposable DB | offline SQL apply; Prisma `migrate status` checksum tracking is BLOCKED (engine download blocked) |

- **Live Gemini: BLOCKED / UNVERIFIED.** The Claude environment cannot reach
  `generativelanguage.googleapis.com` (egress `403`/DNS). No real model response
  was ever obtained, so **no AI feature is live-verified**. `scripts/live-verify.ps1`
  exists to perform live verification from a Windows host with egress, but it has
  **not been runtime-tested on Windows** (static/contract-verified only).

## E. Outstanding work (priority order)

1. **Live Gemini verification (BLOCKED).** Run `scripts/live-verify.ps1` from a
   Windows PowerShell 5.1 host that has a local disposable PostgreSQL, CREATE
   DATABASE privilege, a valid `AIza…`/`AQ.`-format `GEMINI_API_KEY` in `.env`,
   and direct egress to Google's API. Then adjudicate all seven features. See
   `docs/LIVE-AI-VERIFICATION.md`.
2. **Lint debt (16 errors).** All are the Next/React "setState synchronously
   within an effect" rule across UI pages/components. Fixing correctly needs a
   component-test harness (RTL/jsdom) before refactoring effects — do not mass
   refactor without tests. The `any` lint errors are already fixed.
3. **Prisma migration integrity.** `migrate status`/`deploy` checksum tracking is
   unverified (engine download blocked here); verify from a networked env.
4. **Confirm the `AQ.` key's model access** once reachable (gemini-2.5-pro/-flash);
   else set `GEMINI_QUALITY_MODEL`/`GEMINI_FAST_MODEL`.
5. **Deployment prerequisites:** set `GEMINI_API_KEY` (and optional knobs) in
   Vercel; run `prisma migrate deploy` against Neon before promoting.

## F. Continuation instructions (for the next agent)

1. Continue from branch `handoff/chatgpt-2026-10-26` at its checkpoint commit.
2. Inspect the actual repository before changing anything; prior reports
   (including this one) are context, not proof of current state.
3. Do **not** rebuild already-implemented features (the Gemini swap, the seven
   AI features, concurrency fix, D-8, E2E are done).
4. Do **not** assume historical test numbers are current — re-run the suites.
5. Preserve all existing work and history; do not reset/clean/force-push.
6. Do **not** push, merge, or deploy without further explicit authorization.
7. Keep secrets out of the repo and reports; `.env` is gitignored — never commit it.
8. Work within the available cloud coding environment.
9. If your environment cannot write to or execute the repository (no writable
   clone, no PostgreSQL, no Gemini egress, or no Windows host for the live
   script), state exactly which capability is missing rather than claiming the
   handoff is complete.

**Exact next recommended task:** obtain a Windows host with Gemini egress and a
disposable local PostgreSQL, run `scripts/live-verify.ps1`, and record the
seven-feature live verdicts — that is the only step that converts the AI features
from "offline-tested" to "live-verified."
