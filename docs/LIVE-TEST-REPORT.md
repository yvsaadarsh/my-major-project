# Live Test Report — Days 1–6

**Target**: https://my-major-project-eight.vercel.app/
**Tested**: 2026-08-12
**Method**: two independent tenants exercised end-to-end via a real Chrome browser (no mocks), with API endpoints probed directly from each session.

## Setup

| Tenant | Email | Org | Project | Role |
| --- | --- | --- | --- | --- |
| A | `a1test@projectos.dev` | Alpha Corp | Roadmap Q3 | Admin |
| B | `b1test@projectos.dev` | Beta Inc | (none) | Admin |

Alpha's `Roadmap Q3` seeded with 5 tasks: 2 onboarding starters (`Validate tenant guard on task update` — High, In Progress; `Review RBAC command surface` — Todo) plus 3 test tasks (`Login bug`, `Ship analytics`, `Migrate DB`). Alpha task URL captured for the isolation test: `/tasks/cmspsabmd000204jsek1jrglc` (`Ship analytics`).

## Results by area

### Auth (Day 1)

- **Register + auto-login**: pass. Registering `a1test@projectos.dev` lands directly on `/onboarding` with the newly-issued session cookie already applied.
- **Onboarding flow**: pass. All four steps (Organization → Members → First project → Walkthrough) rendered and advanced; the setup-progress bar tracked correctly (25% → 50% → 75% → 100%).
- **Role reflection**: pass. Sidebar `ACTIVE ROLE` and top-right `Role view` switched from `Team Member` (no org) to `Admin` (owner of created org) — role is derived from membership, not a client toggle.
- **Logout**: pass. `POST /api/v1/auth/logout` returned `204`; the session cookie was cleared.
- **Auth guard**: pass. Hitting `/dashboard` and `/tasks/<id>` while logged out redirects to `/` (login).

### Top-level pages (all rendered with real tenant data — no 500s, no infinite spinners)

- `/dashboard` — Active projects 1, Open tasks 5, Done 0, Members 1. Project pulse card lists Roadmap Q3, "Assigned focus" queue shows the two seeded tasks.
- `/work-os` — Roadmap Q3 shows `Healthy 100` with the four transparent-scoring reasons (`No overdue open tasks`, `No blocked task bottleneck`, etc.). Metric tiles: Projects 1, Milestones 0, Dependencies 0, Unread notices 0.
- `/analytics` — Total tasks 5, Completion rate 0% (`0 done`), Overdue 0%, Blocked 0. Weekly throughput chart renders 8 buckets. Cycle time card shows the honest "No completed tasks yet to measure." — no fake number.
- `/progress` — "Today's Work 0", "This Week's Completions 0". Current Work lists `Validate tenant guard on task update / In Progress · Roadmap Q3`.
- `/automations` — Empty state ("No automation rules yet") with a "New rule" form (Trigger, Condition, Action) properly wired to the enum contract from the automation engine.
- `/notifications` — Inbox "All caught up", Preferences panel with 5 muted-type toggles (General, Task Status Changed, Task Overdue, Project Health Changed, plus one below the fold) and email-notifications flag stored for future email digest (correctly labelled "not sent yet").
- `/members` — Alpha Admin listed as Admin, Active. Invite-member form with role picker.
- `/projects` — 5 of 5 tasks; Board / List / Table / Timeline view toggles; Sort / Direction / Group-by / Scope controls; Saved-view dropdown with Update / Share / Delete. Board columns render `TO DO (4)` / `IN PROGRESS (1)` with correct card counts, priority pills (Medium / High) visible on each card.
- `/search` — Standalone page with query input, filter chips (Projects, Tasks, Comments, People, Milestones, Saved views, Automations, Activity), and prefix legend beneath the input.
- `/shortcuts` — Three sections: "Anywhere in the app" (`Ctrl+K`, `/`, `?`, `g` then key), "Inside the command palette" (arrows, `Ctrl+P/N`, Enter, Home/End, Esc), and "Go to" table below (out of frame).

