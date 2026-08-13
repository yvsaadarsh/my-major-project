/**
 * Command registry for the ⌘K palette.
 *
 * Plain data plus pure filtering — no React, no fetch, no side effects. Every
 * command is either a navigation target or a named client action the palette
 * knows how to run, so nothing here can execute arbitrary code.
 *
 * Permissions are advisory only: this hides commands a role cannot use so the
 * palette stays honest, but the server still enforces every mutation. Hiding a
 * command is a UX nicety, never the security boundary.
 */

import { can, type Permission, type Role } from "@/lib/ui/permissions";
import { normalizeText, type ParsedQuery } from "@/lib/domain/search";

/**
 * Client actions the palette can perform without a server round trip.
 * A closed union rather than a callback, so the palette resolves actions through
 * a `switch` and can never be handed an arbitrary function to execute.
 */
export type CommandAction = "signOut" | "copyLink" | "createTaskAI";

export type CommandGroupName = "Navigate" | "Create" | "Workspace" | "Account";

export type PaletteCommand = {
  id: string;
  label: string;
  /** Extra words that should match this command but need not be displayed. */
  keywords: string[];
  group: CommandGroupName;
  /** Icon name resolved by the palette; keeps this module React-free. */
  icon: CommandIconName;
  /** Where to go. Mutually exclusive with `action`. */
  href?: string;
  /** What to run. Mutually exclusive with `href`. */
  action?: CommandAction;
  /** Hidden entirely when the active role lacks this permission. */
  permission?: Permission;
  /** Rendered on the right as a shortcut hint, e.g. "G then P". */
  hint?: string;
};

/**
 * Icon names the palette maps to lucide components. Declared as a union so a
 * typo becomes a compile error rather than a blank square at runtime.
 */
export type CommandIconName =
  | "dashboard"
  | "projects"
  | "tasks"
  | "analytics"
  | "workos"
  | "progress"
  | "automations"
  | "notifications"
  | "members"
  | "search"
  | "plus"
  | "sparkles"
  | "signout"
  | "link";

/**
 * The full command list. Order inside each group is the order shown, so the
 * most-used destinations come first rather than being alphabetized.
 */
export const PALETTE_COMMANDS: PaletteCommand[] = [
  // ── Navigate ────────────────────────────────────────────────────────────
  {
    group: "Navigate",
    hint: "G D",
    icon: "dashboard",
    id: "nav.dashboard",
    keywords: ["home", "overview", "start"],
    label: "Go to Dashboard",
    href: "/dashboard",
  },
  {
    group: "Navigate",
    hint: "G P",
    icon: "projects",
    id: "nav.projects",
    keywords: ["board", "kanban", "list", "timeline", "views"],
    label: "Go to Projects",
    href: "/projects",
  },
  {
    group: "Navigate",
    hint: "G A",
    icon: "analytics",
    id: "nav.analytics",
    keywords: ["reports", "throughput", "cycle time", "charts", "metrics"],
    label: "Go to Analytics",
    href: "/analytics",
    permission: "dashboard:read",
  },
  {
    group: "Navigate",
    hint: "G W",
    icon: "workos",
    id: "nav.workos",
    keywords: ["health", "risk", "dependencies", "milestones"],
    label: "Go to Work OS",
    href: "/work-os",
  },
  {
    group: "Navigate",
    icon: "progress",
    id: "nav.progress",
    keywords: ["me", "my work", "personal", "workload"],
    label: "Go to Your Progress",
    href: "/progress",
  },
  {
    group: "Navigate",
    icon: "automations",
    id: "nav.automations",
    keywords: ["rules", "triggers", "workflow"],
    label: "Go to Automations",
    href: "/automations",
    permission: "automations:read",
  },
  {
    group: "Navigate",
    icon: "notifications",
    id: "nav.notifications",
    keywords: ["inbox", "alerts", "unread", "bell"],
    label: "Go to Notifications",
    href: "/notifications",
    permission: "notifications:read",
  },
  {
    group: "Navigate",
    hint: "G M",
    icon: "members",
    id: "nav.members",
    keywords: ["people", "team", "roles", "invite", "access"],
    label: "Go to Members",
    href: "/members",
    permission: "members:read",
  },
  {
    group: "Navigate",
    icon: "search",
    id: "nav.search",
    keywords: ["find", "lookup", "advanced search", "filters"],
    label: "Open full search",
    href: "/search",
  },

  // ── Create ──────────────────────────────────────────────────────────────
  {
    group: "Create",
    icon: "plus",
    id: "create.project",
    keywords: ["new project", "add project", "start project"],
    label: "New project",
    href: "/projects?new=project",
    permission: "projects:create",
  },
  {
    group: "Create",
    icon: "plus",
    id: "create.task",
    keywords: ["new task", "add task", "add work", "ticket", "issue"],
    label: "New task",
    href: "/projects?new=task",
    permission: "tasks:create",
  },
  {
    group: "Create",
    icon: "sparkles",
    id: "create.task.ai",
    keywords: ["ai task", "describe task", "natural language", "smart add", "quick add", "parse task"],
    label: "Create task with AI",
    action: "createTaskAI",
    permission: "tasks:create",
  },
  {
    group: "Create",
    icon: "plus",
    id: "create.automation",
    keywords: ["new rule", "add automation", "trigger"],
    label: "New automation rule",
    href: "/automations?new=rule",
    permission: "automations:manage",
  },
  {
    group: "Create",
    icon: "plus",
    id: "create.invite",
    keywords: ["invite member", "add teammate", "add user"],
    label: "Invite a member",
    href: "/members?invite=1",
    permission: "members:manage",
  },

  // ── Workspace ───────────────────────────────────────────────────────────
  {
    group: "Workspace",
    icon: "notifications",
    id: "workspace.unread",
    keywords: ["unread only", "inbox filter"],
    label: "Show unread notifications",
    href: "/notifications?unread=1",
    permission: "notifications:read",
  },
  {
    group: "Workspace",
    icon: "link",
    id: "workspace.copyLink",
    keywords: ["share", "url", "copy url", "permalink"],
    label: "Copy link to this page",
    action: "copyLink",
  },

  // ── Account ─────────────────────────────────────────────────────────────
  {
    group: "Account",
    icon: "signout",
    id: "account.signOut",
    keywords: ["log out", "logout", "leave", "exit"],
    label: "Sign out",
    action: "signOut",
  },
];

