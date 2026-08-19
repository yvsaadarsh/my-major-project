"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlarmClock,
  BarChart3,
  CheckCircle2,
  Gauge,
  Layers,
  RefreshCw,
  ShieldAlert,
  Timer,
  Users,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { apiRequest } from "@/lib/ui/api-client";
import { errorMessage } from "@/lib/ui/error-message";
import { useAuthSession } from "@/lib/ui/use-auth-session";
import type { ApiProjectIntelligence, Band } from "@/lib/ui/intelligence-types";

type WorkMetrics = {
  totalTasks: number;
  openTasks: number;
  completedTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  urgentOpenTasks: number;
  unassignedOpenTasks: number;
  completionRate: number;
  overdueRate: number;
};

type StatusDistribution = {
  todo: number;
  inProgress: number;
  blocked: number;
  done: number;
  total: number;
};

type PriorityDistribution = {
  low: number;
  medium: number;
  high: number;
  urgent: number;
  total: number;
};

type ThroughputBucket = { weekStart: string; label: string; completed: number };

type CycleTimeStats = {
  sampleSize: number;
  averageDays: number;
  medianDays: number;
  fastestDays: number;
  slowestDays: number;
};

type AgingBuckets = {
  freshUnderWeek: number;
  oneToTwoWeeks: number;
  twoToFourWeeks: number;
  overMonth: number;
  oldestOpenDays: number;
};

type MilestoneSummary = {
  total: number;
  onTrack: number;
  atRisk: number;
  missed: number;
  done: number;
  planned: number;
};

type MilestonePerformance = {
  id: string;
  name: string;
  projectId: string;
  status: "PLANNED" | "ON_TRACK" | "AT_RISK" | "MISSED" | "DONE";
  dueDate: string;
  totalTasks: number;
  completedTasks: number;
  completion: number;
  overdue: boolean;
  daysToDue: number;
};

type MemberWorkload = {
  userId: string;
  name: string;
  role: "ADMIN" | "MANAGER" | "MEMBER";
  openTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  urgentTasks: number;
  completedTasks: number;
  loadLevel: "Idle" | "Steady" | "Busy" | "Overloaded";
};

type ProjectHealthRow = {
  id: string;
  name: string;
  status: string;
  taskCount: number;
  /** The full analysis — band, score, ranked factors, confidence. */
  intelligence: ApiProjectIntelligence;
};

type AnalyticsOverview = {
  generatedAt: string;
  metrics: WorkMetrics;
  statusDistribution: StatusDistribution;
  priorityDistribution: PriorityDistribution;
  throughput: ThroughputBucket[];
  cycleTime: CycleTimeStats;
  aging: AgingBuckets;
  milestoneSummary: MilestoneSummary;
  milestonePerformance: MilestonePerformance[];
  teamWorkload: MemberWorkload[];
  projectHealth: ProjectHealthRow[];
};

const HEALTH_STYLES: Record<Band, string> = {
  Healthy: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
  Watch: "border-sky-300/30 bg-sky-300/10 text-sky-200",
  "At risk": "border-amber-300/30 bg-amber-300/10 text-amber-100",
  Critical: "border-rose-400/30 bg-rose-400/10 text-rose-200",
};

const LOAD_STYLES: Record<MemberWorkload["loadLevel"], string> = {
  Idle: "text-slate-400",
  Steady: "text-emerald-300",
  Busy: "text-amber-300",
  Overloaded: "text-rose-300",
};

