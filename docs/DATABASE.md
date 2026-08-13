# Database

PostgreSQL via Prisma 7. Source of truth: `prisma/schema.prisma`. Migrations:
`prisma/migrations`.

## Design tenets

- **Multi-tenant by construction.** Every org-owned table has `organization_id`,
  and references its parents via a **composite foreign key** `(id, organization_id)`
  so relationships can't cross tenants.
- **Snake_case columns** (`@map`) with camelCase TypeScript fields.
- **Tenant-led indexes** — composite indexes begin with `organization_id`.
- **Explicit delete behavior** — `Cascade` from the organization downward;
  `Restrict` for "created by" author links; `SetNull` where a reference is optional
  (e.g. task assignee, task milestone).

## Entities

| Model | Purpose | Key relations |
| --- | --- | --- |
| `User` | A person; can belong to many orgs | → memberships, authored records |
| `Organization` | Tenant boundary | → members, projects, tasks, … |
| `OrganizationMember` | User ↔ Org with role & status | unique `(organizationId, userId)` |
| `Project` | Container of work | → milestones, tasks, dependencies |
| `Milestone` | Dated checkpoint in a project | → tasks |
| `Task` | First-class unit of work | → comments, dependencies, milestone, parent/subtasks |
| `TaskDependency` | Directed relation between tasks. **Tenant-scoped, not project-scoped** — endpoints may live in different projects | source/target task |
| `TaskComment` | Discussion on a task | author member |
| `Notification` | Per-recipient in-app notice (`type`, optional `dedupeKey`) | recipient member |
| `NotificationPreference` | Per-member notification settings (in-app/email, muted types) | member, unique `(organizationId, userId)` |
| `AutomationRule` | Deterministic trigger→condition→action | created-by member, → runs |
| `AutomationRun` | Idempotency ledger for one fired action | rule, unique `(organizationId, ruleId, dedupeKey)` |
| `SavedView` | Stored filter/sort/group preset for a view | owner member, optional project |
| `ActivityLog` | Structured audit/history event | actor member |

## Enums

- `MembershipRole`: ADMIN, MANAGER, MEMBER
- `MembershipStatus`: ACTIVE, INVITED, DISABLED
- `ProjectStatus`: ACTIVE, COMPLETED, ARCHIVED
- `TaskStatus`: TODO, IN_PROGRESS, BLOCKED, DONE
- `TaskPriority`: LOW, MEDIUM, HIGH, URGENT
- `MilestoneStatus`: PLANNED, ON_TRACK, AT_RISK, MISSED, DONE
- `DependencyType`: BLOCKS, DEPENDS_ON, RELATED_TO
- `AutomationTrigger`: TASK_OVERDUE, TASK_STATUS_CHANGED, PROJECT_HEALTH_CHANGED
- `AutomationAction`: NOTIFY_MANAGER, UPDATE_MILESTONE_PROGRESS, WRITE_AUDIT_EVENT
- `AutomationRunStatus`: SUCCESS, FAILED, SKIPPED
- `ViewType`: BOARD, LIST, TABLE, TIMELINE

## The composite-FK pattern (why it matters)

A `Task` belongs to a `Project`. Instead of only `project_id`, the task also
carries `organization_id`, and the foreign key is on **both** columns pointing at
`projects(id, organization_id)` (which is a unique key). Result: you cannot insert
a task whose organization differs from its project's organization — the database
refuses it. The same pattern links tasks↔milestones, dependencies↔tasks,
comments↔tasks, and every "created by" / "assigned to" link back to
`organization_members(user_id, organization_id)`.

**Implication for seeds & writes:** the creating/assigned user must already be an
ACTIVE member of the organization, or the composite FK insert fails. The seed
creates memberships before any project/task.

### Subtasks (self-relation)

`Task` carries an optional `parent_task_id` and a self-referencing composite FK
`(parent_task_id, organization_id) → tasks(id, organization_id)` (relation
`"TaskSubtasks"`, `parentTask` / `subtasks`). A subtask therefore always shares
its parent's organization, and deleting a parent `Cascade`s to its subtasks.
Cycle prevention (a task becoming its own ancestor) is enforced in the
application layer via `wouldCreateSubtaskCycle` in
`src/lib/domain/work-intelligence.ts`. Migration:
`20260812090000_subtasks`.

### Saved views

`SavedView` stores a named preset of the views system: `view_type` (BOARD /
LIST / TABLE / TIMELINE) plus a `config` JSONB blob holding the filter, sort
field/direction, grouping and visible columns. The shape of that blob is owned
by `src/lib/domain/view-engine.ts` and validated on write by `viewConfigSchema`
(`src/lib/validators.ts`), so nothing arbitrary lands in the column.

- `project_id` is **nullable**: a view is either project-scoped or org-level
  ("applies to any project"). When set, the composite FK
  `(project_id, organization_id) → projects(id, organization_id)` keeps it in
  tenant.
- Ownership uses the same dual link as `Notification`: a plain `owner User`
  relation plus `(owner_user_id, organization_id) → organization_members(user_id,
  organization_id)`, so a view can only be owned by a member of its own
  organization. Both cascade on delete.