/** Order groups render in. Fixed so the palette layout never reshuffles. */
export const COMMAND_GROUP_ORDER: CommandGroupName[] = [
  "Navigate",
  "Create",
  "Workspace",
  "Account",
];

/**
 * Commands the given role is allowed to see, in declaration order.
 * Called before any matching so a hidden command can never be surfaced by a
 * lucky keyword.
 */
export function visibleCommands(role: Role): PaletteCommand[] {
  return PALETTE_COMMANDS.filter(
    (command) => !command.permission || can(role, command.permission),
  );
}

/**
 * Match commands against the parsed query. Scoring is simple and local — the
 * command list is small and fixed, so this never needs the full search ranker:
 *   - label starts with the query   → 100
 *   - label contains the query      → 70
 *   - a keyword starts with a term  → 45
 *   - a keyword contains a term     → 25
 * Ties break on declaration order, which encodes "most used first".
 */
export function matchCommands(
  commands: PaletteCommand[],
  parsed: ParsedQuery,
  limit = 8,
): PaletteCommand[] {
  if (!parsed.phrase) {
    return commands.slice(0, limit);
  }

  const scored = commands.map((command, index) => {
    const label = normalizeText(command.label);
    let score = 0;

    if (label.startsWith(parsed.phrase)) {
      score = 100;
    } else if (label.includes(parsed.phrase)) {
      score = 70;
    }

    if (score === 0) {
      const keywords = command.keywords.map(normalizeText);
      for (const term of parsed.terms) {
        if (keywords.some((keyword) => keyword.startsWith(term))) {
          score = Math.max(score, 45);
          continue;
        }
        if (keywords.some((keyword) => keyword.includes(term))) {
          score = Math.max(score, 25);
        }
      }
    }

    return { command, index, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.command);
}

/** Bucket matched commands into their groups, dropping empty ones. */
export function groupCommands(
  commands: PaletteCommand[],
): Array<{ group: CommandGroupName; commands: PaletteCommand[] }> {
  return COMMAND_GROUP_ORDER.map((group) => ({
    commands: commands.filter((command) => command.group === group),
    group,
  })).filter((entry) => entry.commands.length > 0);
}

// ---------------------------------------------------------------------------
// "G then <key>" navigation shortcuts
// ---------------------------------------------------------------------------

/**
 * Two-stroke navigation: press `g`, then a letter. Kept as data so the shortcuts
 * page and the key handler can never drift apart — both read this map.
 */
export const GOTO_SHORTCUTS: Array<{
  key: string;
  href: string;
  label: string;
  permission?: Permission;
}> = [
  { href: "/dashboard", key: "d", label: "Dashboard" },
  { href: "/projects", key: "p", label: "Projects" },
  { href: "/analytics", key: "a", label: "Analytics", permission: "dashboard:read" },
  { href: "/intelligence", key: "i", label: "Intelligence", permission: "dashboard:read" },
  { href: "/work-os", key: "w", label: "Work OS" },
  { href: "/progress", key: "y", label: "Your Progress" },
  { href: "/notifications", key: "n", label: "Notifications", permission: "notifications:read" },
  { href: "/members", key: "m", label: "Members", permission: "members:read" },
  { href: "/search", key: "s", label: "Search" },
];

export function resolveGoto(role: Role, key: string): string | null {
  const target = GOTO_SHORTCUTS.find((entry) => entry.key === key.toLowerCase());
  if (!target) {
    return null;
  }

  if (target.permission && !can(role, target.permission)) {
    return null;
  }

  return target.href;
}
