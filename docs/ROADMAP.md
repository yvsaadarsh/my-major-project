# Roadmap

Phased plan from the current foundation toward the full non-AI vision. Each phase
is scoped to a focused work session and ends in a verifiable state (build green,
tests, or a walkthrough). Order can shift when the code shows a better dependency
path.

## Phase 0 — Consolidate, stabilize, document ✅ (done — Day 1)

- Fixed the compile blocker in `src/lib/rbac.ts`.
- Added missing `dotenv` dependency for Prisma tooling.
- Added `.env.example`, `prisma/seed.ts`, `typecheck`/`db:seed` scripts.
- Rewrote `README.md` and `AGENTS.md`; added the `docs/` suite (audit,
  architecture, security, database, this roadmap).

**Outstanding for you:** run `npm install && npm run db:generate && npm run
typecheck && npm run build` locally to confirm green (the session sandbox couldn't
run npm/tsc).

## Phase 1 — Testing foundation + safety net

- Unit tests for `work-intelligence.ts` (health, workload, dependency impact) and
  the RBAC matrix.
- One integration test proving **Tenant A cannot read Tenant B**.
- Environment-gate the session cookie `secure` flag.
- Wire a test runner (`vitest`) + `npm test`.

## Phase 2 — Deep task & project layer

- Subtasks (self-referencing parent/child on `Task`).
- Task detail view: comments, dependencies, activity, assignees.
- Dependency graph UI + circular-dependency detection.
- Milestone progress wired end-to-end from real task data.

### Day 2 progress ✅

- **Subtasks shipped end-to-end.** Schema self-relation + `20260812090000_subtasks`
  migration; `subtaskProgress` and `wouldCreateSubtaskCycle` domain helpers; task
  create/update routes accept and validate `parentTaskId` (org+project scoped, with
  409 `circular_subtask` guard and self-parent rejection); task detail page has a
  Subtasks section (progress bar, create, mark-done, parent link).
- **Milestone assignment on tasks.** Create/update accept `milestoneId` (validated
  against the same org+project); milestones `GET` now returns live `taskTotal`,
  `taskCompleted`, `completion`; project page renders a Milestones panel with
  progress bars driven by real task data.
