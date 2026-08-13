# Stage 2 — Project Health Intelligence & Dependency Risk

Two features, both deterministic, both read-only, both tenant-scoped by the same
guard as the rest of the API.

## Why no model computes the score

The requirement was "human-readable explanations, not black-box scores". A
language model moves against that requirement on every axis that matters:

| Requirement | Deterministic engine | LLM |
| --- | --- | --- |
| Explanations trace to the number | Every point belongs to one named signal; the score *is* 100 minus their sum | Prose is generated separately from any arithmetic |
| Reproducible | Same input → identical output, asserted over 100 runs | Varies per call |
| Auditable by a reviewer | Read the weights, recompute by hand | Not possible |
| Cost / latency | Zero | Per-request |

So the scoring is real analysis — weighted signals, graph traversal, trend
comparison — with no model dependency. Every number on the `/intelligence` pages
is computed here and is reproducible by hand.

## The narrative brief (Stage 2)

The shape this document originally named as the *only* acceptable use of a model
is now built: an LLM that **phrases the already-computed factors and is never
allowed to produce a number**.

`GET /api/v1/intelligence/projects/:projectId/narrative` streams a three-paragraph
executive brief. It is strictly additive — the per-project page renders
identically without it, and when `ANTHROPIC_API_KEY` is unset the endpoint returns
`501` and the UI omits the section rather than showing an error.

### What actually egresses, and the trade that was made

The earlier version of this table claimed "nothing leaves the process". That is no
longer true for this one endpoint, and the change is deliberate rather than
incidental:

**Sent to Anthropic:** the project name, the health score and band, the ranked
factors (label, points deducted, numeric evidence), bottleneck and cycle *counts*,
critical chain *length*, velocity direction, confidence level — and **at most two
task titles**: the top bottleneck and the worst-slipping task.

**Not sent:** task descriptions, comments, assignees, user names, email addresses,
ids, dates, or any task row beyond those two titles.

Two titles are the entire concession. A brief that says "your top bottleneck"
without naming it is not actionable, which is the point of the feature. If a
tenant cannot accept even that, the fix is to drop the two title fields from the
context object in the narrative route — `NARRATIVE_HEALTH_SYSTEM` already handles
their absence — and not to loosen anything else.

**CSP is unchanged.** `connect-src 'self'` still holds: the browser streams from
our own API, and the server talks to Anthropic. Nothing in the client ever
addresses a model provider.

### Why the model cannot corrupt a number

- The prompt forbids inventing figures and requires factors to be referenced by
  the exact names supplied.
- The context object contains only already-computed values, assembled field by
  field rather than by spreading a domain object — so a future field added to
  `ProjectIntelligence` cannot start leaking by accident.
- Nothing generated is persisted. The brief is regenerated per request and is
  never read back as a source of truth.
- `src/lib/domain/**` does not import `src/lib/ai/**`, and must not.

### Failure behaviour

The first chunk is pulled before the streaming response is constructed, so an
immediate provider failure (missing key, 401, rate limit) still returns a proper
status code instead of a `200` with an empty body. A mid-stream failure closes the
stream cleanly and the reader keeps the partial text — it cannot do better, since
the status line is already on the wire. Every client-side failure path collapses to
the same outcome: the section is not rendered.

## 1. Project Health Intelligence

`src/lib/domain/project-intelligence.ts` — pure, no imports.

### Score composition

Six signals, weights summing to 100, so "score" reads as percentage of health
retained and each signal's ceiling is visible:

| Signal | Max points | Normalized against | Notes |
| --- | --- | --- | --- |
| Overdue work | 26 | open tasks | Not total tasks: a project that shipped 400 items late but has 2 open ones on schedule is healthy *now* |
| Blocked work | 22 | open tasks | |
| Schedule slippage | 18 | days pushed per open task | Pushes on blocking tasks weighted double — that is the "dependency slippage" |
| Delivery velocity | 14 | trailing 4 weeks vs prior 4 | |
| Milestone risk | 12 | milestones defined | |
| Project deadline | 8 | binary | End date passed with work still open |

`score = 100 − Σ points`, clamped to 0–100. Bands: Healthy ≥ 82, Watch ≥ 66,
At risk ≥ 45, Critical below that.

### Two defects fixed from the previous scorer

1. **No normalization.** The old formula was `score -= overdueTasks * 8`, so 13
   overdue tasks scored 0 whether the project held 15 tasks or 500 — a 200-task
   project with 13 late items was reported **Critical**. There is a regression
   test pinning this exact scenario.