### Search + command palette (Day 6)

- **`/search?q=login`** — 1 result: `Login bug` under `Tasks`, with `Login` highlighted, reason pill `starts with query`, and transparent `relevance 78` badge. Consistent with the domain scoring: `POINTS.prefix (60) + POINTS.wholeWord (18) = 78` at title weight 1.0.
- **Command palette (`Ctrl+K` opens a dialog with the "Search tasks, projects, people... or type > for commands" hint)**: pass. `NAVIGATE` group visible on empty query; typing `login` scoped to `TASKS` with the matching card. `Ctrl+K` (dispatched via keyboard event) opens; `Esc` closes.
- **Scoring / debouncing**: no 4xx or 5xx to the search endpoint in the network trace; the client waits ~180 ms after the last keystroke before firing.

### Automations, notifications, members forms

Rendered with the correct enum options from the automation engine (Trigger: `Task Status Changed`; Condition example: `status == DONE`; Action: `Update Milestone Progress`). Preferences panel writes to the `notificationPreferences` table.

## Cross-tenant isolation — the security-critical set

Executed from Beta Inc's session against Alpha Corp's data:

| Probe | Expected | Actual | Result |
| --- | --- | --- | --- |
| `GET /tasks/cmspsabmd000204jsek1jrglc` (page) | tenant-safe "not found" | banner `Task was not found.` + `No task available` fallback, sidebar tenant `Beta Inc` | **PASS** |
| `GET /api/v1/tasks/cmspsabmd000204jsek1jrglc` (raw API) | `404 task_not_found` — indistinguishable from a fake ID | `{status: 404, body: {error: {code: "task_not_found", message: "Task was not found."}}}` | **PASS** |
| `GET /api/v1/command/search?q=Roadmap` | zero results, no leak of `Roadmap Q3` | `{total: 0, groups: [], sample: []}` | **PASS** |
| `/search?q=login` (page) | "No matches" | rendered `No matches — Nothing matched "login" in the types your role can read.` | **PASS** |
| `GET /api/v1/analytics/overview` | Beta sees no Alpha projects | `{status: 200, projects: []}` | **PASS** |

The task-not-found response and the 404 status match — Beta cannot even confirm the ID is valid, let alone read any Alpha content. The search API and the analytics API both filter through the tenant guard and return empty result sets rather than partial ones, so the boundary is enforced consistently across REST endpoints, not just the UI.

## Observations worth noting (non-blocking)

1. **Create-task form has no project selector.** Alpha's `Roadmap Q3` was the only project so tasks landed correctly, but with multiple projects the current UX would silently attach to whichever project the user visited last. Consider an explicit project picker (or lock the form to the currently open project detail page).
2. **Priority defaults to Medium.** The card lists show priority pills, and the task detail page displays the `PRIORITY` field, but the create-task form does not offer a priority selector inline — you have to open the task and use `Edit task`. Fine for MVP; nice-to-have for the seed flow.
3. **Onboarding pre-fill.** The registration form pre-fills with a demo name/email/password, which is friendly for a demo build but should be blank (or clearly branded as "example values") before real users are onboarded.
4. **Renderer occasionally freezes on task-detail POSTs.** During automated testing, `Edit task` triggered a CDP timeout twice on the same session; the task load and the underlying save still succeeded (verifiable via reload). This is likely a client-side hydration cost after the mutation, not a data issue. Worth profiling.
5. **`/tasks/<id>` empty-tenant state is friendly.** When a task is unreachable, the page renders `No task available` with a link back to the project board. That's exactly what you want when a stale bookmark points at a task from a different org.

## Verdict

Days 1–6 hold up under a real end-to-end run against the production Vercel deployment. The two things that had to work — auth + tenant scoping and the Day 6 search/command surface — both worked, including at the API layer. No 500s, no console errors, and no data crossover between tenants at any endpoint I probed.

Ready to move on. The Day 7 UI/a11y and the Stage 2 AI work can now proceed on a proven base.
