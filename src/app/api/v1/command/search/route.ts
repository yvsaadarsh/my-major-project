import type { NextRequest } from "next/server";

import { json } from "@/lib/api/http";
import { withTenantGuard } from "@/lib/api/tenant-guard";
import { prisma } from "@/lib/db";
import { hasPermission, Permission } from "@/lib/rbac";
import {
  buildSnippet,
  FieldWeight,
  findHighlights,
  groupResults,
  isSearchable,
  parseSearchQuery,
  rankResults,
  scoreRecord,
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchResult,
} from "@/lib/domain/search";

/**
 * Global search.
 *
 * Two hard rules shape this handler:
 *
 * 1. **Tenant isolation.** Every query is filtered by the server-derived
 *    `organizationId` from the guard. No id ever comes from the query string.
 *
 * 2. **Per-entity permissions.** A single blanket permission would leak: a
 *    MEMBER who cannot read the audit log must not find audit entries by typing
 *    their contents. Each entity type declares the permission required to
 *    appear in results, and a role missing it never triggers the query at all —
 *    the row is not fetched, not scored, not counted.
 *
 * Candidate narrowing happens in Postgres (case-insensitive `contains`), so a
 * large tenant does not stream its whole task table into memory. The pure
 * domain layer then ranks the narrowed set and builds highlighted snippets.
 */

/** Permission required for a type to appear in results. */
const ENTITY_PERMISSION: Record<SearchEntityType, Permission> = {
  audit: Permission.AuditRead,
  automation: Permission.AutomationsRead,
  comment: Permission.TasksRead,
  member: Permission.MembersRead,
  milestone: Permission.ProjectsRead,
  project: Permission.ProjectsRead,
  task: Permission.TasksRead,
  view: Permission.ProjectsRead,
};

/** How many rows per type Postgres may return before ranking. */
const CANDIDATE_LIMIT = 40;

/** Ceiling on the flat result list handed back to the client. */
const RESULT_LIMIT = 40;

function parseTypeFilter(raw: string | null): SearchEntityType[] | null {
  if (!raw) {
    return null;
  }

  const requested = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);

  const valid = SEARCH_ENTITY_TYPES.filter((type) =>
    requested.includes(type),
  );

  return valid.length > 0 ? valid : null;
}

