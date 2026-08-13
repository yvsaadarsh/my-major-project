import { MembershipRole } from "@/generated/prisma/client";

import { ApiError } from "@/lib/api/http";

export const Permission = {
  DashboardRead: "dashboard:read",
  AuditRead: "audit:read",
  AutomationsManage: "automations:manage",
  AutomationsRead: "automations:read",
  MembersManage: "members:manage",
  MembersRead: "members:read",
  NotificationsRead: "notifications:read",
  OrganizationRead: "organization:read",
  OrganizationUpdate: "organization:update",
  ProjectsCreate: "projects:create",
  ProjectsDelete: "projects:delete",
  ProjectsRead: "projects:read",
  ProjectsUpdate: "projects:update",
  TasksComment: "tasks:comment",
  TasksAssign: "tasks:assign",
  TasksCreate: "tasks:create",
  TasksDelete: "tasks:delete",
  TasksRead: "tasks:read",
  TasksUpdate: "tasks:update",
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const rolePermissions: Record<MembershipRole, Permission[]> = {
  [MembershipRole.ADMIN]: [
    Permission.AuditRead,
    Permission.AutomationsManage,
    Permission.AutomationsRead,
    Permission.DashboardRead,
    Permission.MembersManage,
    Permission.MembersRead,
    Permission.NotificationsRead,
    Permission.OrganizationRead,
    Permission.OrganizationUpdate,
    Permission.ProjectsCreate,
    Permission.ProjectsDelete,
    Permission.ProjectsRead,
    Permission.ProjectsUpdate,
    Permission.TasksComment,
    Permission.TasksAssign,
    Permission.TasksCreate,
    Permission.TasksDelete,
    Permission.TasksRead,
    Permission.TasksUpdate,
  ],
  [MembershipRole.MANAGER]: [
    Permission.AutomationsManage,
    Permission.AutomationsRead,
    Permission.DashboardRead,
    Permission.MembersRead,
    Permission.NotificationsRead,
    Permission.OrganizationRead,
    Permission.ProjectsCreate,
    Permission.ProjectsRead,
    Permission.ProjectsUpdate,
    Permission.TasksComment,
    Permission.TasksAssign,
    Permission.TasksCreate,
    Permission.TasksRead,
    Permission.TasksUpdate,
  ],
  [MembershipRole.MEMBER]: [
    Permission.DashboardRead,
    Permission.AutomationsRead,
    Permission.NotificationsRead,
    Permission.OrganizationRead,
    Permission.ProjectsRead,
    Permission.TasksComment,
    Permission.TasksRead,
    Permission.MembersRead,
  ],
};

export function hasPermission(role: MembershipRole, permission: Permission) {
  return rolePermissions[role].includes(permission);
}

export function assertPermission(role: MembershipRole, permission: Permission) {
  if (!hasPermission(role, permission)) {
    throw new ApiError(
      403,
      "forbidden",
      "Your role does not allow this action in the active organization.",
    );
  }
}

export function canManageRole(actorRole: MembershipRole, targetRole: MembershipRole) {
  if (actorRole !== MembershipRole.ADMIN) {
    return false;
  }

  return [MembershipRole.ADMIN, MembershipRole.MANAGER, MembershipRole.MEMBER].includes(
    targetRole,
  );
}
