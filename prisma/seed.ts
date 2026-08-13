/**
 * Project OS — development seed.
 *
 * Creates one demo organization ("Northwind Labs") with three members, a set of
 * projects, milestones, tasks (including overdue + blocked), dependencies,
 * comments, notifications and automation rules. Safe to re-run: it removes the
 * demo organization and demo users first, then recreates everything.
 *
 * Run with:  npm run db:seed   (requires `prisma generate` + a reachable DB)
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  PrismaClient,
  MembershipRole,
  MembershipStatus,
  ProjectStatus,
  TaskStatus,
  TaskPriority,
  MilestoneStatus,
  DependencyType,
  AutomationTrigger,
  AutomationAction,
} from "../src/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the seed.");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const DEMO_ORG_SLUG = "northwind-labs";
const DEMO_EMAILS = [
  "ada@northwind.test",
  "grace@northwind.test",
  "linus@northwind.test",
];

const day = 24 * 60 * 60 * 1000;
const now = Date.now();
const daysFromNow = (n: number) => new Date(now + n * day);

async function reset() {
  // Deleting the organization cascades to members, projects, tasks, milestones,
  // dependencies, comments, notifications, automations and activity logs.
  const org = await prisma.organization.findUnique({ where: { slug: DEMO_ORG_SLUG } });
  if (org) {
    await prisma.organization.delete({ where: { id: org.id } });
  }
  await prisma.user.deleteMany({ where: { email: { in: DEMO_EMAILS } } });
}

async function main() {
  await reset();

  const passwordHash = await bcrypt.hash("Password123!", 12);

  const [ada, grace, linus] = await Promise.all([
    prisma.user.create({
      data: { name: "Ada Lovelace", email: DEMO_EMAILS[0], passwordHash },
    }),
    prisma.user.create({
      data: { name: "Grace Hopper", email: DEMO_EMAILS[1], passwordHash },
    }),
    prisma.user.create({
      data: { name: "Linus Reyes", email: DEMO_EMAILS[2], passwordHash },
    }),
  ]);

  const org = await prisma.organization.create({
    data: {
      name: "Northwind Labs",
      slug: DEMO_ORG_SLUG,
      createdByUserId: ada.id,
    },
  });

  // Members must exist before any org-owned record that references them via the
  // composite (userId, organizationId) foreign key.
  await prisma.organizationMember.createMany({
    data: [
      { organizationId: org.id, userId: ada.id, role: MembershipRole.ADMIN, status: MembershipStatus.ACTIVE },
      { organizationId: org.id, userId: grace.id, role: MembershipRole.MANAGER, status: MembershipStatus.ACTIVE },
      { organizationId: org.id, userId: linus.id, role: MembershipRole.MEMBER, status: MembershipStatus.ACTIVE },
    ],
  });

  // ---- Project: Platform Launch -----------------------------------------
  const launch = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: "Platform Launch",
      description: "Ship the multi-tenant core to the first design partners.",
      status: ProjectStatus.ACTIVE,
      startDate: daysFromNow(-30),
      endDate: daysFromNow(21),
      createdByUserId: grace.id,
    },
  });

  const mvpMilestone = await prisma.milestone.create({
    data: {
      organizationId: org.id,
      projectId: launch.id,
      name: "MVP feature-complete",
      description: "All P0 flows working end to end.",
      dueDate: daysFromNow(7),
      status: MilestoneStatus.AT_RISK,
      createdByUserId: grace.id,
    },
  });

  const authTask = await prisma.task.create({
    data: {
      organizationId: org.id,
      projectId: launch.id,
      milestoneId: mvpMilestone.id,
      title: "Harden authentication & sessions",
      description: "Rate limiting, session revocation, secure cookies.",
      status: TaskStatus.IN_PROGRESS,
      priority: TaskPriority.HIGH,
      assignedToUserId: ada.id,
      createdByUserId: grace.id,
      dueDate: daysFromNow(3),
    },
  });

  const rbacTask = await prisma.task.create({
    data: {
      organizationId: org.id,
      projectId: launch.id,
      milestoneId: mvpMilestone.id,
      title: "Finalize RBAC permission matrix",
      description: "Lock down manager vs. member capabilities.",
      status: TaskStatus.DONE,
      priority: TaskPriority.MEDIUM,
      assignedToUserId: ada.id,
      createdByUserId: ada.id,
      completedAt: daysFromNow(-2),
      dueDate: daysFromNow(-4),
    },
  });

  const billingTask = await prisma.task.create({
    data: {
      organizationId: org.id,
      projectId: launch.id,
      milestoneId: mvpMilestone.id,
      title: "Tenant billing entitlements",
      description: "Centralized plan/entitlement checks (blocked on auth).",
      status: TaskStatus.BLOCKED,
      priority: TaskPriority.URGENT,
      assignedToUserId: linus.id,
      createdByUserId: grace.id,
      dueDate: daysFromNow(-1), // overdue
    },
  });

  // billing is BLOCKED by auth hardening
  await prisma.taskDependency.create({
    data: {
      organizationId: org.id,
      sourceTaskId: authTask.id,
      targetTaskId: billingTask.id,
      type: DependencyType.BLOCKS,
      createdByUserId: grace.id,
    },
  });

  await prisma.taskComment.createMany({
    data: [
      {
        organizationId: org.id,
        taskId: billingTask.id,
        authorUserId: grace.id,
        body: "Parked until session revocation lands — see the auth task.",
      },
      {
        organizationId: org.id,
        taskId: authTask.id,
        authorUserId: ada.id,
        body: "Rate limiting in review; revocation next.",
      },
    ],
  });

  // ---- Project: Design System -------------------------------------------
  const design = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: "Design System v1",
      description: "Reusable primitives, dark/light tokens, accessibility.",
      status: ProjectStatus.ACTIVE,
      startDate: daysFromNow(-14),
      endDate: daysFromNow(45),
      createdByUserId: ada.id,
    },
  });

  const tokensMilestone = await prisma.milestone.create({
    data: {
      organizationId: org.id,
      projectId: design.id,
      name: "Semantic color tokens",
      dueDate: daysFromNow(14),
      status: MilestoneStatus.ON_TRACK,
      createdByUserId: ada.id,
    },
  });

  await prisma.task.createMany({
    data: [
      {
        organizationId: org.id,
        projectId: design.id,
        milestoneId: tokensMilestone.id,
        title: "Define color + spacing tokens",
        status: TaskStatus.IN_PROGRESS,
        priority: TaskPriority.MEDIUM,
        assignedToUserId: linus.id,
        createdByUserId: ada.id,
        dueDate: daysFromNow(6),
      },
      {
        organizationId: org.id,
        projectId: design.id,
        milestoneId: tokensMilestone.id,
        title: "Build command palette component",
        status: TaskStatus.TODO,
        priority: TaskPriority.LOW,
        assignedToUserId: grace.id,
        createdByUserId: ada.id,
        dueDate: daysFromNow(10),
      },
    ],
  });

  // ---- Notifications ----------------------------------------------------
  await prisma.notification.createMany({
    data: [
      {
        organizationId: org.id,
        recipientUserId: linus.id,
        title: "Task overdue",
        body: "‘Tenant billing entitlements’ is overdue.",
        priority: TaskPriority.URGENT,
        href: `/tasks/${billingTask.id}`,
      },
      {
        organizationId: org.id,
        recipientUserId: grace.id,
        title: "Milestone at risk",
        body: "‘MVP feature-complete’ is now at risk.",
        priority: TaskPriority.HIGH,
        href: `/work-os`,
      },
    ],
  });

  // ---- Notification preferences -----------------------------------------
  // Grace opts into the (future) email digest and mutes status-change noise,
  // exercising the preference-driven filtering in the notification service.
  await prisma.notificationPreference.create({
    data: {
      organizationId: org.id,
      userId: grace.id,
      inAppEnabled: true,
      emailEnabled: true,
      mutedTypes: ["task.status_changed"],
    },
  });

  // ---- Automation rules (deterministic, non-AI) -------------------------
  await prisma.automationRule.createMany({
    data: [
      {
        organizationId: org.id,
        name: "Notify manager on overdue tasks",
        description: "When a task becomes overdue, notify the project manager.",
        enabled: true,
        trigger: AutomationTrigger.TASK_OVERDUE,
        condition: "priority in (HIGH, URGENT)",
        action: AutomationAction.NOTIFY_MANAGER,
        createdByUserId: grace.id,
      },
      {
        organizationId: org.id,
        name: "Advance milestone on task completion",
        description: "When a task is marked DONE, recompute milestone progress.",
        enabled: true,
        trigger: AutomationTrigger.TASK_STATUS_CHANGED,
        condition: "status == DONE",
        action: AutomationAction.UPDATE_MILESTONE_PROGRESS,
        createdByUserId: ada.id,
      },
    ],
  });

  // ---- Activity log sample ---------------------------------------------
  await prisma.activityLog.create({
    data: {
      organizationId: org.id,
      actorUserId: ada.id,
      entityType: "task",
      entityId: rbacTask.id,
      action: "task.completed",
      metadata: { from: "IN_PROGRESS", to: "DONE" },
    },
  });

  console.log("Seed complete.");
  console.log(`  Organization: Northwind Labs (${org.slug})`);
  console.log("  Login with any of:");
  console.log("    ada@northwind.test   / Password123!  (ADMIN)");
  console.log("    grace@northwind.test / Password123!  (MANAGER)");
  console.log("    linus@northwind.test / Password123!  (MEMBER)");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
