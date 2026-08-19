"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlarmClock,
  GitBranch,
  Gauge,
  Layers,
  RefreshCw,
  ShieldAlert,
  Timer,
  TrendingUp,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { apiRequest } from "@/lib/ui/api-client";
import { errorMessage } from "@/lib/ui/error-message";
import { useAuthSession } from "@/lib/ui/use-auth-session";
import type {
  ApiHealthSignal,
  ApiProjectIntelligence,
  ApiRiskFinding,
  IntelligenceOverviewResponse,
  Severity as ApiSeverity,
} from "@/lib/ui/intelligence-types";

/**
 * Project Health Intelligence + Dependency Risk.
 *
 * Every number on this page is rendered together with the reasons that produced
 * it. There is no summary that the user cannot trace back to counts — that is
 * the whole point of the feature, so the UI never shows a score without its
 * factor breakdown beside it.
 */

type Severity = ApiSeverity;
type HealthSignal = ApiHealthSignal;
type ProjectIntelligence = ApiProjectIntelligence;
type RiskFinding = ApiRiskFinding;
type OverviewResponse = IntelligenceOverviewResponse;

const BAND_STYLES: Record<ProjectIntelligence["band"], string> = {
  "At risk": "border-orange-300/30 bg-orange-300/10 text-orange-200",
  Critical: "border-rose-400/30 bg-rose-400/10 text-rose-200",
  Healthy: "border-emerald-300/30 bg-emerald-300/10 text-emerald-200",
  Watch: "border-amber-300/30 bg-amber-300/10 text-amber-200",
};

const SEVERITY_BAR: Record<Severity, string> = {
  critical: "bg-rose-400",
  high: "bg-orange-300",
  low: "bg-teal-300",
  medium: "bg-amber-300",
  ok: "bg-emerald-300",
};

const CONFIDENCE_STYLES: Record<ProjectIntelligence["confidence"]["level"], string> = {
  high: "border-emerald-300/25 bg-emerald-300/[0.07] text-emerald-200",
  insufficient: "border-slate-500/30 bg-slate-500/10 text-slate-300",
  low: "border-rose-400/25 bg-rose-400/[0.07] text-rose-200",
  medium: "border-amber-300/25 bg-amber-300/[0.07] text-amber-200",
};

const FINDING_STYLES: Record<RiskFinding["level"], string> = {
  critical: "border-rose-400/30 bg-rose-400/[0.07]",
  info: "border-white/10 bg-white/[0.03]",
  warning: "border-amber-300/25 bg-amber-300/[0.06]",
};

/**
 * One factor row: label, what it cost, and the sentence explaining it.
 *
 * The bar is scaled to the signal's own `maxPoints`, not to 100, so a reader can
 * see "this used most of the budget available to overdue work" rather than
 * comparing incommensurable dimensions.
 */
