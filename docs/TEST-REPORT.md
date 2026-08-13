# ProjectOS — Test Report

**Date:** 13 August 2026
**Build under test:** `main`, deployed at https://my-major-project-rho.vercel.app
**Scope:** whole platform, with depth on the Stage 2 AI layer

---

## Headline

| | |
| --- | --- |
| **Automated assertions** | **445 passed, 0 failed** |
| Defects found in application code | **0** |
| Defects found in the test harness | 4 (all fixed) |
| Security / tenant-isolation findings | 0 real (5 investigated, all false positives) |

Run it yourself:

```
npm test          # everything — 445 assertions
npm run test:domain   # 343 — pure domain logic
npm run test:ai       # 102 — AI route behaviour
```

`npm run test:ai` needs **no database and no `prisma generate`**. It runs from a
clean checkout.

---

## 1. What was tested, and how

Four layers, deliberately different in kind:

| Layer | Method | Assertions |
| --- | --- | --- |
| Domain logic | Pure functions, real inputs | 343 |
| AI route handlers | Real route code, doubled I/O | 102 |
| Architecture & security | Scripted source audit | 20 checks |
| Deployment | Live HTTP against production | manual |

### The AI tests run your real code

`scripts/test-ai-routes.ts` imports the **actual route handlers** and calls them.
Only three things are substituted, via path mappings in `tsconfig.test.json`:

| Real module | Test double | Why |
| --- | --- | --- |
| `@/lib/db` | in-memory store | no database needed; lets a second tenant's rows exist for isolation probes |
| `@/lib/auth/context` | scriptable session | lets one test be an ADMIN and the next a MEMBER |
| `@/lib/ai` | scriptable model | lets the model return malformed JSON, fail mid-stream, or fail on the first token |

Nothing under `src/` is modified. Validation, status codes, tenant scoping,
streaming and model-output parsing are all exercised exactly as written. The
**system prompts are the real ones**, re-exported from source — so the
prompt-wiring assertions check the genuine prompts, not copies.

---

## 2. Domain suite — 343 assertions

Unchanged from the existing suite, re-run to confirm no regression:

| Suite | Assertions | Result |
| --- | --- | --- |
| `test-auth-policy` | 83 | pass |
| `test-security-headers` | 41 | pass |
| `test-intelligence` | 219 | pass |

Covers size normalization (including the pinned regression for the old scorer's
bug), the three velocity zero-states, slippage weighting, confidence, cycle
detection on a 10,000-deep chain, cross-project cycles with a control case,
determinism over 100 runs, and input purity.

---

## 3. AI layer — 102 assertions

### 3.1 Configuration & authorization

- `501` when `ANTHROPIC_API_KEY` is absent — every AI route degrades instead of erroring
- `403` for a role lacking the required permission (MEMBER cannot use parse-task)
- `401` when unauthenticated

### 3.2 Input validation (parse-task)

- `422` above 500 characters; **500 exactly is accepted** (boundary verified)
- `422` on empty text, `422` on missing `projectId`
- `400` on a malformed JSON body

### 3.3 Tenant isolation

- `404` — not `403` — for another tenant's project, so a guessed id is
  indistinguishable from a nonexistent one
- `404` for another tenant's milestone
- `404` for a milestone that exists in *this* tenant but a **different project**
- Slippage from a task outside the milestone is excluded from its statistics

### 3.4 Untrusted model output

The model is treated as hostile input. All handled:

