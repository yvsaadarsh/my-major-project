/**
 * TEST DOUBLE — the enum surface of the generated Prisma client.
 *
 * Substituted via `tsconfig.test.json` so the AI route tests run without a
 * database or a `prisma generate` step. Values mirror `prisma/schema.prisma`.
 */
export enum MembershipRole { ADMIN = "ADMIN", MANAGER = "MANAGER", MEMBER = "MEMBER" }
export enum MembershipStatus { ACTIVE = "ACTIVE", INVITED = "INVITED", DISABLED = "DISABLED" }
export enum TaskStatus { TODO = "TODO", IN_PROGRESS = "IN_PROGRESS", BLOCKED = "BLOCKED", DONE = "DONE" }
export enum TaskPriority { LOW = "LOW", MEDIUM = "MEDIUM", HIGH = "HIGH", URGENT = "URGENT" }
export enum MilestoneStatus { PLANNED = "PLANNED", ON_TRACK = "ON_TRACK", AT_RISK = "AT_RISK", MISSED = "MISSED", DONE = "DONE" }
export enum AutomationRunStatus { SUCCESS = "SUCCESS", FAILED = "FAILED", SKIPPED = "SKIPPED" }
export enum LoginOutcome { SUCCESS = "SUCCESS", INVALID_PASSWORD = "INVALID_PASSWORD", UNKNOWN_EMAIL = "UNKNOWN_EMAIL", LOCKED = "LOCKED" }
export type User = Record<string, unknown>;
export type Organization = Record<string, unknown>;
export type OrganizationMember = Record<string, unknown>;
export declare class PrismaClient { constructor(options?: unknown); }