2. **Fake reasons.** The old `reasons[]` always had four entries including
   non-reasons like "No overdue open tasks", so it could not answer "why is this
   low". Now `factors[]` contains only signals that cost points, ordered by cost,
   and `healthy[]` separately lists what was checked and passed.

### Velocity has three distinct zero states

Conflating these was the subtlest thing to get right:

- `unknown` — project younger than the comparison window. **Costs 0 points.**
  Penalising a new project for having no history would make every new project
  look unhealthy on day one.
- `noDeliveries` — nothing ever completed, project old enough to expect some.
  **Costs half weight (7).** The data cannot distinguish "not delivering" from
  "delivering but not updating task status", so this flags a concern without
  asserting a confirmed stall.
- `stalled` — real throughput before, zero now. **Costs full weight (14).**

### Confidence

A 2-task project no longer reports a score as confidently as a 500-task one.
`confidence` is `high | medium | low | insufficient` with plain-language caveats
that the UI renders by default, not behind a tooltip.

## 2. Dependency Risk & Bottleneck Detection

`src/lib/domain/dependency-risk.ts` — pure, no imports.

### Graph normalization

`BLOCKS` and `DEPENDS_ON` describe the same relationship from opposite ends, so
both normalize to a single `blocker → blocked` direction. `RELATED_TO` is
excluded entirely — treating it as a blocker would invent constraints the user
never expressed. Self-edges and duplicate pairs are dropped, because the same
pair arriving as both `BLOCKS` and `DEPENDS_ON` would otherwise double a
bottleneck's apparent fan-out.

Adjacency lists are sorted, so output is byte-identical regardless of the order
rows come back from SQL.

### What it detects

- **Bottlenecks** — open tasks blocking other open work, ranked by an
  `impactScore` built from named weights (`IMPACT_WEIGHTS`) over: open tasks
  transitively blocked, how many are high/urgent, how many are already overdue,
  whether the blocker itself is overdue or `BLOCKED`, and whether it is
  actionable today. Tasks blocking nothing open are omitted entirely, so the
  output is a worklist rather than a table of every task.
- **Cycles** — iterative DFS with colour marking, returning the actual path so
  the UI can name the loop. A cycle is a correctness problem, not a scheduling
  one: no amount of effort completes it.
- **Critical chain** — longest path through the blocking graph. However many
  people are available, work in a chain of length N cannot compress below N
  sequential handoffs.
- **Hubs** — direct fan-out ≥ 4. Called out separately because the fix is
  usually "split this task", not "work harder on it".

### Traversals are iterative, not recursive

Every walk uses an explicit stack or queue. A recursive walk over a customer's
5,000-edge graph is a stack overflow waiting to happen; there is a test that
builds a 10,000-deep chain and asserts it completes. Cycles must also be
survivable rather than fatal, which recursion makes awkward.

## 3. Cross-project dependencies

`TaskDependency` no longer has a `projectId`. An edge belongs to the **tenant**,
so a platform task can gate a product launch in another project — previously
inexpressible, which meant that entire class of risk was invisible.

### The query trap this creates

"This project's dependencies" stopped being a column filter. An edge is relevant
to a project when **either** endpoint is inside it:

```ts
{ OR: [{ sourceTask: { projectId } }, { targetTask: { projectId } }] }
```

Filtering on one side returns a plausible-looking list that silently omits every
*inbound* constraint — the exact blindness this feature removes. Because that
failure is invisible rather than loud, the `where` fragment and the predicate
live once in `src/lib/dependencies/scope.ts` and every caller uses them. There is
a test asserting an inbound edge survives the filter.

### Why the risk graph is tenant-wide, not per project

Analysis is global; only presentation is per project. Per-project analysis — even
including one hop over the boundary — cannot see:

- **A chain that leaves a project and returns.** It reads as two short, low-risk
  chains while the real critical path is long.
- **A cycle spanning three projects.** No single project's subgraph contains a
  loop, so *all three* per-project checks report "no cycles". There is a test that
  builds exactly this and asserts the control case (per-project analysis of one
  leg) finds nothing.

`analyzePortfolioDependencyRisk` builds one graph over the tenant, then attributes
each finding to whichever projects it touches — so a cross-project cycle appears
on every board involved, and on no others.

Cross-project findings are ranked *above* equivalent intra-project ones. A loop
inside one project is a planning error one owner can fix; a loop across projects
means two teams are each waiting on the other and neither can see it from their
own board.