function FactorRow({ signal }: { signal: HealthSignal }) {
  const fill = signal.maxPoints === 0 ? 0 : Math.round((signal.points / signal.maxPoints) * 100);

  return (
    <li className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-sm font-semibold text-white">{signal.label}</span>
        <span className="shrink-0 font-mono text-xs text-slate-400">
          −{signal.points}
          <span className="text-slate-600"> / {signal.maxPoints}</span>
        </span>
      </div>

      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${SEVERITY_BAR[signal.severity]}`}
          style={{ width: `${fill}%` }}
        />
      </div>

      <p className="mt-2.5 text-sm leading-6 text-slate-300">{signal.detail}</p>
    </li>
  );
}

function ProjectCard({
  intel,
  risk,
}: {
  intel: ProjectIntelligence;
  risk?: OverviewResponse["risk"][number];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-slate-950/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/intelligence/${intel.projectId}`}
            className="text-lg font-semibold text-white hover:text-teal-200"
          >
            {intel.projectName}
          </Link>
          <p className="mt-1 text-xs text-slate-500">
            {intel.counts.total} tasks · {intel.counts.open} open · {intel.completion}% complete
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${CONFIDENCE_STYLES[intel.confidence.level]}`}
            title="How much the underlying data supports this reading"
          >
            {intel.confidence.level} confidence
          </span>
          <span className={`rounded-full border px-3 py-1 text-sm font-semibold ${BAND_STYLES[intel.band]}`}>
            {intel.band} · {intel.score}
          </span>
        </div>
      </div>

      <p className="mt-4 text-sm leading-7 text-slate-300">{intel.summary}</p>

      {/* Confidence caveats are shown by default, not hidden behind a tooltip —
          a score the data cannot support should say so up front. */}
      {intel.confidence.caveats.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {intel.confidence.caveats.map((caveat) => (
            <li key={caveat} className="flex items-start gap-2 text-xs text-slate-400">
              <Activity className="mt-0.5 shrink-0 text-slate-500" size={12} aria-hidden />
              <span>{caveat}</span>
            </li>
          ))}
        </ul>
      )}

      {intel.factors.length > 0 ? (
        <>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            What is costing points
          </p>
          <ul className="mt-3 space-y-2.5">
            {intel.factors.map((signal) => (
              <FactorRow key={signal.key} signal={signal} />
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-5 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.06] px-4 py-3 text-sm text-emerald-200">
          Nothing is costing points. All six health signals are clear.
        </p>
      )}

      {risk && risk.findings.length > 0 && (
        <>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Dependency risk
          </p>
          <ul className="mt-3 space-y-2.5">
            {risk.findings.map((finding) => (
              <li
                key={finding.headline}
                className={`rounded-2xl border p-4 ${FINDING_STYLES[finding.level]}`}
              >
                <div className="flex items-start gap-2.5">
                  {finding.kind === "cycle" ? (
                    <GitBranch className="mt-0.5 shrink-0 text-rose-300" size={15} aria-hidden />
                  ) : finding.kind === "chain" ? (
                    <Timer className="mt-0.5 shrink-0 text-slate-400" size={15} aria-hidden />
                  ) : finding.kind === "hub" ? (
                    <Layers className="mt-0.5 shrink-0 text-slate-400" size={15} aria-hidden />
                  ) : (
                    <ShieldAlert className="mt-0.5 shrink-0 text-amber-300" size={15} aria-hidden />
                  )}
                  <div>
                    <p className="text-sm font-semibold text-white">{finding.headline}</p>
                    <p className="mt-1 text-sm leading-6 text-slate-300">{finding.detail}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {intel.recommendations.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="mt-5 text-xs font-semibold uppercase tracking-[0.2em] text-teal-300 hover:text-teal-200"
          >
            {expanded ? "Hide" : "Show"} suggestions ({intel.recommendations.length})
          </button>

          {expanded && (
            <>
              <ul className="mt-3 space-y-2">
                {intel.recommendations.map((recommendation) => (
                  <li
                    key={recommendation}
                    className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm leading-6 text-slate-300"
                  >
                    {recommendation}
                  </li>
                ))}
              </ul>
              <p className="mt-2.5 text-xs text-slate-500">
                Suggestions only — nothing on this page changes your data.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function IntelligencePage() {
  const {
    error: authError,
    loading: authLoading,
    organization,
    role,
  } = useAuthSession({ requireOrganization: true });

  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);

    try {
      setData(
        await apiRequest<OverviewResponse>("/api/v1/intelligence/overview", { cache: "no-store" }),
      );
    } catch (caught) {
      setError(errorMessage(caught, "Could not load intelligence."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const riskByProject = useMemo(() => {
    const map = new Map<string, OverviewResponse["risk"][number]>();
    for (const entry of data?.risk ?? []) {
      map.set(entry.projectId, entry);
    }
    return map;
  }, [data]);

  // Worst first: the point of the page is triage.
  const ordered = useMemo(
    () =>
      [...(data?.projects ?? [])].sort(
        (a, b) => a.score - b.score || a.projectName.localeCompare(b.projectName),
      ),
    [data],
  );

  const noHistory = data?.projects.every((project) => project.slippage.noHistory) ?? false;

  return (
    <AppShell
      eyebrow="Intelligence"
      organizationName={organization?.name}
      role={role}
      title="Health and dependency risk, fully explained."
      description="Deterministic scoring: every number below is a count or a plain ratio from your tenant's data, shown next to the reasons that produced it. Analysis only — this page never modifies your work."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-2xl border border-emerald-300/25 bg-emerald-300/[0.07] px-4 py-2 text-sm text-emerald-200">
            <Gauge size={15} aria-hidden />
            Read-only analysis
          </span>
          {data && (
            <span className="text-xs text-slate-500">
              Generated {new Date(data.generatedAt).toLocaleString()}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-slate-200 hover:bg-white/[0.08]"
        >
          <RefreshCw size={15} aria-hidden />
          Refresh
        </button>
      </div>

      {(error || authError) && (
        <div className="mt-5">
          <InlineError message={error ?? authError ?? "Something went wrong."} />
        </div>
      )}

      {(loading || authLoading) && !data ? (
        <div className="mt-6">
          <LoadingState label="Computing health signals" />
        </div>
      ) : !data || data.projects.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No projects to assess"
            description="Create a project and some tasks, and health intelligence will appear here."
          />
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Projects assessed", String(data.portfolio.projectCount), Layers],
              ["Average score", `${data.portfolio.averageScore}/100`, TrendingUp],
              ["Lowest score", `${data.portfolio.worstScore}/100`, AlarmClock],
              [
                "Needing attention",
                String(
                  (data.portfolio.bandCounts["At risk"] ?? 0) +
                    (data.portfolio.bandCounts.Critical ?? 0),
                ),
                ShieldAlert,
              ],
            ].map(([label, value, Icon]) => {
              const Rendered = Icon as typeof Layers;
              return (
                <div
                  key={label as string}
                  className="rounded-[1.25rem] border border-white/10 bg-white/[0.03] p-5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">{label as string}</span>
                    <Rendered className="text-teal-300" size={16} aria-hidden />
                  </div>
                  <p className="mt-3 text-3xl font-semibold text-white">{value as string}</p>
                </div>
              );
            })}
          </div>

          <p className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-sm leading-7 text-slate-300">
            {data.portfolio.headline}
          </p>

          {/* Honesty about the slippage ramp-up. Showing "0 days slipped" without
              this caveat would read as a healthy schedule rather than an absent
              measurement. */}
          {noHistory && (
            <p className="mt-3 rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] px-5 py-4 text-sm leading-7 text-amber-100/90">
              Schedule slippage has no history yet. Due-date changes started being recorded with this
              release, so the slippage signal reads zero for every project until dates begin moving.
              Treat it as not-yet-measured rather than stable — it becomes meaningful after a few
              weeks of use.
            </p>
          )}

          <div className="mt-6">
            <SectionCard>
              <h2 className="text-xl font-semibold text-white">Project health</h2>
              <p className="mt-1 text-sm text-slate-400">
                Worst first. Each score is 100 minus the points taken by the six signals below it.
              </p>

              <div className="mt-5 space-y-4">
                {ordered.map((intel) => (
                  <ProjectCard
                    key={intel.projectId}
                    intel={intel}
                    risk={riskByProject.get(intel.projectId)}
                  />
                ))}
                <p className="pt-1 text-xs text-slate-500">
                  Open a project for its full signal arithmetic, bottleneck reasons and slippage
                  history.
                </p>
              </div>
            </SectionCard>
          </div>
        </>
      )}
    </AppShell>
  );
}
