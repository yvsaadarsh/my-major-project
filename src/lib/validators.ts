import { z } from "zod";

// Password length bounds live in the auth policy domain layer so the API, the
// UI meter and the tests all read the same numbers. The schema enforces only the
// outer bounds; strength is judged by `assessPassword`, which returns reasons
// rather than a bare pass/fail.
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/domain/auth-policy";

export const registerSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  name: z.string().trim().min(2).max(120),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

// Sign-in accepts any non-empty password within the storable range. It must NOT
// apply the strength policy: rejecting a short password at login would tell an
// attacker that no account could have that password, and would lock out users
// who registered before the policy tightened.
export const loginSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export const organizationCreateSchema = z.object({
  name: z.string().trim().min(2).max(140),
});

export const organizationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(140),
});

export const roleSchema = z.enum(["ADMIN", "MANAGER", "MEMBER"]);

export const memberInviteSchema = z.object({
  email: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  role: roleSchema.default("MEMBER"),
});

export const memberRoleUpdateSchema = z.object({
  role: roleSchema,
});

export const projectCreateSchema = z.object({
  description: z.string().trim().max(5000).optional(),
  name: z.string().trim().min(2).max(160),
  status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).default("ACTIVE"),
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
});

export const projectUpdateSchema = z
  .object({
    description: z.string().trim().max(5000).nullable().optional(),
    name: z.string().trim().min(2).max(160).optional(),
    status: z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]).optional(),
    startDate: z.string().datetime().nullable().optional(),
    endDate: z.string().datetime().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one project field must be provided.",
  });

export const taskCreateSchema = z.object({
  assignedToUserId: z.string().nullable().optional(),
  description: z.string().trim().max(5000).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  milestoneId: z.string().nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]).default("TODO"),
  title: z.string().trim().min(2).max(180),
});

export const taskUpdateSchema = z
  .object({
    assignedToUserId: z.string().nullable().optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    milestoneId: z.string().nullable().optional(),
    parentTaskId: z.string().nullable().optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]).optional(),
    title: z.string().trim().min(2).max(180).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one task field must be provided.",
  });

export const taskCommentCreateSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

export const automationRuleCreateSchema = z.object({
  action: z.enum(["NOTIFY_MANAGER", "UPDATE_MILESTONE_PROGRESS", "WRITE_AUDIT_EVENT"]),
  condition: z.string().trim().min(4).max(500),
  description: z.string().trim().max(2000).optional(),
  enabled: z.boolean().default(true),
  name: z.string().trim().min(2).max(160),
  trigger: z.enum(["TASK_OVERDUE", "TASK_STATUS_CHANGED", "PROJECT_HEALTH_CHANGED"]),
  /**
   * The original natural-language policy text that produced this rule via
   * the /automations/interpret endpoint. Stored for audit and re-interpretation
   * purposes. Not required when creating rules directly.
   */
  sourcePolicy: z.string().trim().max(2000).optional(),
});

export const automationRuleUpdateSchema = z
  .object({
    action: z.enum(["NOTIFY_MANAGER", "UPDATE_MILESTONE_PROGRESS", "WRITE_AUDIT_EVENT"]).optional(),
    condition: z.string().trim().min(4).max(500).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
    name: z.string().trim().min(2).max(160).optional(),
    trigger: z.enum(["TASK_OVERDUE", "TASK_STATUS_CHANGED", "PROJECT_HEALTH_CHANGED"]).optional(),
    /** Updated NL policy if the rule is re-interpreted. Nullable to allow clearing it. */
    sourcePolicy: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one automation field must be provided.",
  });

// ─── Policy Interpretation — Feature 2 ──────────────────────────────────────
//
// These schemas guard the /automations/interpret endpoint. The request carries
// the manager's natural-language policy; the response is a validated draft rule
// (or a clear error) ready for human review before the manager chooses to save
// it through the normal POST /automations flow.

/** POST /api/v1/automations/interpret — request body */
export const policyInterpretRequestSchema = z.object({
  /**
   * The manager's natural-language policy description.
   * Example: "Notify the manager whenever a high-priority task becomes overdue."
   */
  policy: z.string().trim().min(1).max(2000),
});