| Model returns | Result |
| --- | --- |
| Well-formed JSON | 200, fields pass through |
| Wrapped in a ```` ```json ```` fence | recovered |
| Wrapped in prose ("Sure! Here is…") | recovered |
| A single-element array | recovered — see §6 |
| A multi-task array | `422` — never guesses which task |
| No JSON at all | `422` "Could not parse task from that text" |
| No title / whitespace title | `422` |
| `priority: "bogus"` | falls back to `MEDIUM` |
| `priority: "urgent"` | normalized to `URGENT` |
| `dueDate: "next friday"` | `null` — never guesses a date |
| `dueDate: "20-08-2026"` | `null` — non-ISO rejected |
| A 400-character title | bounded to 180 |
| Wrong-typed fields (`priority: 123`) | degrade safely |
| The call throws | `502` |

### 3.5 Streaming & failure

- Concatenated chunks arrive intact
- `Content-Type: text/plain`, `Cache-Control: no-store`, `X-Accel-Buffering: no`
- `Transfer-Encoding` is **not** set by hand (hop-by-hop — correct)
- Failure **before** the first chunk → `502` with a real status code
- Failure **mid-stream** → `200` retained, reader keeps the partial text

### 3.6 Forecast guards

- Under 5 open tasks → `200 { insufficient: true }`, not an error
- Exactly 5 open tasks → forecast proceeds (boundary verified)
- 13-day-old project refused; 15-day-old project forecast (boundary verified)
- DONE tasks correctly excluded from the open-task floor
- `daysUntilDeadline` is `null` when no end date is set

### 3.7 Retrospective correctness

- `400` for every open status (PLANNED, ON_TRACK, AT_RISK)
- The status gate is checked **before** the AI-configured gate, so "this
  milestone is still open" answers identically on every deployment
- `DONE` and `MISSED` both produce a retrospective
- Arithmetic verified against a hand-built fixture: `totalTasks` 3,
  `completedTasks` 2, `tasksWithSlippage` 1, `maxDaysPushed` 6,
  `avgDaysPushed` 5, `overdueAtCompletion` 1, `daysEarlyOrLate` +5 when late
  and −7 when early
- A milestone with no tasks reports zeroes rather than crashing

### 3.8 What actually reaches the model (data egress)

Asserted directly on the prompt string:

- **No task titles** in the forecast or retrospective context
- **No organization id**, **no project id**, **no task ids** in any AI call
- parse-task sends the user's text, the project *name*, and a reference date
- Correct system prompt is wired to each route

---

## 4. Architecture & security audit

| Check | Result |
| --- | --- |
| Every non-auth API route uses `withTenantGuard` | pass |
| 93 org-owned Prisma queries filter on `organizationId` | pass |
| `organizationId` never read from a request body/param | pass |
| Tenant id derived from session in 37 route files | pass |
| `src/lib/domain/**` never imports `src/lib/ai/**` | pass |
| `src/lib/domain/**` never imports Prisma | pass |
| `src/lib/ai/**` has no Prisma, React or tenant imports | pass |
| All four AI routes are server-only | pass |
| No AI route writes to the database | pass |
| No live Anthropic key in tracked files | pass |
| No secret behind a `NEXT_PUBLIC_` prefix | pass |
| CSP `connect-src 'self'` intact | pass |
| `.env` gitignored | pass |

**Five items were flagged and individually investigated. All five were false
positives in the audit script:**

1. `auth/password` and `organizations` lack `withTenantGuard` — correct: both
   authenticate with `requireAuthenticatedUser()`. Password change is
   user-level, and organization creation happens *before* a tenant exists.
2. `taskDependency.findMany` appeared unscoped — it uses the
   `dependenciesRelevantToProject()` helper, which injects `organizationId`.
3. `slug.ts` queries organizations without a tenant filter — correct: slugs are
   globally unique, so the check must be global. It returns nothing to the user.
4. `notifications/service.ts` uses `input.organizationId` — that is an internal
   function parameter; its only caller passes the server-derived `tenantId`.
5. A "real API key" and "NEXT_PUBLIC secret" — both were bugs in the audit
   script's shell pipeline. `.env.example` holds the placeholder `sk-ant-...`,
   and the only `NEXT_PUBLIC` match is a comment explaining the key has no such
   prefix.

---

## 5. Static analysis

- **TypeScript:** 0 errors in all six files changed across this work. (Verified
  by substituting a correctly-typed Prisma client; the remaining errors in the
  sandbox are artifacts of the stub, not the code.)
- **ESLint:** 0 issues introduced. 20 pre-existing warnings remain, all
  `react-hooks/set-state-in-effect` and `exhaustive-deps` in pages written
  before this work. None block the build — proven by the live deployment.

---

## 6. Findings and judgement calls

No defects were found in application code. Three things are worth stating
explicitly rather than leaving implicit.

### 6.1 A single-element array is recovered, not rejected

If the model wrongly returns `[{...}]` instead of `{...}`, the route extracts the
inner object. This is deliberate: the intent is unambiguous, the user confirms
before anything is created, and every field is still normalized. A **multi-task**
array is rejected, because choosing one would be a guess. If your reviewers
prefer strictness, the change is one line in `extractJsonObject`.

### 6.2 Milestone closure time is inferred

`Milestone` has no `completedAt` column. The retrospective derives closure from
the latest `completedAt` among its DONE tasks, falling back to `updatedAt`. Both
approximate a fact the schema does not record. The proper fix is a `completedAt`
column written on status change.

### 6.3 There is no PATCH route for milestones

`milestones/route.ts` exposes GET and POST only, so nothing in the running app
marks a milestone DONE or MISSED. The retrospective reads whatever status is
stored and is correct, but the status has to arrive via seed data until a PATCH
endpoint exists.

---

## 7. What was **not** tested, and why

Stated plainly so the coverage claim is honest:

- **Browser end-to-end.** The Chrome extension was not connected, so no clicking
  through the live UI. The React components were verified by type-checking and
  code review, not by rendering.
- **Live authenticated API calls.** Testing those requires signing in, which I
  do not do on a user's behalf. Unauthenticated reachability was confirmed.
- **Real Anthropic responses.** The sandbox has no API key, so the model is
  doubled. This is *stronger* for testing failure paths — a real model will not
  reliably produce malformed JSON on demand — but it does not measure prompt
  quality. Judging whether the prose is *good* needs a human with a real key.
- **Database-level behaviour.** Prisma's engine download is firewalled in the
  sandbox, so migrations, composite foreign keys and cascade rules were verified
  by schema review, not by execution.

---

## 8. Recommended before presenting

1. **Confirm the newest routes are deployed.** The forecast and retrospective
   were added most recently; check the Vercel deployment includes them.
2. **Rotate two credentials.** The Neon password and the Anthropic key both
   passed through chat during development.
3. **Set `secure: true` on the session cookie.** `src/lib/auth/session.ts` notes
   this is required for production HTTPS.
4. Optionally add the milestone PATCH route (§6.3) so the retrospective can be
   demonstrated end to end.
