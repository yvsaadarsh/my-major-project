import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

export const GET = withTenantGuard(Permission.DashboardRead, async (_request, tenant) => {
  const projects = await prisma.project.findMany({
    where: {
      organizationId: tenant.tenantId,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      status: true,
      tasks: {
        select: {
          status: true,
        },
      },
    },
  });

  return json({
    projects: projects.map((project) => {
      const totalTasks = project.tasks.length;
      const completedTasks = project.tasks.filter((task) => task.status === "DONE").length;

      return {
        completedTasks,
        id: project.id,
        name: project.name,
        status: project.status,
        totalTasks,
      };
    }),
  });
});