export const GET = withTenantGuard(Permission.DashboardRead, async (request: NextRequest, tenant) => {
  const params = request.nextUrl.searchParams;
  const parsed = parseSearchQuery(params.get("q") ?? "");
  const organizationId = tenant.tenantId;

  if (!isSearchable(parsed) || parsed.commandMode) {
    // `>` puts the palette into command mode, which is entirely client-side.
    return json({
      groups: [],
      query: parsed.raw,
      results: [],
      scope: parsed.scope,
      total: 0,
      truncated: false,
    });
  }

  // Which types may we search? Intersection of: role permissions, the scope
  // prefix the user typed, and any explicit `?types=` filter from the UI.
  const requestedTypes = parseTypeFilter(params.get("types"));
  const allowedTypes = SEARCH_ENTITY_TYPES.filter((type) => {
    if (!hasPermission(tenant.role, ENTITY_PERMISSION[type])) {
      return false;
    }
    if (parsed.scope && parsed.scope !== type) {
      return false;
    }
    if (requestedTypes && !requestedTypes.includes(type)) {
      return false;
    }
    return true;
  });

  const wanted = new Set<SearchEntityType>(allowedTypes);

  // Postgres does the narrowing. `mode: "insensitive"` maps to ILIKE.
  const like = { contains: parsed.phrase, mode: "insensitive" as const };

  // A project scope filter lets the /search page restrict to one project.
  const projectFilter = params.get("projectId");
  const projectScope = projectFilter ? { projectId: projectFilter } : {};

  const [projects, tasks, comments, members, milestones, views, automations, auditLogs] =
    await Promise.all([
      wanted.has("project")
        ? prisma.project.findMany({
            where: {
              organizationId,
              ...(projectFilter ? { id: projectFilter } : {}),
              OR: [{ name: like }, { description: like }],
            },
            orderBy: { updatedAt: "desc" },
            take: CANDIDATE_LIMIT,
            select: { id: true, name: true, description: true, status: true },
          })
        : Promise.resolve([]),

      wanted.has("task")
        ? prisma.task.findMany({
            where: {
              organizationId,
              ...projectScope,
              OR: [{ title: like }, { description: like }],
            },
            orderBy: { updatedAt: "desc" },
            take: CANDIDATE_LIMIT,
            select: {
              id: true,
              title: true,
              description: true,
              status: true,
              priority: true,
              project: { select: { id: true, name: true } },
              assignedTo: { select: { name: true } },
            },
          })
        : Promise.resolve([]),

      wanted.has("comment")
        ? prisma.taskComment.findMany({
            where: {
              organizationId,
              body: like,
              ...(projectFilter ? { task: { projectId: projectFilter } } : {}),
            },
            orderBy: { createdAt: "desc" },
            take: CANDIDATE_LIMIT,
            select: {
              id: true,
              body: true,
              taskId: true,
              task: { select: { title: true } },
              author: { select: { name: true } },
            },
          })
        : Promise.resolve([]),

      wanted.has("member")
        ? prisma.organizationMember.findMany({
            where: {
              organizationId,
              OR: [{ user: { name: like } }, { user: { email: like } }],
            },
            take: CANDIDATE_LIMIT,
            select: {
              role: true,
              status: true,
              user: { select: { id: true, name: true, email: true } },
            },
          })
        : Promise.resolve([]),

      wanted.has("milestone")
        ? prisma.milestone.findMany({
            where: {
              organizationId,
              ...projectScope,
              OR: [{ name: like }, { description: like }],
            },
            orderBy: { dueDate: "asc" },
            take: CANDIDATE_LIMIT,
            select: {
              id: true,
              name: true,
              description: true,
              status: true,
              dueDate: true,
              project: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),

      wanted.has("view")
        ? prisma.savedView.findMany({
            where: {
              organizationId,
              name: like,
              // A member sees their own views plus anything shared with the org.
              OR: [{ ownerUserId: tenant.user.id }, { isShared: true }],
            },
            orderBy: { updatedAt: "desc" },
            take: CANDIDATE_LIMIT,
            select: {
              id: true,
              name: true,
              viewType: true,
              isShared: true,
              projectId: true,
              project: { select: { name: true } },
            },
          })
        : Promise.resolve([]),

      wanted.has("automation")
        ? prisma.automationRule.findMany({
            where: {
              organizationId,
              OR: [{ name: like }, { description: like }, { condition: like }],
            },
            orderBy: { updatedAt: "desc" },
            take: CANDIDATE_LIMIT,
            select: {
              id: true,
              name: true,
              description: true,
              enabled: true,
              trigger: true,
              action: true,
            },
          })
        : Promise.resolve([]),

      wanted.has("audit")
        ? prisma.activityLog.findMany({
            where: {
              organizationId,
              OR: [{ action: like }, { entityType: like }],
            },
            orderBy: { createdAt: "desc" },
            take: CANDIDATE_LIMIT,
            select: {
              id: true,
              action: true,
              entityType: true,
              entityId: true,
              createdAt: true,
              actor: { select: { name: true } },
            },
          })
        : Promise.resolve([]),
    ]);

  const results: SearchResult[] = [];

  /** Shared assembly: score, snippet, highlight, push if it matched. */
  function push(input: {
    id: string;
    type: SearchEntityType;
    title: string;
    context: string;
    href: string;
    body?: string | null;
    metadata?: string | null;
    secondary?: string | null;
  }) {
    const scored = scoreRecord(
      [
        { value: input.title, weight: FieldWeight.title },
        { value: input.secondary, weight: FieldWeight.secondary },
        { value: input.body, weight: FieldWeight.body },
        { value: input.metadata, weight: FieldWeight.metadata },
      ],
      parsed,
    );

    if (scored.score <= 0) {
      return;
    }

    // Prefer the body for the snippet; fall back to the context line so a
    // title-only match still shows something useful under the title.
    const snippetSource = input.body?.trim() ? input.body : input.secondary ?? "";
    const snippet = buildSnippet(snippetSource, parsed);

    results.push({
      context: input.context,
      href: input.href,
      id: input.id,
      reasons: scored.reasons,
      score: scored.score,
      snippet: snippet.text,
      snippetHighlights: snippet.highlights,
      title: input.title,
      titleHighlights: findHighlights(input.title, parsed),
      type: input.type,
    });
  }

  for (const project of projects) {
    push({
      body: project.description,
      context: `Project · ${project.status}`,
      href: `/projects?projectId=${project.id}`,
      id: project.id,
      metadata: project.status,
      title: project.name,
      type: "project",
    });
  }

  for (const task of tasks) {
    push({
      body: task.description,
      context: `${task.project.name} · ${task.status}`,
      href: `/tasks/${task.id}`,
      id: task.id,
      metadata: `${task.priority} ${task.status}`,
      secondary: task.assignedTo?.name ?? null,
      title: task.title,
      type: "task",
    });
  }

  for (const comment of comments) {
    push({
      body: comment.body,
      context: `Comment by ${comment.author.name} on ${comment.task.title}`,
      href: `/tasks/${comment.taskId}`,
      id: comment.id,
      title: comment.task.title,
      type: "comment",
    });
  }

  for (const member of members) {
    push({
      context: `${member.role} · ${member.status}`,
      href: `/members?userId=${member.user.id}`,
      id: member.user.id,
      metadata: member.role,
      secondary: member.user.email,
      title: member.user.name,
      type: "member",
    });
  }

  for (const milestone of milestones) {
    push({
      body: milestone.description,
      context: `${milestone.project.name} · due ${milestone.dueDate.toISOString().slice(0, 10)}`,
      href: `/projects?projectId=${milestone.project.id}&milestoneId=${milestone.id}`,
      id: milestone.id,
      metadata: milestone.status,
      title: milestone.name,
      type: "milestone",
    });
  }

  for (const view of views) {
    push({
      context: `${view.project?.name ?? "Organization"} · ${view.viewType}${
        view.isShared ? " · shared" : ""
      }`,
      href: view.projectId ? `/projects?projectId=${view.projectId}&viewId=${view.id}` : "/projects",
      id: view.id,
      metadata: view.viewType,
      title: view.name,
      type: "view",
    });
  }

  for (const rule of automations) {
    push({
      body: rule.description,
      context: `${rule.trigger} → ${rule.action}${rule.enabled ? "" : " · disabled"}`,
      href: `/automations?ruleId=${rule.id}`,
      id: rule.id,
      metadata: `${rule.trigger} ${rule.action}`,
      title: rule.name,
      type: "automation",
    });
  }

  for (const log of auditLogs) {
    push({
      context: `${log.entityType} · ${log.actor.name} · ${log.createdAt
        .toISOString()
        .slice(0, 10)}`,
      href: `/work-os?entityId=${log.entityId}`,
      id: log.id,
      metadata: log.entityType,
      title: log.action,
      type: "audit",
    });
  }

  const ranked = rankResults(results, RESULT_LIMIT);
  // groupResults already attaches the display label from the domain layer, so
  // the client never has to keep its own copy of the type→label mapping.
  const groups = groupResults(ranked, 5);

  return json({
    groups,
    query: parsed.raw,
    results: ranked,
    scope: parsed.scope,
    // Types the caller's role actually allowed, so the UI can explain gaps.
    searchedTypes: allowedTypes,
    total: results.length,
    // True when a candidate query hit its cap, so results may be incomplete.
    truncated:
      projects.length === CANDIDATE_LIMIT ||
      tasks.length === CANDIDATE_LIMIT ||
      comments.length === CANDIDATE_LIMIT ||
      milestones.length === CANDIDATE_LIMIT ||
      automations.length === CANDIDATE_LIMIT ||
      auditLogs.length === CANDIDATE_LIMIT,
  });
});