### Tenant isolation is unaffected

`organizationId` remains on the row and remains half of **both** task foreign
keys, so the database itself forces both endpoints into the same organization.
Cross-*project* is now legal; cross-*tenant* is still structurally impossible.

The POST route additionally requires at least one endpoint to be in the project
being posted to — otherwise this endpoint could create an edge between two tasks
in two *other* projects, making the audit trail misleading about where the change
originated.

### A bug fixed along the way

The route's own `wouldCreateCycle` was recursive with no memoisation
(exponential on a diamond — the replacement resolves a 24-layer diamond in
milliseconds, with a test asserting it) and treated `RELATED_TO` as a blocking
edge, so merely marking two tasks as related could be rejected as circular. It is
replaced by `wouldCreateCycle` in the tested engine, which normalizes
`DEPENDS_ON`, ignores `RELATED_TO`, and runs tenant-wide because a chain can now
leave a project and come back.

## 4. Health-change automations

`PROJECT_HEALTH_CHANGED` did not detect change. The executor compared each
project's freshly computed band against a hardcoded `"Healthy"` constant, so it:

- fired on **every run** for every project that was not currently Healthy, and
- **never fired** for a project that degraded *from* Healthy — the one transition
  anyone would want to be told about.

`projects.last_health_band` now stores the previous observation. Three cases:

| Previous | Result |
| --- | --- |
| `NULL` (never evaluated) | Seed the baseline, stay silent |
| Same as current | No event — the trigger is `..._CHANGED` |
| Different | Fire |

`NULL` is deliberately distinct from `"Healthy"`: enabling a rule must not
retroactively alert on history the system never saw, which would arrive as a
flood of false alarms about situations that are not new. The band is recorded
*before* rule dispatch, so a failed notification does not cause the same alert to
re-fire on the next run.

Automation health deliberately omits slippage: automations run on every task
mutation, and loading the activity log each time would turn a cheap trigger
evaluation into a table scan. Slippage can move a score by at most 18 points, so
band-keyed rules are unaffected in practice.

### AI phrasing of the notification (Stage 2)

`NOTIFY_MANAGER` on a health transition previously sent a fixed string:
`"Apollo" health is now At risk (was Healthy).` — true, but it does not say what
changed or how bad it is. The executor now asks Haiku
(`SMART_NOTIFY_SYSTEM`, one sentence, ≤120 chars) to phrase the same transition
using the computed score, top factor and open/overdue counts.

**Where the call happens, and why it is exactly there.** Between the
`AutomationRun` insert and the `$transaction` that performs the action:

- *After* the run row is written SUCCESS, so a deduped or already-executed action
  never triggers a paid model call.
- *Outside* the transaction, because an external round-trip inside a database
  transaction holds a pooled connection for the length of an API call. Under load
  that starves writes unrelated to automations.
- Behind a memoised thunk, so several rules subscribing to one transition make
  one call and send one consistent wording — and a narrator built for an action
  that never dispatches costs nothing.

**The fallback contract.** An AI failure is never an automation failure. Missing
key, 401, rate limit, timeout, empty output, or output longer than 240 characters
all resolve to the deterministic body from `planAutomation`, unchanged. Over-long
output is rejected rather than truncated — a sentence cut mid-word reads as a bug,
and the fallback is a complete correct sentence.

This matters more than it first appears: the `AutomationRun` row is retained for
idempotency, so a run marked FAILED is **never retried**. If a model error were
allowed to propagate, a transient Anthropic outage would permanently swallow a
health-change alert. A plainly-worded notification is strictly better than none.

**Model output is validated before it is persisted.** Whitespace is collapsed to a
single line and length is bounded, per the untrusted-output rule in `AGENTS.md`.
The band, score and factors themselves remain fully deterministic — the model only
rewords them.

## Read-only guarantees

Neither engine mutates its inputs (asserted by a purity test that snapshots the
arguments). Both API routes issue only `SELECT`s. Recommendations are phrased as
suggestions to a person — there is a test asserting no recommendation ever claims
the system acted ("automatically", "has been reassigned", etc.).

Both responses include `readOnly: true` so a consumer never has to guess.

## Tenant isolation

Unchanged from the rest of the API, and the domain layers strengthen it:

- `withTenantGuard(Permission.DashboardRead)` resolves the organization from the
  session, never from the request.
- `requireProjectForTenant` 404s for another tenant's project, so a guessed id is
  indistinguishable from a nonexistent one.
