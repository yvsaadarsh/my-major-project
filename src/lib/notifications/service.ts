/**
 * Notification service (infrastructure). Server-only: performs Prisma writes.
 *
 * Centralizes two policies so every producer (automations today, more later)
 * honors them:
 *   1. Recipient preferences — respect `inAppEnabled` and `mutedTypes`.
 *   2. Dedupe — never stack a second *unread* notification with the same
 *      (recipient, dedupeKey). This is the application-level guard called out in
 *      the schema (a partial-unique on dedupeKey is hard to do portably).
 */
import {
  MembershipRole,
  MembershipStatus,
  type Prisma,
  type TaskPriority,
} from "@/generated/prisma/client";

export type CreateNotificationInput = {
  organizationId: string;
  recipientUserId: string;
  type: string;
  title: string;
  body: string;
  href: string;
  priority: TaskPriority;
  dedupeKey?: string | null;
};

export type CreateNotificationResult = {
  created: boolean;
  reason?: "muted" | "in_app_disabled" | "duplicate";
};

/**
 * Creates a notification unless the recipient muted it or an identical unread one
 * already exists. Returns whether a row was written (and why not, if skipped).
 */
export async function createNotification(
  tx: Prisma.TransactionClient,
  input: CreateNotificationInput,
): Promise<CreateNotificationResult> {
  const preference = await tx.notificationPreference.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.organizationId,
        userId: input.recipientUserId,
      },
    },
    select: { inAppEnabled: true, mutedTypes: true },
  });

  if (preference) {
    if (!preference.inAppEnabled) {
      return { created: false, reason: "in_app_disabled" };
    }
    if (preference.mutedTypes.includes(input.type)) {
      return { created: false, reason: "muted" };
    }
  }

  if (input.dedupeKey) {
    const existing = await tx.notification.findFirst({
      where: {
        organizationId: input.organizationId,
        recipientUserId: input.recipientUserId,
        dedupeKey: input.dedupeKey,
        readAt: null,
      },
      select: { id: true },
    });

    if (existing) {
      return { created: false, reason: "duplicate" };
    }
  }

  await tx.notification.create({
    data: {
      organizationId: input.organizationId,
      recipientUserId: input.recipientUserId,
      type: input.type,
      title: input.title,
      body: input.body,
      href: input.href,
      priority: input.priority,
      dedupeKey: input.dedupeKey ?? null,
    },
  });

  return { created: true };
}

/**
 * Active ADMIN/MANAGER members of a tenant — the audience for `NOTIFY_MANAGER`.
 * Always scoped by `organizationId`, so it can never leak across tenants.
 */
export async function resolveManagerRecipients(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<string[]> {
  const managers = await tx.organizationMember.findMany({
    where: {
      organizationId,
      status: MembershipStatus.ACTIVE,
      role: { in: [MembershipRole.ADMIN, MembershipRole.MANAGER] },
    },
    select: { userId: true },
  });

  return managers.map((member) => member.userId);
}