/**
 * The structured rule fields the AI returns — a subset of the create schema.
 * `condition` may be an empty string ("") when the policy has no condition.
 */
export const interpretedRuleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  trigger: z.enum(["TASK_OVERDUE", "TASK_STATUS_CHANGED", "PROJECT_HEALTH_CHANGED"]),
  condition: z.string().max(500),
  action: z.enum(["NOTIFY_MANAGER", "UPDATE_MILESTONE_PROGRESS", "WRITE_AUDIT_EVENT"]),
});

export type InterpretedRule = z.infer<typeof interpretedRuleSchema>;

/**
 * The raw JSON shape `AUTOMATION_PARSE_SYSTEM` returns.
 * Two valid shapes: a valid rule or an explicit "unsupported" error.
 * Everything else (network failure, malformed JSON, wrong keys) is caught
 * upstream and surfaced as a 502 rather than a 422.
 */
export const aiRuleOutputSchema = z.union([
  interpretedRuleSchema,
  z.object({ error: z.literal("unsupported") }),
]);

export type AiRuleOutput = z.infer<typeof aiRuleOutputSchema>;

// The notification types producers emit today (see the automation engine's
// planned NOTIFY_MANAGER actions), plus the catch-all default.
export const notificationTypeSchema = z.enum([
  "general",
  "task.status_changed",
  "task.overdue",
  "project.health_changed",
]);

export const notificationPreferenceSchema = z
  .object({
    inAppEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
    mutedTypes: z.array(notificationTypeSchema).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one preference field must be provided.",
  });

export const milestoneCreateSchema = z.object({
  description: z.string().trim().max(2000).optional(),
  dueDate: z.string().datetime(),
  name: z.string().trim().min(2).max(160),
  status: z.enum(["PLANNED", "ON_TRACK", "AT_RISK", "MISSED", "DONE"]).default("PLANNED"),
});

export const viewTypeSchema = z.enum(["BOARD", "LIST", "TABLE", "TIMELINE"]);

export const viewSortFieldSchema = z.enum([
  "title",
  "status",
  "priority",
  "dueDate",
  "createdAt",
  "assignee",
]);

export const viewSortDirectionSchema = z.enum(["asc", "desc"]);

export const viewGroupBySchema = z.enum([
  "none",
  "status",
  "priority",
  "assignee",
  "milestone",
  "dueDate",
]);

const viewFilterIdList = z.array(z.string().trim().min(1).max(80)).max(50);

export const viewFilterSchema = z.object({
  assigneeIds: viewFilterIdList.default([]),
  includeSubtasks: z.boolean().default(true),
  milestoneIds: viewFilterIdList.default([]),
  overdueOnly: z.boolean().default(false),
  priority: z.array(z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"])).max(4).default([]),
  search: z.string().trim().max(180).default(""),
  status: z.array(z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"])).max(4).default([]),
});

export const viewConfigSchema = z.object({
  filter: viewFilterSchema.default({
    assigneeIds: [],
    includeSubtasks: true,
    milestoneIds: [],
    overdueOnly: false,
    priority: [],
    search: "",
    status: [],
  }),
  groupBy: viewGroupBySchema.default("status"),
  sortDirection: viewSortDirectionSchema.default("desc"),
  sortField: viewSortFieldSchema.default("createdAt"),
  visibleColumns: z
    .array(z.enum(["title", "status", "priority", "assignee", "dueDate", "milestone"]))
    .max(6)
    .default(["title", "status", "priority", "assignee", "dueDate", "milestone"]),
});

export const savedViewCreateSchema = z.object({
  config: viewConfigSchema,
  isShared: z.boolean().default(false),
  name: z.string().trim().min(2).max(160),
  projectId: z.string().trim().min(1).max(80).nullable().optional(),
  viewType: viewTypeSchema,
});

export const savedViewUpdateSchema = z
  .object({
    config: viewConfigSchema.optional(),
    isShared: z.boolean().optional(),
    name: z.string().trim().min(2).max(160).optional(),
    viewType: viewTypeSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one saved view field must be provided.",
  });

export const dependencyCreateSchema = z
  .object({
    sourceTaskId: z.string().min(1),
    targetTaskId: z.string().min(1),
    type: z.enum(["BLOCKS", "DEPENDS_ON", "RELATED_TO"]).default("BLOCKS"),
  })
  .refine((value) => value.sourceTaskId !== value.targetTaskId, {
    message: "A task cannot depend on itself.",
  });

// ─── What-If Simulation — Feature 1 ─────────────────────────────────────────
//
// Eight discriminated-union change types. Each union member carries exactly the
// fields its change handler needs — no extra surface for injection.
//
// The `snapshotToken` (project.updatedAt ISO string) travels with every request
// so the Apply endpoint can reject a stale simulation cheaply, without a
// separate version-fetch round-trip.

const taskStatusChangeSchema = z.object({
  type: z.literal("task_status"),
  taskId: z.string().min(1).max(40),
  status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]),
});