- Every query filters on `organizationId`.
- **The pure engines never receive an organization id.** They cannot leak across
  tenants by construction rather than by discipline.

### One subtlety worth recording

Slippage is read from `activity_logs`, and the Work OS route already fetched that
table *gated behind `audit:read`*. Reusing that fetch would have made health
scores depend on the viewer's role — the same project scoring differently for an
Admin and a Manager. Slippage therefore uses a dedicated, ungated query that
reads only before/after due dates of tasks the caller can already see, which
reveals nothing new.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/v1/intelligence/overview` | Portfolio roll-up: every project's health analysis, band counts, attention order, plus the tenant-wide `dependencyRisk` (cross-project cycles, boundary-crossing edges, global critical chain) and per-project attribution |
| `GET /api/v1/intelligence/projects/:projectId` | One project: full health analysis, dependency risk, inbound/outbound cross-project links, and the per-task slippage retrospective |
| `GET /api/v1/intelligence/projects/:projectId/narrative` | The same snapshot, phrased by a model as a streamed three-paragraph brief. `text/plain`, chunked. `501` when AI is not configured |

The two per-project endpoints share one loader,
`src/lib/intelligence/project-snapshot.ts`. The queries are subtle enough — the
two-sided dependency scope, and the fact that health and risk are fed different
task sets — that a second hand-written copy would drift silently, producing a
believable smaller number rather than an error.

Both require `dashboard:read`. Activity-log reads are capped (2,000 per project,
5,000 org-wide) and the response reports `scheduleHistory.truncated` rather than
silently analysing a partial window.

### One subtlety in the per-project endpoint

Health and risk are fed **different** task sets, on purpose:

- **Health** gets only this project's tasks. Its signals are ratios over the
  project's own population, so folding in outside tasks would corrupt every
  denominator.
- **Risk** additionally gets the external endpoints of cross-project edges. Without
  them the engine sees edges pointing at ids it has no task row for, cannot tell
  whether that work is open, and under-counts what a bottleneck blocks. That
  failure would surface as a plausible smaller number rather than an error, which
  is why it is called out here.

## Slippage retrospective

Aggregate slippage cannot answer "which commitments keep moving?". One task
re-dated six times and six tasks moved once produce identical totals and call for
completely different conversations. `slippageByTask` returns per-task rows —
pushes, days lost, worst single slip, original vs current date, and whether the
task blocks other work — ordered worst-first. Blockers are badged, because their
slips propagate downstream.

## The slippage ramp-up — read this before trusting the number

Due-date history **did not exist** before this release. `task.updated` was logged,
but its metadata recorded only which field names changed, never the old value —
so the fact that a date moved was lost the moment it was overwritten.

The task PATCH route now records `fromDueDate`/`toDueDate` whenever the date
actually moves. Consequences:

- Slippage reads **zero for every project** immediately after deploy.
- It becomes meaningful after a few weeks of real use.
- History before this release is **permanently unrecoverable**.

Both the engine and the UI say this explicitly. The signal's `detail` reads
"treat it as unknown rather than good", it appears as a confidence caveat, and
the `/intelligence` page shows a standing banner while every project still lacks
history. Showing a bare "0 days slipped" would read as a stable schedule rather
than an absent measurement, which is the kind of quiet dishonesty that makes
people stop trusting a dashboard.

## Tests

`npm run test:domain` — 343 assertions across three suites (219 for this work),
covering: size normalization and the pinned regression for the old scorer's bug;
cycle paths; 10k-deep chains; the three velocity zero states; slippage weighting
and the per-task retrospective; confidence; malformed activity metadata;
two-sided dependency scoping (including that an inbound edge survives the
filter); cross-project cycles with a control case proving per-project analysis
misses them; boundary-crossing chains; per-project attribution; health-band
transition rules; determinism over 100 runs; order-independence; and input purity.

## Deliberately not built

- **Auto-remediation.** No auto re-dating, auto-reassignment or auto-status
  changes. The product rule is analysis and recommendations only.
- **Predicted completion dates.** Forecasting from 4 weeks of throughput on
  projects this small would produce confident-looking numbers with no basis.
  Velocity direction is reported; a date is not.
- **Cross-tenant anything.** Both endpoints of an edge are forced into one
  organization by the database. This is not a limitation to remove later.
- **Cascading re-dates.** When a blocker slips, the system does not push its
  downstream tasks. It reports the propagation and leaves the decision to a person
  — consistent with the analysis-only rule.
