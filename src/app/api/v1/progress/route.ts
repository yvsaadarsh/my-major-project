import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { Permission } from "@/lib/rbac";

function getStartOfDay(date: Date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function getStartOfWeekMonday(date: Date) {
  const value = getStartOfDay(date);
  const day = value.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  value.setDate(value.getDate() + mondayOffset);
  return value;
}

export const GET = withTenantGuard(Permission.TasksRead, async (_request, tenant) => {
  const userId = tenant.user.id;
  const organizationId = tenant.tenantId;

  const now = new Date();
  const today = getStartOfDay(now);
  const thisWeek = getStartOfWeekMonday(now);

  const [
    completedTodayCount,
    completedThisWeekCount,
    historicalCompletionsCount,
    ratingAggregate,
    currentTasks,
    historicalCompletions,
    ratingBreakdown,
  ] = await prisma.$transaction([
    prisma.task.count({
      where: {
        organizationId,
        assignedToUserId: userId,
        status: "DONE",
        completedAt: { gte: today },
      },
    }),
    prisma.task.count({
      where: {
        organizationId,
        assignedToUserId: userId,
        status: "DONE",
        completedAt: { gte: thisWeek },
      },
    }),
    prisma.task.count({
      where: {
        organizationId,
        assignedToUserId: userId,
        status: "DONE",
        completedAt: { not: null },
      },
    }),
    prisma.task.aggregate({
      where: {
        organizationId,
        assignedToUserId: userId,
        rating: { not: null },
      },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    prisma.task.findMany({
      where: {
        organizationId,
        assignedToUserId: userId,
        status: { not: "DONE" },
        OR: [{ priority: "URGENT" }, { status: "IN_PROGRESS" }],
      },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueDate: true,
        project: { select: { id: true, name: true } },
      },
      orderBy: [{ priority: "desc" }, { dueDate: "asc" }, { updatedAt: "desc" }],
      take: 10,
    }),
    prisma.task.findMany({
      where: {
        organizationId,
        assignedToUserId: userId,
        status: "DONE",
        completedAt: { not: null },
        project: {
          status: { in: ["COMPLETED", "ARCHIVED"] },
        },
      },
      select: {
        id: true,
        title: true,
        completedAt: true,
        rating: true,
        project: { select: { id: true, name: true, status: true } },
      },
      orderBy: { completedAt: "desc" },
      take: 20,
    }),
    prisma.task.groupBy({
      by: ["rating"],
      where: {
        organizationId,
        assignedToUserId: userId,
        rating: { not: null },
      },
      _count: { _all: true },
      orderBy: { rating: "asc" },
    }),
  ]);

  return json({
    analytics: {
      completedToday: completedTodayCount,
      completedThisWeek: completedThisWeekCount,
      historicalCompletions: historicalCompletionsCount,
      averageRating:
        ratingAggregate._avg.rating === null
          ? null
          : Number(ratingAggregate._avg.rating.toFixed(1)),
      ratingsCount: ratingAggregate._count.rating,
      ratingsBreakdown: ratingBreakdown,
    },
    currentWork: currentTasks,
    history: historicalCompletions,
  });
});
