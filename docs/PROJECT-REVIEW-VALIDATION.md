# Project review validation — 2026-10-27

Continued from `2244d59ddd221dc9d7142037f6c2cf6917677dfd` on
`handoff/chatgpt-2026-10-26`. Initial local/remote SHAs matched and the worktree
was clean. All writes targeted the newly created **disposable loopback database**
`projectos_full_review_20261027`. No shared/production DB was accessed.

## Implemented inventory and scope

| Surface | Data / operations inspected | Verification |
| --- | --- | --- |
| Dashboard | dashboard/summary, projects, dashboard/my-tasks; notification bell | Real counts, completion refresh, named-project navigation, error/retry, desktop/mobile |
| Projects | project/task CRUD, milestones, dependencies, saved views, roster | Real project/task writes, project selection, view persistence, AI draft handoff |
| Task detail | task, comments, activity, assignment/subtasks/dependency components | Task status, comment persistence, audit activity; role/tenant guards |
| Work OS / Analytics / Progress | work-os/overview, analytics/overview, progress | Actual data pages and navigation; domain tests cover derived metrics |
| Intelligence | overview, project snapshot, simulate/apply, narrative, forecast | Real model output and deterministic safety; see feature evidence below |
| Automations | rule list/create/update/run, policy interpretation | Manual and live AI drafting, disabled save and explicit activation |
| Search / Shortcuts / navigation | command/search, command palette, keyboard routes | Query handoff, empty results, browser page navigation, mobile navigation |
| Members / Notifications | roster/membership APIs, notification list/preferences/read | Role restrictions, notification recipient scoping and read persistence |
| Authentication / onboarding | register/login/current tenant/session | Browser sign-in; API separate-tenant registration; 401/403/404 isolation checks |

The implemented AI inventory has seven features below. `TASK_EXTRACT_SYSTEM` is
an unused prompt export, not an additional implemented extraction workflow.
No new provider or unrelated product feature was added. This is verification of
primary journeys and targeted regressions, not an exhaustive accessibility audit
or a guarantee of model semantic accuracy.

## Reproduced defects and fixes

- Dashboard cards linked to the generic board, selecting the wrong project.
  Cards now carry projectId; board selection honors it without requiring a task
  creation query. Browser checks verify navigation and refresh.
- Dashboard failures had no retry and displayed misleading zero counts. Keyed
  request state now supports retry and hides absent metrics. Active-project and
  active-member metrics use the corresponding database filters.
- The command palette's fixed overlay was trapped in the blurred header stacking
  context. Playwright reproduced dashboard cards intercepting Parse clicks. The
  palette now renders through a document-body portal; real AI composition works.
- AI “Edit first” dropped description, priority and due date. A validated,
  project-scoped, tab-local draft preserves these fields without putting private
  descriptions in URLs. The editable task form and real create write preserve
  them. Direct AI creation navigates to the created task.
- Simulation UI labelled deterministic fallback text “AI narration”. It now reads
  server provenance and labels fallbacks explicitly; unknown provenance is not
  presented as AI success.
- Failed narrative/forecast requests silently disappeared. They now show an
  unavailable message with Refresh guidance. Retrospectives offer an explicit
  retry button. Partial streams remain failures, not completed prose.
- Mobile sidebar navigation disappeared. A compact, permission-filtered mobile
  navigation strip now exposes the same destinations. The bell dropdown was
  reproduced 153px off-screen at 390px width; it now uses a viewport-clamped
  portal, stays clickable, and refreshes notifications on opening.
- The full domain run found the notification narrator test double missing the
  newly required STOP metadata. The double was corrected; production completion
  checks were not weakened.
- Malformed simulation JSON could expose a generated-text excerpt in a parser
  exception log. That path now logs only its category; policy parse errors also
  omit raw model output. A regression checks the private sentinel is absent.

## Fresh automated and database checks

