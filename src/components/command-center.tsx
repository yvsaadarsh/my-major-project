"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  CheckCircle2,
  Command as CommandIcon,
  FileText,
  Flag,
  FolderKanban,
  KanbanSquare,
  LayoutDashboard,
  Layers,
  LogOut,
  MessageSquare,
  Network,
  Plus,
  Search,
  ShieldCheck,
  Route,
  TrendingUp,
  UserRound,
  UsersRound,
  X,
  Zap,
} from "lucide-react";

import { apiRequest } from "@/lib/ui/api-client";
import {
  groupCommands,
  matchCommands,
  visibleCommands,
  type CommandIconName,
  type PaletteCommand,
} from "@/lib/ui/commands";
import {
  parseSearchQuery,
  splitHighlighted,
  type SearchEntityType,
  type SearchGroup,
  type SearchResult,
} from "@/lib/domain/search";
import type { Role } from "@/lib/ui/permissions";

type SearchResponse = {
  groups: SearchGroup[];
  results: SearchResult[];
  total: number;
  truncated: boolean;
  searchedTypes?: SearchEntityType[];
};

/** Icon per result type. Kept beside the palette since it is purely visual. */
const RESULT_ICONS: Record<SearchEntityType, typeof FileText> = {
  audit: ShieldCheck,
  automation: Zap,
  comment: MessageSquare,
  member: UserRound,
  milestone: Flag,
  project: FolderKanban,
  task: CheckCircle2,
  view: Layers,
};

/** Icon per command, resolved from the registry's string name. */
const COMMAND_ICONS: Record<CommandIconName, typeof FileText> = {
  analytics: TrendingUp,
  automations: Zap,
  dashboard: LayoutDashboard,
  link: Route,
  members: UsersRound,
  notifications: Bell,
  plus: Plus,
  progress: TrendingUp,
  projects: KanbanSquare,
  search: Search,
  signout: LogOut,
  tasks: FileText,
  workos: Network,
};

/** How long to wait after the last keystroke before querying. */
const DEBOUNCE_MS = 180;

/** A single navigable row — either a record or a command. */
type PaletteRow =
  | { kind: "result"; key: string; result: SearchResult }
  | { kind: "command"; key: string; command: PaletteCommand };

/** A rendered section: a header plus its rows. */
type PaletteSection = {
  label: string;
  /** Shown on the right of the header, e.g. "12 matches". */
  meta?: string;
  rows: PaletteRow[];
};

