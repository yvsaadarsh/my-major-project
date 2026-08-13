"use client";

import { useMemo } from "react";

import { AppShell } from "@/components/app-shell";
import { InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { useAuthSession } from "@/lib/ui/use-auth-session";
import { GOTO_SHORTCUTS } from "@/lib/ui/commands";
import { can } from "@/lib/ui/permissions";

/**
 * Keyboard reference, reachable with `?` from anywhere.
 *
 * The "Go to" table is generated from the same `GOTO_SHORTCUTS` array the key
 * handler reads, so this page cannot document a shortcut that does not work (or
 * miss one that does). Destinations the current role cannot reach are omitted
 * rather than listed and broken.
 */

type Shortcut = { keys: string[]; label: string; note?: string };

const GLOBAL: Shortcut[] = [
  { keys: ["Ctrl", "K"], label: "Open the command palette", note: "⌘K on macOS" },
  { keys: ["/"], label: "Open the palette focused on search" },
  { keys: ["?"], label: "Open this shortcuts reference" },
  { keys: ["g", "then a key"], label: "Jump to a section", note: "See the table below" },
];

const PALETTE: Shortcut[] = [
  { keys: ["↑", "↓"], label: "Move through results and commands" },
  { keys: ["Ctrl", "P / N"], label: "Move up / down without leaving home row" },
  { keys: ["Enter"], label: "Open the highlighted row" },
  { keys: ["Enter"], label: "Search everything", note: "When no row is highlighted" },
  { keys: ["Home", "End"], label: "Jump to first / last row" },
  { keys: ["Esc"], label: "Close and return focus where you left it" },
];

const PREFIXES: Shortcut[] = [
  { keys: [">"], label: "Commands only", note: "> new task" },
  { keys: ["#"], label: "Tasks only", note: "#login bug" },
  { keys: ["/"], label: "Projects only", note: "/roadmap" },
  { keys: ["@"], label: "People only", note: "@priya" },
  { keys: ["~"], label: "Comments only", note: "~needs review" },
  { keys: ["!"], label: "Milestones only", note: "!beta launch" },
];

export default function ShortcutsPage() {
  const { error, loading, organization, role } = useAuthSession({ requireOrganization: true });

  // Only advertise jumps this role can actually make.
  const gotos = useMemo(
    () => GOTO_SHORTCUTS.filter((entry) => !entry.permission || can(role, entry.permission)),
    [role],
  );

  if (loading) {
    return <LoadingState label="Loading shortcuts" />;
  }

  return (
    <AppShell
      description="Every keystroke this workspace understands. Shortcuts are ignored while you are typing in a field, so they never interrupt writing."
      eyebrow="Keyboard first"
      organizationName={organization?.name}
      role={role}
      title="Keyboard shortcuts"
    >
      <div className="space-y-6">
        {error && <InlineError message={error} />}

        <div className="grid gap-6 lg:grid-cols-2">
          <ShortcutTable items={GLOBAL} title="Anywhere in the app" />
          <ShortcutTable items={PALETTE} title="Inside the command palette" />
        </div>

        <SectionCard>
          <h2 className="text-sm font-semibold text-white">Go to</h2>
          <p className="mt-1 text-xs text-slate-500">
            Press <Key>g</Key>, release, then the destination key. The prefix expires after a
            moment, so a stray press cannot hijack your next keystroke.
          </p>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {gotos.map((entry) => (
              <div
                className="flex items-center justify-between gap-3 rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-2.5"
                key={entry.key}
              >
                <span className="text-sm text-slate-300">{entry.label}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Key>g</Key>
                  <Key>{entry.key}</Key>
                </span>
              </div>
            ))}
          </div>
        </SectionCard>

        <ShortcutTable
          items={PREFIXES}
          title="Search prefixes"
          subtitle="Type these as the first character of a query to narrow it without leaving the input."
        />

        <SectionCard>
          <h2 className="text-sm font-semibold text-white">What search can see</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Search results are always scoped to your active organization, and each record type is
            gated on its own permission. If your role cannot read the activity log, audit entries
            are never queried — not fetched, not ranked, not counted in totals. Hiding a row in the
            palette is a convenience; the server enforces the boundary regardless of what the UI
            shows.
          </p>
        </SectionCard>
      </div>
    </AppShell>
  );
}

function ShortcutTable({
  items,
  subtitle,
  title,
}: {
  items: Shortcut[];
  subtitle?: string;
  title: string;
}) {
  return (
    <SectionCard>
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {subtitle && <p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p>}

      <ul className="mt-4 space-y-2">
        {items.map((item) => (
          <li
            className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-2.5"
            key={`${item.label}-${item.keys.join("-")}-${item.note ?? ""}`}
          >
            <span className="min-w-0">
              <span className="block text-sm text-slate-300">{item.label}</span>
              {item.note && (
                <span className="block text-[11px] text-slate-600">{item.note}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {item.keys.map((key) => (
                <Key key={key}>{key}</Key>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1 text-[11px] font-medium text-slate-200">
      {children}
    </kbd>
  );
}