| Check | Result |
| --- | --- |
| Prisma client generation / schema validation | PASS; existing composite SetNull warning retained |
| Migrations and seed | PASS; nine migrations on the new disposable DB, status up to date |
| Domain tests | PASS — 436 assertions |
| Mocked AI routes | PASS — 270 assertions |
| AI client | PASS — 31 assertions |
| UI regressions | PASS — 26 checks |
| Lint / typecheck / production build | PASS |
| Browser suite | PASS — 16 passed, 3 live-AI tests intentionally skipped in the quota-free run; separate live browser evidence below |

Initial baseline browser suite: 7 passed, 3 live-AI skips. New dashboard tests
reproduced wrong links and missing retry before fixes. Two diagnostic test
selectors were corrected (wait for the palette button, and Sign in is a tab),
without weakening application assertions. The stale/replay test now creates
its own task instead of assuming the newest project has tasks. The overlay click interception was a
real application defect, not bypassed with forced clicks.

Browser tests cover actual page hydration across dashboard, projects, task view,
progress, shortcuts, automations, analytics, intelligence, Work OS, notifications
and members. They cover task creation/completion, comments/audit, notification
read state, project selection, view preferences, errors/retry and 390/1440 px
layout. Model responses are explicitly mocked only in the quota-free AI draft
handoff and stream-error UI tests. Those are not live-Gemini evidence.

## Live model and workflow evidence

Both runtime model IDs: **gemini-3.6-flash**. Both generation budgets: **4096**
tokens (including thinking); timeout **60000 ms**; attempts **1**;
`NODE_USE_ENV_PROXY=1`. The secure key was never printed. Defaults and provider
architecture remain unchanged; these are explicit environment overrides.

After the previously reported daily quota reset, targeted browser checks used
real Gemini and the real database, with paced requests and automatic retries
disabled. Metadata contains **9 HTTP200 / STOP completions and 1 HTTP503**.
The 503 occurred on an initial retrospective attempt; a later paced attempt
succeeded. No 429 was observed in this review run. No provider switch or quota
bypass was used.

| Feature | Result | Actual evidence |
| --- | --- | --- |
| Task parsing / composition | PASS | Real structured JSON → preview in palette → actual Create → persisted task and detail page; priority/date preserved. Separate mocked-model browser check verifies Edit first preserves all fields |
| Policy Studio | PASS | Real interpreted draft/conflict array → UI save disabled → explicit UI activation |
| What-If Simulation | PASS | Both provenance fields gemini; STOP interpretation/narration consumed by UI; preview task fingerprint unchanged; UI Apply persisted DONE; replay409. Separate real stale-token check returned409 with no audit write |
| Project health narrative | PASS | Complete 1,001-character prose displayed with busy=false; Gemini STOP. Deterministic metrics remain separate and authoritative |
| Milestone retrospective | PASS | Closed disposable milestone, complete 677-character output displayed with busy=false; STOP |
| Forecast | PASS | 45-day-old synthetic project fixture, at least five open tasks and completed history; complete 204-character text/plain forecast displayed; STOP. Insufficient-history branch covered separately |
| Smart notification | PASS | Actual Watch→Healthy transition after establishing a baseline; enabled health rule produced two manager notifications, non-template body, real STOP completion; notification displayed in UI |

An initial narrative diagnostic received a real STOP completion but Chromium
could not retrieve its response body through the protocol. It was not counted
as a UI pass. A resumed check verified completed rendered text instead.
The full `test:ai:live` suite was deliberately not repeated; targeted live
workflows provide the current evidence. Its older 30/2/2 result is historical,
not relabelled as a passing full-suite run.

## Limits, artifacts, and handoff

Existing milestone composite SetNull and deprecated Next middleware warnings
remain; neither justified an unrelated migration. Forecast data was a deliberate
synthetic test fixture, not production history. Model availability/free-tier
quota can still vary; nine successful completions do not guarantee uptime or
semantic correctness for arbitrary input. No production deployment occurred.

Environment draft persistence and publication are separate. Publication and
fresh-task restoration are not claimed without platform confirmation. The final
chat records the exact commit, push and publication status.

Logs, model metadata (no prompts/generated text), scripts and screenshots are
outside Git under `/workspace/.onboarding/results`: `review-*.log`,
`review-live-metadata.jsonl`, `dashboard-390.png`, `dashboard-1440.png`.
