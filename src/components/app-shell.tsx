"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Bell,
  BarChart3,
  CheckCircle2,
  Boxes,
  Command,
  Compass,
  Gauge,
  KanbanSquare,
  LayoutDashboard,
  Network,
  Search,
  UserRoundCog,
  UsersRound,
  TrendingUp,
  LogOut,
  Zap,
} from "lucide-react";

import { apiRequest } from "@/lib/ui/api-client";
import { CommandCenter } from "@/components/command-center";
import { NotificationsBell } from "@/components/notifications-bell";
import { useGotoShortcuts } from "@/lib/ui/use-goto-shortcuts";

import { can, roleDescription, roleLabel, type Permission, type Role } from "@/lib/ui/permissions";

type NavItem = {
  href: string;
  icon: typeof LayoutDashboard;
  label: string;
  permission?: Permission;
};

const navItems: NavItem[] = [
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/search", icon: Search, label: "Search" },
  { href: "/work-os", icon: Network, label: "Work OS" },
  { href: "/analytics", icon: BarChart3, label: "Analytics", permission: "dashboard:read" },
  { href: "/intelligence", icon: Gauge, label: "Intelligence", permission: "dashboard:read" },
  { href: "/progress", icon: TrendingUp, label: "Your Progress" },
  { href: "/projects", icon: KanbanSquare, label: "Projects" },
  { href: "/tasks/latest", icon: CheckCircle2, label: "Task View" },
  { href: "/automations", icon: Zap, label: "Automations", permission: "automations:read" },
  { href: "/notifications", icon: Bell, label: "Notifications", permission: "notifications:read" },
  { href: "/members", icon: UsersRound, label: "Members" },
  { href: "/shortcuts", icon: Command, label: "Shortcuts" },
  { href: "/onboarding", icon: Compass, label: "Onboarding" },
];

type AppShellProps = {
  children: React.ReactNode;
  eyebrow: string;
  organizationName?: string;
  role: Role;
  title: string;
  description: string;
};

export function AppShell({
  children,
  eyebrow,
  organizationName = "No organization",
  role,
  title,
  description,
}: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  // "g" then a key jumps between sections without touching the mouse.
  const gotoPending = useGotoShortcuts(role);

  async function handleSignOut() {
    try {
      await apiRequest("/api/v1/auth/logout", { method: "POST" });
    } catch {}
    router.push("/");
  }

  const visibleNavItems = navItems.filter((item) => {
    if (item.label === "Onboarding") {
      return !organizationName || organizationName === "No organization";
    }
    if (item.permission) {
      return can(role, item.permission);
    }
    return true;
  });

  return (
    <div className="dark-grid min-h-screen text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl gap-6 px-4 py-4 sm:px-6 lg:px-8">
        <aside className="hidden w-72 shrink-0 flex-col rounded-[2rem] border border-white/10 bg-slate-950/70 p-4 soft-border backdrop-blur-xl lg:flex">
          <Link href="/dashboard" className="group flex items-center gap-3 p-2">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-teal-400 text-slate-950 shadow-lg shadow-teal-950/40 transition-transform group-hover:scale-105">
              <Boxes size={20} />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-wide text-white">Northstar</p>
              <p className="text-xs text-slate-400">{organizationName}</p>
            </div>
          </Link>

          <nav className="mt-8 space-y-1">
            {visibleNavItems.map((item) => {
              const active = pathname === item.href;
              const Icon = item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-medium transition-all duration-200 ${
                    active
                      ? "bg-white text-slate-950 shadow-xl shadow-black/20"
                      : "text-slate-400 hover:bg-white/8 hover:text-white"
                  }`}
                >
                  <Icon size={18} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="mt-auto rounded-3xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Active role</p>
                <p className="mt-2 text-lg font-semibold text-white">{roleLabel(role)}</p>
                <p className="mt-1 text-sm leading-6 text-slate-400">{roleDescription(role)}</p>
              </div>
              <UserRoundCog className="text-teal-300" size={20} />
            </div>
            <div className="mt-4 rounded-2xl bg-white/[0.04] px-3 py-2 text-xs leading-5 text-slate-400">
              UI permissions are derived from your active organization membership.
            </div>
            
            <button 
              onClick={handleSignOut}
              className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-400 transition-all hover:bg-red-500/20"
            >
              <LogOut size={18} />
              Sign Out
            </button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="rounded-[2rem] border border-white/10 bg-slate-950/60 p-5 soft-border backdrop-blur-xl">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-teal-300">
                  {eyebrow}
                </p>
                <h1 className="mt-3 text-3xl font-semibold tracking-normal text-white sm:text-4xl">
                  {title}
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">{description}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <CommandCenter role={role} />
                <NotificationsBell />
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                  <p className="text-xs text-slate-500">Tenant</p>
                  <p className="text-sm font-semibold text-white">{organizationName}</p>
                </div>
                <div className="rounded-2xl border border-teal-300/30 bg-teal-300/10 px-4 py-3 text-teal-100">
                  <p className="text-xs text-teal-200/70">Role view</p>
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    {roleLabel(role)}
                    <ArrowUpRight size={14} />
                  </p>
                </div>
              </div>
            </div>
          </header>

          <div className="mt-6">{children}</div>
        </main>
      </div>

      {/* Live confirmation that the "g" prefix was captured, so the second
          keystroke never feels like a guess. */}
      {gotoPending && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-2xl border border-white/10 bg-slate-900/95 px-4 py-2 text-xs text-slate-300 shadow-xl backdrop-blur"
        >
          <kbd className="rounded border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-slate-200">
            g
          </kbd>{" "}
          then D · P · A · W · Y · N · M · S
        </div>
      )}
    </div>
  );
}

export function RoleNotice({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
      {text}
    </div>
  );
}
