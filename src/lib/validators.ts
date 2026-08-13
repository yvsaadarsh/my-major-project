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
});

export const automationRuleUpdateSchema = z
  .object({
    action: z.enum(["NOTIFY_MANAGER", "UPDATE_MILESTONE_PROGRESS", "WRITE_AUDIT_EVENT"]).optional(),
    condition: z.string().trim().min(4).max(500).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    enabled: z.boolean().optional(),
    name: z.string().trim().min(2).max(160).optional(),
    trigger: z.enum(["TASK_OVERDUE", "TASK_STATUS_CHANGED", "PROJECT_HEALTH_CHANGED"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one automation field must be provided.",
  });

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