export default function AnalyticsPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadOverview() {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<AnalyticsOverview>("/api/v1/analytics/overview");
      setData(response);
    } catch (caught) {
      setError(errorMessage(caught, "Unable to load analytics."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!organization) {
      return;
    }
    void loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization]);

  const maxThroughput = useMemo(
    () => Math.max(1, ...(data?.throughput.map((bucket) => bucket.completed) ?? [1])),
    [data],
  );

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  const metrics = data?.metrics;

  return (
    <AppShell
      eyebrow="Analytics"
      organizationName={organization?.name}
      role={role}
      title="Deterministic analytics for the whole tenant."
      description="Every number here is a raw count or a plain ratio computed from your tenant's data — no AI, no black-box scoring. Project health is fully explained."
    >
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-400">
          {data ? `Generated ${new Date(data.generatedAt).toLocaleString()}` : "Loading tenant analytics..."}
        </p>
        <button
          className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white transition-all hover:bg-white/[0.1]"
          onClick={() => void loadOverview()}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      {error && <InlineError message={error} />}

      {loading ? (
        <LoadingState label="Crunching tenant analytics..." />
      ) : !data ? (
        <EmptyState title="No analytics yet" description="Create some projects and tasks to populate analytics." />
      ) : (
        <div className="grid gap-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={Layers} label="Total tasks" value={metrics?.totalTasks ?? 0} hint={`${metrics?.openTasks ?? 0} open`} />
            <MetricCard
              icon={CheckCircle2}
              label="Completion rate"
              value={`${metrics?.completionRate ?? 0}%`}
              hint={`${metrics?.completedTasks ?? 0} done`}
              tone="emerald"
            />
            <MetricCard
              icon={AlarmClock}
              label="Overdue rate"
              value={`${metrics?.overdueRate ?? 0}%`}
              hint={`${metrics?.overdueTasks ?? 0} overdue`}
              tone={metrics && metrics.overdueRate > 20 ? "rose" : "default"}
            />
            <MetricCard
              icon={ShieldAlert}
              label="Blocked tasks"
              value={metrics?.blockedTasks ?? 0}
              hint={`${metrics?.urgentOpenTasks ?? 0} urgent open`}
              tone={metrics && metrics.blockedTasks > 0 ? "amber" : "default"}
            />
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.4fr_0.6fr]">
            <SectionCard>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                    <BarChart3 className="text-teal-300" size={20} />
                    Weekly throughput
                  </h2>
                  <p className="mt-1 text-sm text-slate-400">Tasks completed per week, last 8 weeks.</p>
                </div>
              </div>

              <div className="mt-8 flex h-48 items-end gap-2 sm:gap-3">
                {data.throughput.map((bucket) => {
                  const heightPct = Math.round((bucket.completed / maxThroughput) * 100);
                  return (
                    <div key={bucket.weekStart} className="flex flex-1 flex-col items-center gap-2">
                      <div className="flex w-full flex-1 items-end">
                        <div
                          className="w-full rounded-t-lg bg-gradient-to-t from-teal-500/40 to-teal-300 transition-all"
                          style={{ height: `${Math.max(heightPct, bucket.completed > 0 ? 6 : 2)}%` }}
                          title={`${bucket.completed} completed`}
                        />
                      </div>
                      <span className="text-xs font-semibold text-slate-300">{bucket.completed}</span>
                      <span className="text-[10px] text-slate-500">{bucket.label}</span>
                    </div>
                  );
                })}
              </div>
            </SectionCard>

            <SectionCard>
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <Timer className="text-teal-300" size={20} />
                Cycle time
              </h2>
              <p className="mt-1 text-sm text-slate-400">Created → completed, in days.</p>

              {data.cycleTime.sampleSize === 0 ? (
                <p className="mt-6 text-sm text-slate-500">No completed tasks yet to measure.</p>
              ) : (
                <div className="mt-6 space-y-4">
                  <BigStat label="Median" value={`${data.cycleTime.medianDays}d`} />
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <SmallStat label="Average" value={`${data.cycleTime.averageDays}d`} />
                    <SmallStat label="Fastest" value={`${data.cycleTime.fastestDays}d`} />
                    <SmallStat label="Slowest" value={`${data.cycleTime.slowestDays}d`} />
                  </div>
                  <p className="text-xs text-slate-500">Based on {data.cycleTime.sampleSize} completed tasks.</p>
                </div>
              )}
            </SectionCard>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard>
              <h2 className="text-xl font-semibold text-white">Status mix</h2>
              <p className="mt-1 text-sm text-slate-400">All {data.statusDistribution.total} tasks.</p>
              <div className="mt-5 space-y-3">
                <DistributionBar label="To do" value={data.statusDistribution.todo} total={data.statusDistribution.total} color="bg-slate-400" />
                <DistributionBar label="In progress" value={data.statusDistribution.inProgress} total={data.statusDistribution.total} color="bg-sky-400" />
                <DistributionBar label="Blocked" value={data.statusDistribution.blocked} total={data.statusDistribution.total} color="bg-rose-400" />
                <DistributionBar label="Done" value={data.statusDistribution.done} total={data.statusDistribution.total} color="bg-emerald-400" />
              </div>
            </SectionCard>

            <SectionCard>
              <h2 className="text-xl font-semibold text-white">Open work by priority</h2>
              <p className="mt-1 text-sm text-slate-400">{data.priorityDistribution.total} open tasks.</p>
              <div className="mt-5 space-y-3">
                <DistributionBar label="Urgent" value={data.priorityDistribution.urgent} total={data.priorityDistribution.total} color="bg-rose-500" />
                <DistributionBar label="High" value={data.priorityDistribution.high} total={data.priorityDistribution.total} color="bg-amber-400" />
                <DistributionBar label="Medium" value={data.priorityDistribution.medium} total={data.priorityDistribution.total} color="bg-sky-400" />
                <DistributionBar label="Low" value={data.priorityDistribution.low} total={data.priorityDistribution.total} color="bg-slate-400" />
              </div>
            </SectionCard>
          </div>

          <SectionCard>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                  <Gauge className="text-teal-300" size={20} />
                  Project health
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  Transparent scoring — every project shows the reasons behind its score. Most at-risk first.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-3">
              {data.projectHealth.length === 0 ? (
                <p className="text-sm text-slate-500">No projects yet.</p>
              ) : (
                data.projectHealth.map((project) => {
                  const intel = project.intelligence;

                  return (
                    <div key={project.id} className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${HEALTH_STYLES[intel.band]}`}>
                            {intel.band} · {intel.score}
                          </span>
                          <Link href={`/intelligence/${project.id}`} className="text-base font-semibold text-white hover:text-teal-200">
                            {project.name}
                          </Link>
                        </div>
                        <div className="flex gap-4 text-xs text-slate-400">
                          <span>{intel.completion}% done</span>
                          <span>{intel.counts.overdue} overdue</span>
                          <span>{intel.counts.blocked} blocked</span>
                          <span className="text-slate-500">{intel.confidence.level} confidence</span>
                        </div>
                      </div>
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {intel.factors.length ? (
                          intel.factors.map((factor) => (
                            <li key={factor.key} className="rounded-full bg-white/[0.04] px-3 py-1 text-xs text-slate-400">
                              <span className="font-semibold text-slate-300">−{factor.points}</span>{" "}
                              {factor.detail}
                            </li>
                          ))
                        ) : (
                          <li className="rounded-full bg-white/[0.04] px-3 py-1 text-xs text-slate-400">
                            No health signals are currently costing points.
                          </li>
                        )}
                      </ul>
                    </div>
                  );
                })
              )}
            </div>
          </SectionCard>

          <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
            <SectionCard>
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <Users className="text-teal-300" size={20} />
                Team workload
              </h2>
              <p className="mt-1 text-sm text-slate-400">Open tasks per member. Load level is derived only from open + overdue counts.</p>

              <div className="mt-5 space-y-2">
                {data.teamWorkload.length === 0 ? (
                  <p className="text-sm text-slate-500">No active members.</p>
                ) : (
                  data.teamWorkload.map((member) => (
                    <div key={member.userId} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-white">{member.name}</p>
                        <p className="text-xs text-slate-500">
                          {member.openTasks} open · {member.overdueTasks} overdue · {member.completedTasks} done
                        </p>
                      </div>
                      <span className={`text-sm font-semibold ${LOAD_STYLES[member.loadLevel]}`}>{member.loadLevel}</span>
                    </div>
                  ))
                )}
              </div>
            </SectionCard>

            <SectionCard>
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <Activity className="text-teal-300" size={20} />
                Milestone performance
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                {data.milestoneSummary.onTrack} on track · {data.milestoneSummary.atRisk} at risk · {data.milestoneSummary.missed} missed · {data.milestoneSummary.done} done
              </p>

              <div className="mt-5 space-y-3">
                {data.milestonePerformance.length === 0 ? (
                  <p className="text-sm text-slate-500">No milestones yet.</p>
                ) : (
                  data.milestonePerformance.map((milestone) => (
                    <div key={milestone.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-white">{milestone.name}</p>
                        <span className={`text-xs ${milestone.overdue ? "text-rose-300" : "text-slate-400"}`}>
                          {milestone.overdue ? "Overdue" : milestone.daysToDue >= 0 ? `${milestone.daysToDue}d left` : "Past due"}
                        </span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-teal-300" style={{ width: `${milestone.completion}%` }} />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {milestone.completedTasks}/{milestone.totalTasks} tasks · {milestone.completion}%
                      </p>
                    </div>
                  ))
                )}
              </div>
            </SectionCard>
          </div>

          <SectionCard>
            <h2 className="text-xl font-semibold text-white">Open-task aging</h2>
            <p className="mt-1 text-sm text-slate-400">
              How long open tasks have been sitting. Oldest open task: {data.aging.oldestOpenDays} days.
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-4">
              <SmallStat label="< 1 week" value={data.aging.freshUnderWeek} />
              <SmallStat label="1–2 weeks" value={data.aging.oneToTwoWeeks} />
              <SmallStat label="2–4 weeks" value={data.aging.twoToFourWeeks} />
              <SmallStat label="> 1 month" value={data.aging.overMonth} tone={data.aging.overMonth > 0 ? "amber" : "default"} />
            </div>
          </SectionCard>
        </div>
      )}
    </AppShell>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "default",
}: {
  icon: typeof Gauge;
  label: string;
  value: string | number;
  hint: string;
  tone?: "default" | "emerald" | "rose" | "amber";
}) {
  const toneStyles = {
    default: "text-teal-300",
    emerald: "text-emerald-300",
    rose: "text-rose-300",
    amber: "text-amber-300",
  }[tone];

  return (
    <SectionCard className="min-h-32">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400">{label}</p>
        <Icon className={toneStyles} size={20} />
      </div>
      <p className="mt-4 text-4xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </SectionCard>
  );
}

function DistributionBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-400">
          {value} · {pct}%
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function BigStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-center">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-4xl font-semibold text-white">{value}</p>
    </div>
  );
}

function SmallStat({ label, value, tone = "default" }: { label: string; value: string | number; tone?: "default" | "amber" }) {
  const valueColor = tone === "amber" ? "text-amber-300" : "text-white";
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3 text-center">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueColor}`}>{value}</p>
    </div>
  );
}
