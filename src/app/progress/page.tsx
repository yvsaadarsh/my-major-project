"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Star, TrendingUp, CheckCircle2, History } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { apiRequest, formatStatus, type Task } from "@/lib/ui/api-client";
import { useAuthSession } from "@/lib/ui/use-auth-session";

type ProgressAnalytics = {
  completedToday: number;
  completedThisWeek: number;
  historicalCompletions: number;
  averageRating: number | null;
  ratingsCount: number;
};

type HistoricalItem = {
  id: string;
  title: string;
  completedAt: string | null;
  rating: number | null;
  project: { id: string; name: string; status: "COMPLETED" | "ARCHIVED" };
};

type ProgressResponse = {
  analytics: ProgressAnalytics;
  currentWork: Task[];
  history: HistoricalItem[];
};

type StatCard = {
  label: string;
  value: string | number;
  note: string;
  Icon: LucideIcon;
};

export default function ProgressPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });

  const [analytics, setAnalytics] = useState<ProgressAnalytics | null>(null);
  const [currentTasks, setCurrentTasks] = useState<Task[]>([]);
  const [history, setHistory] = useState<HistoricalItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!organization) return;

    let mounted = true;
    apiRequest<ProgressResponse>("/api/v1/progress")
      .then((data) => {
        if (!mounted) return;
        setAnalytics(data.analytics);
        setCurrentTasks(data.currentWork);
        setHistory(data.history);
      })
      .catch((caught) => {
        if (mounted) {
          setError(caught instanceof Error ? caught.message : "Unable to load progress data.");
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [organization]);

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  return (
    <AppShell
      eyebrow="Your Progress"
      organizationName={organization?.name}
      role={role}
      title="Track your personal momentum."
      description="View your active work and historical performance within this organization."
    >
      {error && <InlineError message={error} />}

      {(() => {
        const statCards: StatCard[] = [
          {
            label: "Today's Work",
            value: analytics?.completedToday ?? 0,
            note: "Completed today",
            Icon: CheckCircle2,
          },
          {
            label: "This Week's Completions",
            value: analytics?.completedThisWeek ?? 0,
            note: "Completed this week",
            Icon: TrendingUp,
          },
          {
            label: "Average Rating",
            value: analytics?.averageRating ?? "-",
            note:
              analytics?.ratingsCount && analytics.ratingsCount > 0
                ? `${analytics.ratingsCount} rated tasks`
                : "No ratings yet",
            Icon: Star,
          },
          {
            label: "History",
            value: analytics?.historicalCompletions ?? 0,
            note: "Past completed tasks",
            Icon: History,
          },
        ];

        return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statCards.map(({ label, value, note, Icon }) => (
          <SectionCard key={label}>
            <div className="flex items-center gap-2">
              <Icon className="text-teal-300" size={16} />
              <p className="text-sm text-slate-400">{label}</p>
            </div>
            <div className="mt-4 flex items-end justify-between">
              <p className="text-4xl font-semibold text-white">{loading ? "..." : value}</p>
              <span className="rounded-full bg-teal-300/10 px-3 py-1 text-xs font-medium text-teal-200">
                {note}
              </span>
            </div>
          </SectionCard>
        ))}
      </div>
        );
      })()}

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <SectionCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Current Work</h2>
              <p className="mt-1 text-sm text-slate-400">Your active and urgent tasks.</p>
            </div>
          </div>

          <div className="mt-6 space-y-4">
            {currentTasks.length === 0 && !loading ? (
              <EmptyState
                title="You're all caught up!"
                description="No active tasks assigned to you right now."
                action={<Link className="text-sm font-semibold text-teal-200" href="/tasks/latest">View all tasks</Link>}
              />
            ) : (
              currentTasks.map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="group block rounded-3xl border border-white/10 bg-white/[0.035] p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-teal-300/30 hover:bg-white/[0.06]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-base font-semibold text-white">{task.title}</p>
                      <p className="mt-1 text-sm text-slate-400">
                        {formatStatus(task.status)} · {task.project?.name ?? "Project"}
                      </p>
                    </div>
                    <ArrowRight
                      className="text-slate-500 transition-transform group-hover:translate-x-1 group-hover:text-teal-200"
                      size={18}
                    />
                  </div>
                </Link>
              ))
            )}
          </div>
        </SectionCard>

        <SectionCard>
          <div>
            <h2 className="text-xl font-semibold text-white">History of Past Completed Work</h2>
            <p className="mt-1 text-sm text-slate-400">
              Completed tasks from completed or archived projects.
            </p>
          </div>

          <div className="mt-6 space-y-3">
            {history.length === 0 && !loading ? (
              <EmptyState
                title="No historical completions"
                description="When projects are completed or archived, your finished tasks will appear here."
              />
            ) : (
              history.map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3"
                >
                  <p className="text-sm font-semibold text-white">{item.title}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {item.project.name} · {item.completedAt ? new Date(item.completedAt).toLocaleDateString() : "Completed"}
                    {item.rating ? ` · ${item.rating}/5` : ""}
                  </p>
                </div>
              ))
            )}
          </div>
        </SectionCard>
      </div>
    </AppShell>
  );
}