export function CommandCenter({ role = "MEMBER" }: { role?: Role }) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Element focused before opening, so Escape can hand focus back. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const allowedCommands = useMemo(() => visibleCommands(role), [role]);

  // ── Open / close ────────────────────────────────────────────────────────

  const openPalette = useCallback((initial = "") => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    setQuery(initial);
    setActiveIndex(0);
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setQuery("");
    setResponse(null);
    setError(null);
    setActiveIndex(0);
    // Return focus where the user left it, so keyboard flow is not lost.
    restoreFocusRef.current?.focus?.();
  }, []);

  // ── Global shortcuts ────────────────────────────────────────────────────
  // ⌘K / Ctrl+K opens. "/" opens when not already typing somewhere. "?" opens
  // the shortcuts reference. These deliberately ignore keystrokes aimed at an
  // input, textarea, select or contenteditable so typing is never hijacked.
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      );
    }

    function onKeyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase();

      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        setOpen((current) => {
          if (current) {
            return current;
          }
          restoreFocusRef.current = document.activeElement as HTMLElement | null;
          return true;
        });
        return;
      }

      if (open) {
        return;
      }

      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        openPalette();
        return;
      }

      if (event.key === "?") {
        event.preventDefault();
        router.push("/shortcuts");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, openPalette, router]);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => inputRef.current?.focus());
    }
  }, [open]);

  // Lock background scroll while the dialog owns the screen.
  useEffect(() => {
    if (!open) {
      return;
    }

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // ── Debounced fetching ──────────────────────────────────────────────────

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const active = parseSearchQuery(debounced);

    // Command mode (`>`) and too-short queries never hit the network.
    if (!open || active.commandMode || active.phrase.replace(/\s+/g, "").length < 2) {
      setResponse(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    apiRequest<SearchResponse>(`/api/v1/command/search?q=${encodeURIComponent(debounced)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((data) => {
        setResponse(data);
        setActiveIndex(0);
      })
      .catch((caught: unknown) => {
        // An aborted request is the expected outcome of fast typing.
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
        setResponse(null);
        setError("Search is unavailable right now.");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [debounced, open]);

  // ── Sections ────────────────────────────────────────────────────────────
  // Commands come first when the user typed `>` or typed nothing; records come
  // first once there is a real query, since that is what they are hunting for.

  const sections = useMemo<PaletteSection[]>(() => {
    const commandMatches = matchCommands(allowedCommands, parsed, parsed.commandMode ? 12 : 4);
    const commandSections: PaletteSection[] = groupCommands(commandMatches).map((entry) => ({
      label: entry.group,
      rows: entry.commands.map((command) => ({
        command,
        key: `command:${command.id}`,
        kind: "command" as const,
      })),
    }));

    if (parsed.commandMode) {
      return commandSections;
    }

    const resultSections: PaletteSection[] = (response?.groups ?? []).map((group) => ({
      label: group.label,
      meta: group.total > group.results.length ? `${group.total} matches` : undefined,
      rows: group.results.map((result) => ({
        key: `result:${result.type}:${result.id}`,
        kind: "result" as const,
        result,
      })),
    }));

    if (!parsed.phrase) {
      return commandSections;
    }

    return [...resultSections, ...commandSections];
  }, [allowedCommands, parsed, response]);

  /**
   * Flat list the arrow keys walk. Built from the same `sections` the DOM
   * renders, so the highlighted row and the selected row can never diverge.
   */
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  // Clamp the cursor whenever the list shrinks under it.
  useEffect(() => {
    setActiveIndex((current) => {
      if (rows.length === 0) {
        return 0;
      }
      return Math.min(current, rows.length - 1);
    });
  }, [rows.length]);

  // Keep the highlighted row visible without yanking the whole page.
  useEffect(() => {
    const container = listRef.current;
    if (!container) {
      return;
    }

    const node = container.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, rows.length]);

  // ── Running a row ───────────────────────────────────────────────────────

  const runCommand = useCallback(
    async (command: PaletteCommand) => {
      if (command.href) {
        closePalette();
        router.push(command.href);
        return;
      }

      switch (command.action) {
        case "signOut": {
          closePalette();
          try {
            await apiRequest("/api/v1/auth/logout", { method: "POST" });
          } catch {
            // Signing out locally still matters even if the call failed.
          }
          router.push("/");
          return;
        }
        case "copyLink": {
          try {
            await navigator.clipboard.writeText(window.location.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            setError("Clipboard access was denied by the browser.");
          }
          return;
        }
        default:
          closePalette();
      }
    },
    [closePalette, router],
  );

  const activate = useCallback(
    (row: PaletteRow | undefined) => {
      if (!row) {
        return;
      }

      if (row.kind === "command") {
        void runCommand(row.command);
        return;
      }

      closePalette();
      router.push(row.result.href);
    },
    [closePalette, router, runCommand],
  );

  /** Key handling inside the dialog: arrows move, Enter runs, Escape closes. */
  function onDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
      return;
    }

    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setActiveIndex((current) => (rows.length === 0 ? 0 : (current + 1) % rows.length));
      return;
    }

    if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setActiveIndex((current) =>
        rows.length === 0 ? 0 : (current - 1 + rows.length) % rows.length,
      );
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(0, rows.length - 1));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[activeIndex];

      // Enter with no highlighted row falls through to the full search page,
      // so a query is never a dead end.
      if (!row && parsed.phrase) {
        closePalette();
        router.push(`/search?q=${encodeURIComponent(parsed.raw)}`);
        return;
      }

      activate(row);
    }
  }

  const showEmpty = !loading && rows.length === 0;
  const activeRowKey = rows[activeIndex]?.key;

  return (
    <>
      <button
        aria-label="Open command center"
        onClick={() => openPalette()}
        className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-slate-200 transition-all hover:bg-white/[0.1] focus:outline-none focus:ring-2 focus:ring-teal-300/60"
        type="button"
      >
        <CommandIcon size={16} />
        <span className="hidden sm:inline">Search</span>
        <span className="rounded-lg border border-white/10 px-1.5 py-0.5 text-[11px] text-slate-400">
          Ctrl K
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/70 px-3 pt-16 backdrop-blur-sm sm:px-6 sm:pt-24"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closePalette();
            }
          }}
        >
          <div
            aria-label="Command center"
            aria-modal="true"
            className="mx-auto w-full max-w-2xl overflow-hidden rounded-3xl border border-white/10 bg-slate-950 shadow-2xl shadow-black/50 soft-border"
            onKeyDown={onDialogKeyDown}
            role="dialog"
          >
            <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
              <Search className="shrink-0 text-teal-300" size={20} />
              <input
                aria-activedescendant={activeRowKey ? `palette-${activeRowKey}` : undefined}
                aria-autocomplete="list"
                aria-controls="palette-listbox"
                aria-expanded="true"
                aria-label="Search the workspace or run a command"
                className="h-12 min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-slate-600"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tasks, projects, people…  or type > for commands"
                ref={inputRef}
                role="combobox"
                value={query}
              />
              <button
                aria-label="Close command center"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-slate-400 transition-all hover:bg-white/10 hover:text-white"
                onClick={closePalette}
                type="button"
              >
                <X size={18} />
              </button>
            </div>

            {parsed.scope && (
              <p className="border-b border-white/5 bg-teal-300/5 px-4 py-2 text-xs text-teal-200">
                Scoped to {parsed.scope}s. Delete the prefix to search everything.
              </p>
            )}

            <div
              className="max-h-[58vh] overflow-y-auto p-2"
              id="palette-listbox"
              ref={listRef}
              role="listbox"
            >
              {sections.map((section) => (
                <div className="mb-1" key={section.label}>
                  <div className="flex items-center justify-between px-3 pb-1 pt-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                      {section.label}
                    </p>
                    {section.meta && (
                      <p className="text-[11px] text-slate-600">{section.meta}</p>
                    )}
                  </div>

                  {section.rows.map((row) => {
                    const index = rows.findIndex((candidate) => candidate.key === row.key);
                    const active = index === activeIndex;

                    return (
                      <PaletteRowView
                        active={active}
                        key={row.key}
                        onActivate={() => activate(row)}
                        onHover={() => setActiveIndex(index)}
                        row={row}
                      />
                    );
                  })}
                </div>
              ))}

              {showEmpty && (
                <div className="px-4 py-10 text-center text-sm text-slate-500">
                  {error
                    ? error
                    : parsed.phrase
                      ? "Nothing matched in what you have access to."
                      : "Start typing to search, or press Enter on a command above."}
                  {parsed.phrase && !error && (
                    <button
                      className="mt-4 block w-full rounded-2xl border border-white/10 px-4 py-3 text-sm text-slate-300 transition-all hover:bg-white/[0.06] hover:text-white"
                      onClick={() => {
                        closePalette();
                        router.push(`/search?q=${encodeURIComponent(parsed.raw)}`);
                      }}
                      type="button"
                    >
                      Search everything for “{parsed.raw}”
                    </button>
                  )}
                </div>
              )}

              {loading && rows.length === 0 && (
                <div className="px-4 py-10 text-center text-sm text-slate-500">
                  Searching your workspace…
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-white/[0.02] px-4 py-3 text-[11px] text-slate-500">
              <div className="flex flex-wrap items-center gap-3">
                <Hint keys="↑ ↓" label="Navigate" />
                <Hint keys="enter" label="Open" />
                <Hint keys="esc" label="Close" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {copied && <span className="text-teal-300">Link copied</span>}
                {response?.truncated && (
                  <span className="text-amber-300/80">Showing top matches</span>
                )}
                <span className="hidden sm:inline">
                  <code className="text-slate-400">&gt;</code> commands ·{" "}
                  <code className="text-slate-400">#</code> tasks ·{" "}
                  <code className="text-slate-400">/</code> projects ·{" "}
                  <code className="text-slate-400">@</code> people
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** One row in the palette. Rendered as an `option` for assistive tech. */
function PaletteRowView({
  active,
  onActivate,
  onHover,
  row,
}: {
  active: boolean;
  onActivate: () => void;
  onHover: () => void;
  row: PaletteRow;
}) {
  const shared = `flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors ${
    active ? "bg-white/[0.1]" : "hover:bg-white/[0.05]"
  }`;

  if (row.kind === "command") {
    const Icon = COMMAND_ICONS[row.command.icon];

    return (
      <button
        aria-selected={active}
        className={shared}
        data-active={active}
        id={`palette-${row.key}`}
        onClick={onActivate}
        onMouseMove={onHover}
        role="option"
        type="button"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-slate-300">
          <Icon size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white">
          {row.command.label}
        </span>
        {row.command.hint && (
          <span className="shrink-0 rounded-lg border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-500">
            {row.command.hint}
          </span>
        )}
      </button>
    );
  }

  const result = row.result;
  const Icon = RESULT_ICONS[result.type];

  return (
    <button
      aria-selected={active}
      className={shared}
      data-active={active}
      id={`palette-${row.key}`}
      onClick={onActivate}
      onMouseMove={onHover}
      role="option"
      type="button"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.06] text-teal-200">
        <Icon size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-white">
          <Highlighted highlights={result.titleHighlights} text={result.title} />
        </span>
        <span className="block truncate text-xs text-slate-500">
          {result.snippet ? (
            <Highlighted highlights={result.snippetHighlights} text={result.snippet} />
          ) : (
            result.context
          )}
        </span>
      </span>
      <span className="hidden shrink-0 text-right text-[11px] text-slate-600 sm:block">
        {result.context}
      </span>
    </button>
  );
}

/**
 * Render matched ranges as marked spans. Uses the domain layer's segment split
 * rather than `dangerouslySetInnerHTML`, so user content can never inject markup.
 */
function Highlighted({
  highlights,
  text,
}: {
  highlights: Array<{ start: number; end: number }>;
  text: string;
}) {
  const parts = splitHighlighted(text, highlights);

  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark
            className="rounded bg-teal-300/20 px-0.5 text-teal-100"
            key={`${index}-${part.text}`}
          >
            {part.text}
          </mark>
        ) : (
          <span key={`${index}-${part.text}`}>{part.text}</span>
        ),
      )}
    </>
  );
}

function Hint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="inline-flex items-center rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-400">
        {keys}
      </kbd>
      {label}
    </span>
  );
}