- **Dependencies UI.** Task detail Dependencies section (blocks / blocked-by lists
  + linking, surfacing the server's `circular_dependency` 409 inline); project page
  Dependencies panel renders source → target edges with type labels.
- **Activity feed.** New `GET /api/v1/tasks/[taskId]/activity` (org-scoped, newest
  first, limit 50); task detail Activity section renders a human-readable feed.

Still open from Phase 2: none of the above blocks; remaining depth (board DnD,
richer graph layout) rolls into Phase 3+.

## Phase 3 — Views system

- Reusable view infrastructure: List, Board, Table, Timeline.
- Filter / sort / group / hide-columns.
- Saved views (per user, shareable where permitted).

### Day 3 progress ✅

- **View engine domain layer.** New `src/lib/domain/view-engine.ts`: pure,
  deterministic `filterTasks` / `sortTasks` / `groupTasks` / `applyView`, plus
  `buildTimelineLayout` and `normalizeViewConfig`. Stable sorts, severity/workflow
  orderings, null due dates always last, fixed-domain groups (status, priority,
  due-date buckets) always emitted so board columns never disappear. No React,
  no Prisma — the same code runs on server and client.
- **Four real views.** `src/components/views/` ships `board-view`, `list-view`,
  `table-view` (sortable `<th>` buttons with `aria-sort`, per-column visibility)
  and `timeline-view` (CSS-only positioned bars, horizontal scroll on mobile,
  "no dated tasks" empty state). All four consume the identical `ViewProps`.
- **Shared toolbar.** `view-toolbar.tsx` gives every view a common control bar:
  view-type switch, search, status/priority/assignee/milestone multi-selects,
  overdue-only + include-subtasks toggles, sort field/direction, group-by,
  column visibility (table) and saved-view management.
- **Saved views end-to-end.** `SavedView` model + `20260813090000_saved_views`
  migration (nullable `project_id` for org-level views, composite FKs to project
  and owning member); `GET/POST /api/v1/views` and `PATCH/DELETE
  /api/v1/views/[viewId]`; `view.created` / `view.updated` / `view.deleted`
  activity entries. Any member manages their own views; only `projects:update`
  roles can share a view or curate a shared one.
- **Wired into the project board.** The projects page now drives Board/List/
  Table/Timeline from one `ViewConfig`, loads and saves views for the selected
  project, and remembers the last-used view type/config per project in
  `localStorage`. The tasks endpoint now also returns `assignedToUserId`,
  `milestoneId`, `parentTaskId` and the milestone name the views need.

## Phase 4 — Automation engine + notifications

- Execute `AutomationRule`s deterministically (trigger → condition → action).
- Idempotency, retries, audit entries.
- Notification preferences, grouping, read/unread, deep links.
- Requires a background job runner (see Phase 7).

### Day 4 progress ✅

- **Deterministic automation engine.** New `src/lib/domain/automation-engine.ts`:
  pure `parseCondition` / `evaluateCondition` (a tiny `status`/`priority` DSL, no
  `eval`), `matchTrigger`, `planActions`, `planAutomation`. Every fired effect gets
  a deterministic `dedupeKey` so re-runs are idempotent. No AI, no Prisma, no React.
- **Idempotent executor.** `src/lib/automation/executor.ts` persists what the engine
  plans: it INSERTs an `AutomationRun` keyed by `(organizationId, ruleId, dedupeKey)`
  before each action — a `P2002` means "already ran" (SKIPPED), a fresh insert runs
  the action + bumps `runsThisMonth`/`lastRunAt` (SUCCESS), a throw flips the run to
  FAILED. `runAutomationsForEvent` (inline) and `runScheduledAutomations`
  (TASK_OVERDUE + PROJECT_HEALTH_CHANGED scan) share the pipeline; one rule can never
  take down the batch.
- **No background runner.** The task PATCH route dispatches automations **after** its
  own transaction commits and **outside** it, wrapped in try/catch, so automation can
  never fail the user's task update. `POST /api/v1/automations/run` exposes the scan
  for a future scheduled poller.
- **Notification service + preferences.** `src/lib/notifications/service.ts`
  centralizes recipient resolution and an application-level dedupe (no second unread
  with the same `(recipient, dedupeKey)`), honoring each member's
  `NotificationPreference` (`inAppEnabled`, `mutedTypes`). New `AutomationRun` /
  `NotificationPreference` models + `Notification.type`/`dedupeKey`, migration
  `20260814090000_automation_engine`.
- **APIs.** `PATCH`/`DELETE /api/v1/automations/:id`, `POST /api/v1/automations/run`,
  `GET /api/v1/notifications` (+`?unread=1`, `unreadCount`), `PATCH
  /api/v1/notifications/:id` (recipient-only), `POST /api/v1/notifications/read-all`,
  and `GET`/`PUT /api/v1/notifications/preferences`.
- **UI.** App-shell header gains a notifications bell (unread badge, dropdown, per-item
  and bulk mark-read) plus permission-filtered Automations / Notifications nav. New
  `/notifications` page (inbox + unread filter + preferences) and `/automations` page
  (rule list, create form, enable/disable, delete, and a manage-only "Run now" showing
  `{evaluated, fired, skipped, failed}`).

## Phase 5 — Analytics & project health dashboards

- Org / project / team / personal dashboards driven by the domain layer.
- Throughput, overdue, blocked, workload, milestone performance.
- Explainable project-health surfaced in the UI (no mystery scores).

### Day 5 progress ✅

- **Analytics domain layer.** New `src/lib/domain/analytics.ts`: pure,
  deterministic, zero-import functions with an injectable `now` for reproducible
  results — `workMetrics`, `statusDistribution`, `priorityDistribution`,
  `throughputByWeek` (8-week trailing window, empty weeks included so charts
  never gap), `cycleTimeStats` (created→completed avg/median/fastest/slowest),
  `agingBuckets`, `teamWorkload` (named, with a transparent Idle/Steady/Busy/
  Overloaded load level derived only from open + overdue counts), and
  `milestonePerformance` / `milestoneSummary`. No AI, no Prisma, no React,
  no randomness.
- **Analytics APIs.** `GET /api/v1/analytics/overview` (tenant-wide) and
  `GET /api/v1/analytics/projects/:id` (project-scoped, 404 if out of tenant).
  Both are `dashboard:read`-guarded; routes only fetch + shape, the domain layer
  computes. Project health reuses `calculateProjectHealth`, sorted most-at-risk
  first with its explanation strings attached.
- **Analytics dashboard.** New `/analytics` page (permission-gated nav entry):
  headline metric cards, a CSS-only weekly throughput bar chart, cycle-time
  stats, status/priority distribution bars, an explainable project-health list
  (every project shows the reasons behind its score — no mystery numbers),
  team-workload rows, milestone performance bars, and open-task aging buckets.
- **No new schema.** Everything is derived from existing `Task` /`Milestone` /
  `OrganizationMember` / `TaskDependency` data (`completedAt` + `createdAt`
  power throughput and cycle time), so there is no migration this phase.

## Phase 6 — Search + command center

- Permission- and tenant-aware global search across projects/tasks/comments.
- ⌘K command center as a primary navigation + action surface.
- Keyboard-first shortcuts, documented.

### Day 6 progress ✅

- **Search domain layer.** New `src/lib/domain/search.ts`: pure, dependency-free
  `parseSearchQuery` (scope prefixes, inline `field:value` filters, accent-folding
  tokenizer), `scoreRecord` with named, auditable point rules and per-field
  weights, `buildSnippet` / `findHighlights` / `splitHighlighted` (ranges, not
  HTML strings — nothing goes near `dangerouslySetInnerHTML`), and
  `rankResults` / `groupResults` with a **total** ordering so two runs over the
  same data are byte-identical. No AI, no Prisma, no React.
- **Search rewritten for correctness and scale.** The old handler loaded up to
  250 rows of every type into memory and ranked them in JS, so anything past the
  cap was invisible. Now Postgres narrows candidates (`ILIKE` via `mode:
  "insensitive"`) and the domain layer ranks what comes back. Coverage grew from
  5 types to 8 (adds milestones, saved views, automations), and hitting the
  candidate cap sets `truncated: true` instead of quietly lying.
- **Per-entity permissions — the real fix.** Search was gated on a single
  `dashboard:read`, which meant a MEMBER could surface audit-log contents by
  typing them. Each type now declares its own permission (`ENTITY_PERMISSION`),
  and a role without it never triggers the query: not fetched, not scored, not
  counted in totals. Saved views additionally filter to owner-or-shared.
- **Command palette, rebuilt keyboard-first.** Arrow/`Ctrl+P`/`Ctrl+N`/`Home`/
  `End` navigation over a flat row list derived from the rendered sections (so
  the highlighted row and the opened row cannot diverge), `Enter` to open,
  `Enter` on nothing to fall through to `/search`, `Esc` restoring focus to where
  it was, `role="combobox"`/`listbox`/`option` with `aria-activedescendant`,
  180ms debounce with `AbortController`, grouped results with match highlighting,
  and scope prefixes (`>` `#` `/` `@` `~` `!`).
- **Real commands, not just links.** `src/lib/ui/commands.ts` holds a typed,
  permission-filtered registry — navigation plus named client actions (`signOut`,
  `copyLink`) resolved through a `switch`, so the palette can never execute an
  arbitrary string. Icons are declared as a string union mapped in the component,
  keeping the registry React-free.
- **Global shortcuts.** `Ctrl/⌘+K` and `/` open the palette, `?` opens the new
  `/shortcuts` reference, and `g` + a key jumps between sections
  (`useGotoShortcuts`, 1.2s prefix expiry). Every handler ignores keystrokes
  aimed at an input, textarea, select or contenteditable, so typing is never
  hijacked.
- **New pages.** `/search` (full result set, per-type filters, visible relevance
  score and match reasons) and `/shortcuts` (generated from `GOTO_SHORTCUTS`, so
  the docs cannot drift from the handler). Both added to the nav.
- **No new schema.** Search reads existing tables; there is no migration this
  phase. Full-text indexes (`pg_trgm` / `tsvector`) are the natural Phase 7
  follow-up once `ILIKE` stops being fast enough.

## Phase 7 — Platform hardening

- Background jobs (queue + worker) for automations, notifications, digests, exports.
- Rate limiting on auth and sensitive mutations.
- Session revocation / device management.
- Structured logging, request IDs, error tracking.

### Day 7 progress ✅ — authentication hardening

Day 7 originally bundled a design-system pass, dark/light tokens, accessibility
and auth hardening. Auth was taken on its own and taken properly, on the
reasoning that it is the only item on that list that cannot be safely retrofitted
once real users exist: a design token can be changed on any Tuesday, but a
password stored under a weak policy stays weak, and sessions minted without a
revocation mechanism can never be revoked. The visual and a11y work moves to
Phase 8 intact.

- **Auth policy domain layer.** New `src/lib/domain/auth-policy.ts`: pure,
  dependency-free password assessment returning a 0–4 score *plus the reasons*,
  exponential lockout backoff over a rolling window, and session-epoch
  comparison. Every threshold is a named exported constant so the policy can be
  reviewed without reading the algorithm, and `now` is always injected so lockout
  maths is testable at any point on the timeline. **83 behavioural assertions**,
  including determinism over 200 runs.
- **Password policy, NIST-aligned.** 10–72 characters (72 because bcrypt
  truncates beyond that, so accepting more would let two different passwords hash
  identically), minimum score 2, and hard rejection of common passwords
  *after* stripping trailing years and punctuation (`Password2024!` is caught by
  `password`), repeats, keyboard walks in both directions, edge whitespace, and
  anything containing the user's own name or email. Character variety *scores*
  rather than gating, so users are not pushed toward `Password1!`.
- **One policy, two surfaces.** The register and change-password endpoints and
  the live UI strength meter all call the same pure function, so the meter can
  never approve something the server then rejects. Sign-in deliberately does not
  apply the policy — doing so would confirm no account could hold a given
  password, and would lock out anyone who registered under a looser rule.
- **Brute-force lockout that actually works on serverless.** 5 failures in a
  15-minute rolling window lock the account; backoff doubles per failure
  (60s → 120s → 240s …) capped at 1 hour so nothing is ever bricked. State lives
  on the `users` row, **not** in process memory — an in-memory counter resets on
  every cold start and protects nothing. Locked requests answer `423` with a
  `Retry-After` header, and the UI shows a live countdown instead of a dead end.
- **Account enumeration closed.** Unknown-email and wrong-password now return the
  identical `401` *and* cost the same: when no user matches, bcrypt still runs
  once against a decoy hash derived at process start. Without it the unknown case
  returned in ~1 ms versus ~250 ms for a real cost-12 comparison — a reliable
  timing oracle for harvesting valid addresses.
- **Session revocation without a session table.** Tokens carry the
  `sessionEpoch` they were minted under; the auth context refuses any token
  behind the user's current epoch. A password change bumps the epoch and
  re-issues a cookie for the current device, so every *other* device signs out —
  which is what users mean by "change my password". `logout?everywhere=1` bumps
  without re-issuing. Legacy tokens have no epoch claim and are read as epoch 0,
  so shipping this signed nobody out.
- **Re-authentication for password change.** The current password is required
  even though the caller holds a valid session: a stolen cookie must not be
  enough to take permanent ownership of an account.
- **Sign-in audit trail.** New `login_attempts` table records every outcome
  (`SUCCESS` / `INVALID_PASSWORD` / `UNKNOWN_EMAIL` / `LOCKED`), so a
  credential-stuffing sweep is visible after the fact. Client IPs are stored as a
  **salted hash, never in the clear**; rotating `SESSION_SECRET` makes old hashes
  uncorrelatable, which is the right direction of failure. Log writes can never
  block a sign-in or turn a 401 into a 500.
- **Security headers.** New `src/middleware.ts` + pure
  `src/lib/security/headers.ts`: `'self'`-only CSP with no wildcards and no remote
  hosts, `object-src`/`frame-src`/`frame-ancestors` `'none'`, `form-action 'self'`
  (an injected form cannot exfiltrate credentials), `connect-src 'self'`, HSTS
  and `upgrade-insecure-requests` in production, `'unsafe-eval'` in development
  only, plus `X-Frame-Options`, `nosniff`, `Referrer-Policy`, a
  `Permissions-Policy` denying camera/mic/geolocation/payment/USB, and both
  `Cross-Origin-*` policies. **41 behavioural assertions**, because a typo in a
  CSP directive name is not a syntax error — it is a directive the browser
  silently ignores. `script-src 'unsafe-inline'` remains a *documented* gap
  (Next's inline bootstrap needs it until nonce-tagged) and is pinned by a test
  so tightening it is deliberate.
- **The middleware does no auth, on purpose.** Edge runtime has no Prisma, so it
  could only check that a cookie parses — not that the session is valid, the user
  exists, or the epoch is current. A check that weak is worse than none: it looks
  like authorization while guaranteeing nothing.
- **Demo credentials removed.** The auth form shipped pre-filled with a name,
  email and `Password123`. Fields now start empty with real placeholders and
  correct `autoComplete` values.
- **Migration.** `20260815090000_auth_hardening` adds six columns to `users`, the
  `login_outcome` enum and the `login_attempts` table with three indexes plus a
  partial index on locked accounts. Fully idempotent (`IF NOT EXISTS` /
  `EXCEPTION WHEN duplicate_object`) and chosen so existing rows need no
  backfill.
- **Four gaps closed** from the `docs/SECURITY.md` table: login rate limiting,
  session revocation, auth audit trail, and security headers. Password reset and
  CSRF tokens are now the top two remaining items.

## Stage 2 — Intelligence layer ✅ (first two features)

Full detail in `docs/INTELLIGENCE.md`.

**Deliberate architectural decision: no model in the loop.** The two features
requested — health scoring from velocity/overdue/slippage, and bottleneck
detection over the dependency graph — are weighted-signal analysis and graph
theory, not language work. The stated requirements (explainable not black-box,
tenant-isolated, no auto-modification) all argue *against* an LLM computing these
numbers: it would make the score non-reproducible and unauditable, and would
egress tenant task data to a third party. If narrative phrasing is wanted later,
the right shape is a model that renders the already-computed factors and is never
allowed to produce the number.

- **Project Health Intelligence.** `src/lib/domain/project-intelligence.ts`: six
  signals (overdue, blocked, slippage, velocity, milestone risk, deadline) with
  weights summing to 100, so the score reads as health retained and each signal's
  ceiling is visible. Output carries ranked `factors[]` (only what costs points,
  worst first), `healthy[]` (what was checked and passed), raw `evidence` numbers
  per signal, a prose `summary` composed from the same factors the UI renders, and
  read-only `recommendations`.
- **Fixed two real defects in the old scorer, which is now deleted.** It did
  `score -= overdueTasks * 8` with no normalization, so 13 overdue tasks scored 0
  whether the project held 15 tasks or 500 — a 200-task project with 13 late items
  was reported Critical. And its `reasons[]` always contained four entries
  including non-reasons like "No overdue open tasks". Both have pinned regression
  tests.
- **Velocity distinguishes three zero states**, which was the subtlest part:
  `unknown` (too young — costs nothing, so new projects are not punished for
  having no history), `noDeliveries` (nothing ever completed — half weight,
  because the data cannot tell "not delivering" from "not updating statuses"), and
  `stalled` (real throughput before, zero now — full weight).
- **Confidence.** A 2-task project no longer reports a score as confidently as a
  500-task one; caveats render by default rather than behind a tooltip.
- **Dependency Risk & Bottleneck Detection.** `src/lib/domain/dependency-risk.ts`:
  `BLOCKS` and `DEPENDS_ON` normalize to one edge direction, `RELATED_TO` is
  excluded (treating it as a blocker would invent constraints the user never
  expressed), duplicates and self-edges dropped. Detects ranked bottlenecks by
  transitive impact, cycles (returning the actual loop path), the critical chain,
  and fan-out hubs. All traversals are iterative — a recursive walk over a
  5,000-edge graph is a stack overflow waiting to happen; a test builds a
  10,000-deep chain.
- **Slippage required new data capture.** Due-date history did not exist:
  `task.updated` logged which field *names* changed but never the old value, so a
  moved date was lost on overwrite. The task PATCH route now records
  `fromDueDate`/`toDueDate`. **Slippage therefore reads zero for every project
  until dates start moving, and pre-release history is unrecoverable** — the
  engine, the API and a standing UI banner all say so explicitly rather than
  showing a bare "0 days slipped" that would read as a stable schedule.
- **Caught a role-dependency bug while wiring it.** Work OS already fetched
  `activity_logs` behind `audit:read`; reusing that fetch would have made health
  scores differ by viewer role — the same project scoring differently for an Admin
  and a Manager. Slippage now uses a dedicated ungated query reading only
  before/after due dates of tasks the caller can already see.
- **Read-only, provably.** Both engines are pure (asserted by a purity test that
  snapshots inputs), both routes issue only SELECTs, both responses carry
  `readOnly: true`, and a test asserts no recommendation ever claims the system
  acted.
- **New surfaces.** `GET /api/v1/intelligence/overview` (portfolio),
  `GET /api/v1/intelligence/projects/:projectId` (one project, full risk report),
  and an `/intelligence` page that never shows a score without its factor
  breakdown. Nav item plus `g i` shortcut.
- **138 new behavioural assertions** (262 total via `npm run test:domain`).

Not built on purpose: auto-remediation of any kind, predicted completion dates
(forecasting from 4 weeks of throughput would look confident with no basis), and
cross-project critical path (dependencies are project-scoped in the schema).

## Stage 2 (cont.) — Cross-project dependencies + health automations ✅

- **`TaskDependency` lost its `projectId`.** An edge now belongs to the tenant, so
  a platform task can gate a launch in another project — previously inexpressible,
  which made that whole class of risk invisible. Migration drops the FK, index and
  column; no backfill needed because every existing edge already had both
  endpoints in one project, so the column was a redundant copy of
  `tasks.project_id`.
- **Tenant isolation unchanged.** `organization_id` is still on the row and still
  half of *both* task foreign keys, so the database forces both endpoints into one
  organization. Cross-project is legal; cross-tenant remains structurally
  impossible.
- **The two-sided query rule.** "This project's dependencies" is no longer a column
  filter — an edge counts if *either* endpoint is inside. Getting this wrong is
  silent (you get a plausible list missing every inbound constraint), so the rule
  lives once in `src/lib/dependencies/scope.ts` and all six consumers use it.
- **Risk analysis is now tenant-wide, presentation per project.** Per-project
  analysis cannot see a chain that leaves a project and returns (reads as two short
  chains) or a cycle spanning three projects (no single subgraph contains a loop —
  all three checks report "none"). There is a test building exactly that, plus a
  control asserting per-project analysis misses it. Cross-project findings rank
  above equivalent intra-project ones.
- **Fixed the route's cycle check.** It was recursive without memoisation
  (exponential on a diamond) and treated `RELATED_TO` as blocking, so relating two
  tasks could be rejected as circular. Replaced by the tested engine, run
  tenant-wide.
- **`PROJECT_HEALTH_CHANGED` never actually detected change.** The executor compared
  against a hardcoded `"Healthy"`, so it fired every run for anything not currently
  Healthy and *never* fired for a project degrading from Healthy. Now
  `projects.last_health_band` stores the previous observation; `NULL` seeds a
  baseline silently so enabling a rule cannot alert on unseen history.
- **Also caught:** the per-project intelligence endpoint fed the risk engine only
  its own tasks, so cross-project edges pointed at unknown ids and bottleneck
  counts were quietly too low. It now loads the external endpoints — while health
  still gets project-only tasks, since its signals are ratios over the project's
  own population.
- **New surfaces.** `/intelligence/[projectId]` with full signal arithmetic
  (`100 − N = score` shown, not asserted), bottleneck reasons, cycle paths, critical
  chain, inbound/outbound cross-project links, and a per-task slippage
  retrospective. Cross-project badges on Work OS and the projects page,
  distinguishing "blocking" from "blocked by".
- **219 assertions** in the intelligence suite (343 total).

## Phase 8 — UI/design-system pass

- Semantic color tokens, dark/light, elevation, motion.
- Accessibility: focus management, keyboard nav, screen-reader labels, reduced
  motion, contrast.
- Responsive patterns (not just shrunk desktop).

## Phase 9+ — Integrations, billing, import/export

- Integration framework (OAuth, encrypted tokens, webhooks with signatures/retries).
- Entitlements/plan layer (centralized, not scattered `if plan === …`).
- CSV/structured import & export (permission-respecting).

## Deferred to Stage 2 (explicitly out of scope now)

All AI features. The foundation's clean APIs, events, and audit logs are the
integration surface a future AI layer will consume.

## Throughput note

Realistic pace is roughly **one phase per focused session** (occasionally two if
small and related). The full vision is multi-week work; this roadmap is the map.