- `is_shared` promotes a personal preset to an organization-wide one. Only roles
  holding `projects:update` may set it; owners always manage their own views.

Migration: `20260813090000_saved_views`.

### Automation runs & idempotency

Automations must be safe to run more than once — the same task status change may
be dispatched inline, and the scheduled scan (`POST /api/v1/automations/run`) can
be polled repeatedly. `AutomationRun` is the ledger that makes every effect
exactly-once:

- The pure engine (`src/lib/domain/automation-engine.ts`) derives a deterministic
  `dedupeKey` per (entity, meaningful-state) — e.g. `task_status:<taskId>:DONE`,
  `task_overdue:<taskId>:<dueDate>`, `project_health:<projectId>:<status>`.
- Before performing a planned action, the executor
  (`src/lib/automation/executor.ts`) INSERTs an `AutomationRun` keyed by the unique
  `(organization_id, rule_id, dedupe_key)`. A `P2002` unique violation means the
  effect already ran, so it is counted **SKIPPED** and no side effect happens.
- On a fresh insert the action runs inside a transaction that also bumps the
  rule's `runs_this_month` / `last_run_at`; the run stays **SUCCESS**. If the
  action throws, the run is flipped to **FAILED** (row kept, so it is never
  retried) and the batch continues.

There is **no background worker** in this stage. `runAutomationsForEvent` is
called inline after the mutation that produced the event (the task PATCH commits
first, then dispatches outside its transaction so automation can never fail the
user's write); `runScheduledAutomations` is exposed for a future cron to poll.

`Notification` also carries a `type` (default `general`) and an optional
`dedupeKey`. The notification service does an application-level dedupe: it will
not stack a second **unread** notification with the same
`(recipient, dedupeKey)`, and it honors each recipient's `NotificationPreference`
(`in_app_enabled`, `muted_types`) before writing.

Migration: `20260814090000_automation_engine`.

## Indexing highlights

- `organization_members`: unique `(organizationId, userId)`; indexes on
  `(organizationId, role)` and `(organizationId, status)`.
- `tasks`: indexes on `(organizationId, projectId)`, `(organizationId, milestoneId)`,
  `(organizationId, parentTaskId)`, `(organizationId, assignedToUserId)`,
  `(organizationId, status)`, `(organizationId, dueDate)`,
  `(organizationId, createdAt)`.
- `task_dependencies`: unique `(organizationId, sourceTaskId, targetTaskId, type)`.
  Has **no `project_id`** — an edge belongs to the tenant. Indexed on
  `(organization_id, source_task_id)` and `(organization_id, target_task_id)`
  because "edges relevant to project X" resolves as a join on *either* endpoint,
  so both directions must be indexed. Both endpoint FKs are composite
  `(task_id, organization_id)`, which is what makes cross-tenant edges impossible
  while allowing cross-project ones.
  to prevent duplicate edges.
- `notifications`: `(organizationId, recipientUserId, readAt)` for unread lookups,
  `(organizationId, recipientUserId, type)` for type filtering,
  `(organizationId, createdAt)` for the newest-first inbox.
- `notification_preferences`: unique `(organizationId, userId)` — one row per
  member per tenant.
- `automation_rules`: `(organizationId, enabled)` and `(organizationId, trigger)`
  so the executor can load only the enabled rules for a given trigger.
- `automation_runs`: unique `(organizationId, ruleId, dedupeKey)` (the
  idempotency guard), plus `(organizationId, ruleId)` and
  `(organizationId, createdAt)`.
- `saved_views`: `(organizationId, projectId)` for the per-project view picker,
  `(organizationId, ownerUserId)` for "my views", `(organizationId, isShared)`
  for the shared-view listing.

## Migrations

- History: `20260426153000_initial_tenant_core`, then
  `20260811121000_work_os_foundation` (milestones, dependencies, notifications,
  automation rules, plus task/project/activity columns), then
  `20260812090000_subtasks` (task `parent_task_id`, index, self-referencing
  composite FK), then `20260813090000_saved_views` (`view_type` enum,
  `saved_views` table, three tenant-led indexes, org/owner/member/project
  composite FKs), then `20260814090000_automation_engine`
  (`automation_run_status` enum, `automation_runs` table with the
  `(organization_id, rule_id, dedupe_key)` idempotency unique, `Notification.type`
  + `dedupe_key` columns and their indexes, and the `notification_preferences`
  table).
- Migrations use idempotent guards (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN
  duplicate_object`) so re-application is safe.
- **Never edit an applied migration.** Change the schema and run
  `npm run db:migrate` to generate a new one.

## Working with the data model

```bash
npm run db:generate   # regenerate the typed client after schema edits
npm run db:migrate    # create + apply a dev migration
npm run db:seed       # load demo data
npm run db:studio     # browse data in Prisma Studio
```

## Suggested future entities (roadmap)

Tag + TaskTag, CustomField + values, Document/Attachment (with object
storage), Webhook, Integration, ApiKey, and a first-class AuditEvent distinct from
`ActivityLog`. (The subtask/parent-task self relation, `SavedView`, and the
automation ledger + `NotificationPreference` have shipped — see "Subtasks
(self-relation)", "Saved views" and "Automation runs & idempotency" above.)
