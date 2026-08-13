import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

export const GET = withTenantGuard(Permission.MembersRead, async (_request, tenant) => {
  const organizationId = tenant.tenantId;

  const members = await prisma.organizationMember.findMany({
    where: {
      organizationId,
      status: "ACTIVE",
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      assignedTasks: {
        where: {
          status: {
            in: ["IN_PROGRESS", "TODO"],
          },
        },
        orderBy: [
          { priority: "desc" },
          { dueDate: "asc" },
        ],
        take: 1,
        select: {
          id: true,
          title: true,
          status: true,
          priority: true,
          project: {
            select: {
              name: true,
            },
          },
        },
      },
    },
    orderBy: {
      user: {
        name: "asc",
      },
    },
  });

  const roster = members.map((m) => ({
    id: m.id,
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    activeTask: m.assignedTasks.length > 0 ? m.assignedTasks[0] : null,
  }));

  return json({ roster });
});
