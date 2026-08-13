export type Role = "ADMIN" | "MANAGER" | "MEMBER";

export type Permission =
  | "audit:read"
  | "automations:manage"
  | "automations:read"
  | "dashboard:read"
  | "members:manage"
  | "members:read"
  | "notifications:read"
  | "organization:update"
  | "projects:create"
  | "projects:delete"
  | "projects:read"
  | "projects:update"
  | "tasks:assign"
  | "tasks:comment"
  | "tasks:create"
  | "tasks:delete"
  | "tasks:read"
  | "tasks:update"
  | "tasks:updateAssignedStatus";

const rolePermissions: Record<Role, Permission[]> = {
  ADMIN: [
    "audit:read",
    "automations:manage",
    "automations:read",
    "dashboard:read",
    "members:manage",
    "members:read",
    "notifications:read",
    "organization:update",
    "projects:create",
    "projects:delete",
    "projects:read",
    "projects:update",
    "tasks:assign",
    "tasks:comment",
    "tasks:create",
    "tasks:delete",
    "tasks:read",
    "tasks:update",
    "tasks:updateAssignedStatus",
  ],
  MANAGER: [
    "automations:manage",
    "automations:read",
    "dashboard:read",
    "members:read",
    "notifications:read",
    "projects:create",
    "projects:read",
    "projects:update",
    "tasks:assign",
    "tasks:comment",
    "tasks:create",
    "tasks:read",
    "tasks:update",
    "tasks:updateAssignedStatus",
  ],
  MEMBER: [
    "automations:read",
    "dashboard:read",
    "notifications:read",
    "projects:read",
    "tasks:comment",
    "tasks:read",
    "members:read",
    "tasks:updateAssignedStatus",
  ],
};

export const roles: Role[] = ["ADMIN", "MANAGER", "MEMBER"];

export function normalizeRole(role?: string | null): Role {
  if (role === "ADMIN" || role === "MANAGER" || role === "MEMBER") {
    return role;
  }

  return "ADMIN";
}

export function can(role: Role, permission: Permission) {
  return rolePermissions[role].includes(permission);
}

export function roleLabel(role: Role) {
  return {
    ADMIN: "Admin",
    MANAGER: "Manager",
    MEMBER: "Team Member",
  }[role];
}

export function roleDescription(role: Role) {
  return {
    ADMIN: "Full workspace control",
    MANAGER: "Project and task operations",
    MEMBER: "Assigned work and comments",
  }[role];
}