const taskReassignChangeSchema = z.object({
  type: z.literal("task_reassign"),
  taskId: z.string().min(1).max(40),
  /** null → unassign */
  assignedToUserId: z.string().max(40).nullable(),
});

const taskDueDateChangeSchema = z.object({
  type: z.literal("task_due_date"),
  taskId: z.string().min(1).max(40),
  /** null → remove due date */
  dueDate: z.string().datetime().nullable(),
});

const taskAddChangeSchema = z.object({
  type: z.literal("task_add"),
  title: z.string().trim().min(2).max(180),
  status: z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]).default("TODO"),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  dueDate: z.string().datetime().nullable().optional(),
  assignedToUserId: z.string().max(40).nullable().optional(),
  milestoneId: z.string().max(40).nullable().optional(),
});

const taskRemoveChangeSchema = z.object({
  type: z.literal("task_remove"),
  taskId: z.string().min(1).max(40),
});

const milestoneDateChangeSchema = z.object({
  type: z.literal("milestone_date"),
  milestoneId: z.string().min(1).max(40),
  dueDate: z.string().datetime(),
});

const dependencyAddChangeSchema = z
  .object({
    type: z.literal("dependency_add"),
    sourceTaskId: z.string().min(1).max(40),
    targetTaskId: z.string().min(1).max(40),
    depType: z.enum(["BLOCKS", "DEPENDS_ON", "RELATED_TO"]).default("BLOCKS"),
  })
  .refine((v) => v.sourceTaskId !== v.targetTaskId, {
    message: "A task cannot depend on itself.",
  });

const dependencyRemoveChangeSchema = z.object({
  type: z.literal("dependency_remove"),
  dependencyId: z.string().min(1).max(40),
});

/** Discriminated union over all 8 supported change types. */
export const simulationChangeSchema = z.discriminatedUnion("type", [
  taskStatusChangeSchema,
  taskReassignChangeSchema,
  taskDueDateChangeSchema,
  taskAddChangeSchema,
  taskRemoveChangeSchema,
  milestoneDateChangeSchema,
  dependencyAddChangeSchema,
  dependencyRemoveChangeSchema,
]);

export type SimulationChange = z.infer<typeof simulationChangeSchema>;

/** POST /api/v1/intelligence/projects/:id/simulate */
export const simulationRequestSchema = z.object({
  /** Free-text description of the what-if scenario from the user. */
  scenario: z.string().trim().min(1).max(2000),
  change: simulationChangeSchema,
  /**
   * Concurrency token: project.updatedAt.toISOString() captured when the page
   * loaded. The Apply endpoint rejects the write if the project has since been
   * updated by someone else.
   */
  snapshotToken: z.string().min(1).max(100),
});

/** POST /api/v1/intelligence/projects/:id/apply */
export const applySimulationSchema = z.object({
  change: simulationChangeSchema,
  /** Same token passed during simulate — verified against live project.updatedAt. */
  snapshotToken: z.string().min(1).max(100),
});
