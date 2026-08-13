import { MembershipStatus } from "@/generated/prisma/client";
import { ApiError } from "@/lib/api/http";
import { prisma } from "@/lib/db";

export async function requireProjectForTenant(tenantId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: {
      id: projectId,
      organizationId: tenantId,
    },
  });

  if (!project) {
    throw new ApiError(404, "project_not_found", "Project was not found.");
  }

  return project;
}

export async function requireTaskForTenant(tenantId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: {
      id: taskId,
      organizationId: tenantId,
    },
  });

  if (!task) {
    throw new ApiError(404, "task_not_found", "Task was not found.");
  }

  return task;
}

export async function requireSavedViewForTenant(tenantId: string, viewId: string) {
  const view = await prisma.savedView.findFirst({
    where: {
      id: viewId,
      organizationId: tenantId,
    },
  });

  if (!view) {
    throw new ApiError(404, "view_not_found", "Saved view was not found.");
  }

  return view;
}

export async function requireActiveMemberForTenant(tenantId: string, userId: string) {
  const membership = await prisma.organizationMember.findFirst({
    where: {
      organizationId: tenantId,
      userId,
      status: MembershipStatus.ACTIVE,
    },
  });

  if (!membership) {
    throw new ApiError(
      422,
      "invalid_member",
      "The selected user is not an active member of this organization.",
    );
  }

  return membership;
}

export async function assertNotLastActiveAdmin(tenantId: string, memberId: string) {
  const member = await prisma.organizationMember.findFirst({
    where: {
      id: memberId,
      organizationId: tenantId,
      status: MembershipStatus.ACTIVE,
    },
  });

  if (!member) {
    throw new ApiError(404, "member_not_found", "Member was not found.");
  }

  if (member.role !== "ADMIN") {
    return member;
  }

  const activeAdminCount = await prisma.organizationMember.count({
    where: {
      organizationId: tenantId,
      role: "ADMIN",
      status: MembershipStatus.ACTIVE,
    },
  });

  if (activeAdminCount <= 1) {
    throw new ApiError(
      409,
      "last_admin",
      "At least one active admin must remain in the organization.",
    );
  }

  return member;
}
