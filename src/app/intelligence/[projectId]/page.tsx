"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  Activity,
  AlarmClock,
  ArrowLeft,
  GitBranch,
  Gauge,
  History,
  Layers,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Timer,
  TrendingUp,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { apiRequest } from "@/lib/ui/api-client";
import { useAuthSession } from "@/lib/ui/use-auth-session";

/**
 * Single-project intelligence.
 *
 * Deeper than the portfolio view: full factor arithmetic, every bottleneck with
 * its reasons, cycle paths, the critical chain, cross-project links in both
 * directions, and the slippage retrospective.
 *
 * Same rule as the portfolio page — no number appears without the counts that
 * produced it.
 */

type Severity = "ok" | "low" | "medium" | "high" | "critical";

type HealthSignal = {
  key: string;
  label: string;
  detail: string;
  ratio: number;
  points: number;
  maxPoints: number;
  severity: Severity;
  evidence: Record<string, number>;
};

type Health = {
  projectName: string;
  score: number;
  band: "Healthy" | "Watch" | "At risk" | "Critical";
  completion: number;
  factors: HealthSignal[];
  healthy: HealthSignal[];
  confidence: { level: "high" | "medium" | "low" | "insufficient"; caveats: string[] };
  velocity: { recentCompleted: number; priorCompleted: number; direction: string };
  slippage: { pushCount: number; totalDaysPushed: number; noHistory: boolean };
  summary: string;
  recommendations: string[];
  counts: {
    total: number;
    open: number;
    done: number;
    overdue: number;
    blocked: number;
    unassignedOpen: number;
    milestones: number;
    milestonesAtRisk: number;
  };
};

type Bottleneck = {
  taskId: string;
  title: string;
  status: string;
  priority: string;
  severity: "critical" | "high" | "medium" | "low";
  impactScore: number;
  directBlockedCount: number;
  totalBlockedCount: number;
  openBlockedCount: number;
  overdueBlockedCount: number;
  actionableNow: boolean;
  reasons: string[];
  recommendation: string;
};

type Cycle = { path: string[]; titles: string[] };

type Risk = {
  blockingEdgeCount: number;
  cycles: Cycle[];
  longestChain: { length: number; openCount: number; titles: string[]; path: string[] };
  bottlenecks: Bottleneck[];
  findings: Array<{
    level: "critical" | "warning" | "info";
    kind: string;
    headline: string;
    detail: string;
    taskIds: string[];
  }>;
};

type TaskSlippage = {
  taskId: string;
  title: string;
  pushes: number;
  totalDaysPushed: number;
  worstPushDays: number;
  isBlocker: boolean;
  originalDueDate: string | null;
  currentDueDate: string | null;
  lastChangedAt: string;
};

type CrossProjectEdge = {
  edgeId: string;
  direction: "inbound" | "outbound";
  otherTaskId: string;
  otherProject: { id: string; name: string } | null;
  type: string;
};

type Response = {
  generatedAt: string;
  readOnly: boolean;
  project: { id: string; name: string; status: string };
  health: Health;
  risk: Risk;
  slippageRetrospective: TaskSlippage[];
  crossProject: { edges: CrossProjectEdge[]; inbound: number; outbound: number };
  scheduleHistory: { changesConsidered: number; truncated: boolean };
};

const BAND_STYLES: Record<Health["band"], string> = {
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

const BOTTLENECK_STYLES: Record<Bottleneck["severity"], string> = {
  critical: "border-rose-400/30 bg-rose-400/[0.07]",
  high: "border-orange-300/25 bg-orange-300/[0.06]",
  low: "border-white/10 bg-white/[0.03]",
  medium: "border-amber-300/25 bg-amber-300/[0.05]",
};

function formatDate(value: string | null): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleDateString();
}

/**
 * Lifecycle of the AI brief.
 *
 * `hidden` is terminal and deliberately covers every failure — not configured
 * (501), upstream error, empty output. The brief is additive, so when it cannot
 * be produced the page simply does not mention it. A broken AI feature must
 * never make the deterministic analysis look broken.
 */
type BriefState = "loading" | "streaming" | "done" | "hidden";

/**
 * Streamed prose, split into paragraphs on blank lines.
 *
 * Rendered as plain text rather than markdown: the prompt asks for three
 * paragraphs with no headings or bullets, and running a markdown parser over
 * half-arrived model output would flicker as partial syntax resolves.
 */
function BriefBody({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((part) => part.trim().length > 0);

  return (
    <div className="space-y-3">
      {paragraphs.map((paragraph, index) => (
        <p
          key={index}
          className="text-sm leading-7 text-slate-200"
        >
          {paragraph.trim()}
        </p>
      ))}
    </div>
  );
}

/** Three pulsing bars standing in for the three paragraphs the prompt asks for. */
function BriefSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {["w-full", "w-11/12", "w-4/5"].map((width) => (
        <div key={width} className="space-y-2">
          <div className={`h-3 animate-pulse rounded-full bg-white/10 ${width}`} />
          <div className="h-3 w-3/5 animate-pulse rounded-full bg-white/[0.07]" />
        </div>
      ))}
    </div>
  );
}

/**
 * Lifecycle of the trajectory forecast.
 *
 * `insufficient` is distinct from `hidden`: the project is real but too young or
 * too small to forecast, which the user should be told plainly rather than left
 * wondering why the section is empty. `hidden` still covers every failure and
 * the not-configured (501) case, so a missing key degrades to nothing at all.
 */
type ForecastState = "loading" | "streaming" | "done" | "insufficient" | "hidden";

/** Animated gradient bars, standing in for the two sentences while they stream. */
function TrajectorySkeleton() {
  return (
    <div className="space-y-2.5" aria-hidden>
      {["w-full", "w-5/6"].map((width) => (
        <div
          key={width}
          className={`h-3.5 animate-pulse rounded-full bg-gradient-to-r from-sky-400/25 via-violet-400/20 to-sky-400/10 ${width}`}
        />
      ))}
    </div>
  );
}

export default function ProjectIntelligencePage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params?.projectId;

  const {
    error: authError,
    loading: authLoading,
    organization,
    role,
  } = useAuthSession({ requireOrganization: true });

  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [brief, setBrief] = useState("");
  const [briefState, setBriefState] = useState<BriefState>("loading");
  /** Bumped by Refresh so the brief re-streams alongside the deterministic data. */
  const [refreshToken, setRefreshToken] = useState(0);

  const [forecast, setForecast] = useState("");
  const [forecastState, setForecastState] = useState<ForecastState>("loading");

  async function load() {
    if (!projectId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      setData(
        await apiRequest<Response>(`/api/v1/intelligence/projects/${projectId}`, {
          cache: "no-store",
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load intelligence.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, refreshToken]);

  /**
   * Stream the AI brief.
   *
   * Separate from `load()` on purpose: the deterministic analysis is the page,
   * and it must render at full speed without waiting on a model. The two
   * requests run concurrently and neither can block or fail the other.
   */
  useEffect(() => {
    if (!projectId) {
      return;
    }

    const controller = new AbortController();

    void (async () => {
      // Inside the async body rather than the effect body: a synchronous
      // setState during an effect triggers a cascading render, which
      // react-hooks/set-state-in-effect flags.
      setBrief("");
      setBriefState("loading");

      try {
        const response = await fetch(
          `/api/v1/intelligence/projects/${projectId}/narrative`,
          { cache: "no-store", credentials: "include", signal: controller.signal },
        );

        // 501 means the deployment has no ANTHROPIC_API_KEY. Any other failure
        // is treated identically — the section disappears rather than showing an
        // error for content the user never asked for.
        if (!response.ok || !response.body) {
          setBriefState("hidden");
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        setBriefState("streaming");

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          // `stream: true` so a multi-byte character split across two chunks is
          // not decoded into a replacement character.
          accumulated += decoder.decode(value, { stream: true });
          setBrief(accumulated);
        }

        accumulated += decoder.decode();
        setBrief(accumulated);
        // An empty body means the stream failed before producing anything.
        setBriefState(accumulated.trim().length > 0 ? "done" : "hidden");
      } catch {
        // Includes the abort below, where the component no longer exists and the
        // state setter is a no-op.
        setBriefState("hidden");
      }
    })();

    return () => controller.abort();
  }, [projectId, refreshToken]);

  /**
   * Stream the trajectory forecast.
   *
   * Independent of both `load()` and the brief: three concurrent requests, none
   * able to block or fail another. The forecast response is either a `text/plain`
   * token stream (success) or a small `application/json` body (`insufficient`, or
   * a 501 the branch below treats as `hidden`), so the content type decides how
   * to read it.
   */
  useEffect(() => {
    if (!projectId) {
      return;
    }

    const controller = new AbortController();

    void (async () => {
      setForecast("");
      setForecastState("loading");

      try {
        const response = await fetch(
          `/api/v1/intelligence/projects/${projectId}/forecast`,
          { cache: "no-store", credentials: "include", signal: controller.signal },
        );

        // 501 (no key) and every other failure collapse to the same outcome: the
        // section is not rendered.
        if (!response.ok || !response.body) {
          setForecastState("hidden");
          return;
        }

        // A JSON body is the "not enough history" signal, never a stream.
        if ((response.headers.get("content-type") ?? "").includes("application/json")) {
          const payload = (await response.json().catch(() => null)) as
            | { insufficient?: boolean }
            | null;
          setForecastState(payload?.insufficient ? "insufficient" : "hidden");
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        setForecastState("streaming");

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          accumulated += decoder.decode(value, { stream: true });
          setForecast(accumulated);
        }

        accumulated += decoder.decode();
        setForecast(accumulated);
        setForecastState(accumulated.trim().length > 0 ? "done" : "hidden");
      } catch {
        setForecastState("hidden");
      }
    })();

    return () => controller.abort();
  }, [projectId, refreshToken]);

  const health = data?.health;

  // Sum the factor points so the page can show the arithmetic rather than
  // asserting the score.
  const deducted = useMemo(
    () => (health?.factors ?? []).reduce((total, factor) => total + factor.points, 0),
    [health],
  );

  return (
    <AppShell
      eyebrow="Intelligence"
      organizationName={organization?.name}
      role={role}
      title={data ? data.project.name : "Project intelligence"}
      description="Every signal, its arithmetic, and the dependency graph around this project. Analysis only — nothing here modifies your work."
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/intelligence"
            className="inline-flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-slate-200 hover:bg-white/[0.08]"
          >
            <ArrowLeft size={15} aria-hidden />
            All projects
          </Link>
          <span className="inline-flex items-center gap-2 rounded-2xl border border-emerald-300/25 bg-emerald-300/[0.07] px-4 py-2 text-sm text-emerald-200">
            <Gauge size={15} aria-hidden />
            Read-only
          </span>
        </div>

        <button
          type="button"
          onClick={() => setRefreshToken((token) => token + 1)}
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
      ) : !data || !health ? (
        <div className="mt-6">
          <EmptyState
            title="Nothing to assess"
            description="This project has no tasks yet, so there are no health signals to compute."
          />
        </div>
      ) : (
        <>
          {/* ── Score ─────────────────────────────────────────────────────── */}
          <div className="mt-6">
            <SectionCard>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                    Health score
                  </p>
                  <p className="mt-2 text-5xl font-semibold text-white">
                    {health.score}
                    <span className="text-2xl text-slate-600">/100</span>
                  </p>
                  {/* The arithmetic, shown rather than asserted. */}
                  <p className="mt-2 font-mono text-xs text-slate-500">
                    100 − {deducted} deducted = {health.score}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                      health.confidence.level === "high"
                        ? "border-emerald-300/25 bg-emerald-300/[0.07] text-emerald-200"
                        : health.confidence.level === "medium"
                          ? "border-amber-300/25 bg-amber-300/[0.07] text-amber-200"
                          : "border-rose-400/25 bg-rose-400/[0.07] text-rose-200"
                    }`}
                  >
                    {health.confidence.level} confidence
                  </span>
                  <span
                    className={`rounded-full border px-4 py-1.5 text-sm font-semibold ${BAND_STYLES[health.band]}`}
                  >
                    {health.band}
                  </span>
                </div>
              </div>

              <p className="mt-4 text-sm leading-7 text-slate-300">{health.summary}</p>

              {health.confidence.caveats.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {health.confidence.caveats.map((caveat) => (
                    <li key={caveat} className="flex items-start gap-2 text-xs text-slate-400">
                      <Activity className="mt-0.5 shrink-0 text-slate-500" size={12} aria-hidden />
                      <span>{caveat}</span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {[
                  ["Total", health.counts.total],
                  ["Open", health.counts.open],
                  ["Done", health.counts.done],
                  ["Overdue", health.counts.overdue],
                  ["Blocked", health.counts.blocked],
                  ["No owner", health.counts.unassignedOpen],
                ].map(([label, value]) => (
                  <div
                    key={label as string}
                    className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3"
                  >
                    <p className="text-xs text-slate-500">{label as string}</p>
                    <p className="mt-1 text-xl font-semibold text-white">{value as number}</p>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>

          {/* ── Trajectory ────────────────────────────────────────────────── */}
          {/*
            Forward-looking, additive, and clearly labelled as an estimate. It
            streams two hedged sentences from the computed velocity and slippage
            trends. Hidden entirely when AI is not configured (501) or on any
            failure; a distinct "not enough history" line when the project is too
            new or too small to project from.
          */}
          {forecastState !== "hidden" && (
            <div className="mt-6">
              <SectionCard>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                    <TrendingUp className="text-sky-300" size={20} aria-hidden />
                    Trajectory
                  </h2>
                  <span
                    className="inline-flex cursor-help items-center gap-1.5 rounded-full border border-sky-300/30 bg-sky-300/[0.1] px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-sky-200"
                    title="This is a probabilistic estimate based on current velocity and slippage trends, not a guarantee."
                  >
                    AI
                  </span>
                </div>

                <p className="mt-1 text-sm text-slate-400">
                  Where this project is heading if current trends hold.
                </p>

                <div
                  className="mt-4"
                  aria-busy={forecastState === "loading" || forecastState === "streaming"}
                  aria-live="polite"
                >
                  {forecastState === "insufficient" ? (
                    <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-400">
                      Not enough history yet.
                    </p>
                  ) : forecast.length === 0 ? (
                    <TrajectorySkeleton />
                  ) : (
                    <p className="text-sm leading-7 text-slate-200">{forecast}</p>
                  )}
                </div>

                {forecastState === "streaming" && forecast.length > 0 && (
                  <p className="mt-3 flex items-center gap-2 text-xs text-sky-200/70">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />
                    Projecting…
                  </p>
                )}
              </SectionCard>
            </div>
          )}

          {/* ── AI brief ──────────────────────────────────────────────────── */}
          {/*
            Additive. Everything below this card is computed deterministically and
            renders identically whether or not the brief appears. When AI is not
            configured the endpoint returns 501 and this section is absent
            entirely — no error, no empty placeholder.

            Visually distinct on purpose: a violet wash and a badge, so generated
            prose is never mistaken for the audited arithmetic underneath it.
          */}
          {briefState !== "hidden" && (
            <div className="mt-6">
              <section className="relative overflow-hidden rounded-[2rem] border border-violet-300/20 bg-violet-400/[0.05] p-5 soft-border backdrop-blur-xl">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                    <Sparkles className="text-violet-300" size={20} aria-hidden />
                    AI project brief
                  </h2>
                  <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-violet-300/30 bg-violet-300/[0.1] px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-violet-200">
                    AI
                  </span>
                </div>

                <p className="mt-1 text-sm text-slate-400">
                  Written from the computed signals below. It phrases the numbers — it never
                  produces them.
                </p>

                <div className="mt-5" aria-busy={briefState !== "done"} aria-live="polite">
                  {brief.length === 0 ? <BriefSkeleton /> : <BriefBody text={brief} />}
                </div>

                {briefState === "streaming" && brief.length > 0 && (
                  <p className="mt-3 flex items-center gap-2 text-xs text-violet-200/70">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-300" />
                    Writing…
                  </p>
                )}
              </section>
            </div>
          )}

          {/* ── Factors ───────────────────────────────────────────────────── */}
          <div className="mt-6">
            <SectionCard>
              <h2 className="text-xl font-semibold text-white">Signal breakdown</h2>
              <p className="mt-1 text-sm text-slate-400">
                All six signals, whether or not they cost points. Bars are scaled to each signal&apos;s
                own ceiling.
              </p>

              <ul className="mt-5 space-y-2.5">
                {[...health.factors, ...health.healthy].map((signal) => (
                  <li
                    key={signal.key}
                    className={`rounded-2xl border p-4 ${
                      signal.points > 0
                        ? "border-white/10 bg-white/[0.03]"
                        : "border-emerald-300/15 bg-emerald-300/[0.03]"
                    }`}
                  >
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
                        style={{
                          width: `${signal.maxPoints === 0 ? 0 : Math.round((signal.points / signal.maxPoints) * 100)}%`,
                        }}
                      />
                    </div>

                    <p className="mt-2.5 text-sm leading-6 text-slate-300">{signal.detail}</p>

                    <p className="mt-2 font-mono text-[0.7rem] text-slate-500">
                      {Object.entries(signal.evidence)
                        .map(([key, value]) => `${key}=${value}`)
                        .join("  ")}
                    </p>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </div>

          {/* ── Cross-project links ───────────────────────────────────────── */}
          {data.crossProject.edges.length > 0 && (
            <div className="mt-6">
              <SectionCard>
                <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                  <GitBranch className="text-violet-300" size={20} aria-hidden />
                  Cross-project links
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  {data.crossProject.inbound} inbound, {data.crossProject.outbound} outbound. Inbound
                  links are constraints this project does not control.
                </p>

                <ul className="mt-5 space-y-2.5">
                  {data.crossProject.edges.map((edge) => (
                    <li
                      key={edge.edgeId}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-violet-300/20 bg-violet-300/[0.04] px-4 py-3"
                    >
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-200">
                          {edge.direction === "inbound" ? "Blocked by" : "Blocking"}{" "}
                          {edge.otherProject?.name ?? "another project"}
                        </p>
                        <Link
                          href={`/tasks/${edge.otherTaskId}`}
                          className="mt-1 inline-block text-sm text-slate-200 hover:text-teal-200"
                        >
                          View the linked task →
                        </Link>
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-slate-300">
                        {edge.type}
                      </span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </div>
          )}

          {/* ── Dependency risk ──────────────────────────────────────────── */}
          <div className="mt-6">
            <SectionCard>
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <ShieldAlert className="text-amber-300" size={20} aria-hidden />
                Dependency risk
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                {data.risk.blockingEdgeCount} blocking link
                {data.risk.blockingEdgeCount === 1 ? "" : "s"} considered.
              </p>

              {data.risk.cycles.length > 0 && (
                <div className="mt-5 space-y-2.5">
                  {data.risk.cycles.map((cycle) => (
                    <div
                      key={cycle.path.join(">")}
                      className="rounded-2xl border border-rose-400/30 bg-rose-400/[0.07] p-4"
                    >
                      <p className="text-sm font-semibold text-rose-200">
                        Circular dependency — none of these can start
                      </p>
                      <p className="mt-1.5 font-mono text-xs leading-6 text-slate-300">
                        {cycle.titles.join(" → ")}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {data.risk.longestChain.length > 1 && (
                <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Timer className="text-slate-400" size={15} aria-hidden />
                    Critical chain — {data.risk.longestChain.length} deep,{" "}
                    {data.risk.longestChain.openCount} still open
                  </p>
                  <p className="mt-1.5 font-mono text-xs leading-6 text-slate-400">
                    {data.risk.longestChain.titles.join(" → ")}
                  </p>
                </div>
              )}

              {data.risk.bottlenecks.length > 0 ? (
                <ul className="mt-5 space-y-2.5">
                  {data.risk.bottlenecks.map((bottleneck) => (
                    <li
                      key={bottleneck.taskId}
                      className={`rounded-2xl border p-4 ${BOTTLENECK_STYLES[bottleneck.severity]}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <Link
                          href={`/tasks/${bottleneck.taskId}`}
                          className="text-sm font-semibold text-white hover:text-teal-200"
                        >
                          {bottleneck.title}
                        </Link>
                        <div className="flex shrink-0 items-center gap-2">
                          {bottleneck.actionableNow && (
                            <span className="rounded-full border border-teal-300/25 bg-teal-300/[0.08] px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-teal-200">
                              Actionable now
                            </span>
                          )}
                          <span className="font-mono text-xs text-slate-400">
                            impact {bottleneck.impactScore}
                          </span>
                        </div>
                      </div>

                      <ul className="mt-2.5 space-y-1">
                        {bottleneck.reasons.map((reason) => (
                          <li key={reason} className="text-sm leading-6 text-slate-300">
                            · {reason}
                          </li>
                        ))}
                      </ul>

                      <p className="mt-2.5 text-sm leading-6 text-teal-100/80">
                        {bottleneck.recommendation}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                data.risk.cycles.length === 0 && (
                  <p className="mt-5 rounded-2xl border border-emerald-300/20 bg-emerald-300/[0.06] px-4 py-3 text-sm text-emerald-200">
                    No task is blocking open work in this project.
                  </p>
                )
              )}
            </SectionCard>
          </div>

          {/* ── Slippage retrospective ───────────────────────────────────── */}
          <div className="mt-6">
            <SectionCard>
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <History className="text-teal-300" size={20} aria-hidden />
                Slippage retrospective
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Which commitments keep moving. One task re-dated six times is a different problem
                from six tasks moved once — the totals look the same.
              </p>

              {data.slippageRetrospective.length === 0 ? (
                <p className="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] px-4 py-3 text-sm leading-7 text-amber-100/90">
                  {health.slippage.noHistory
                    ? "No due-date changes have been recorded yet. History starts from the release that added this tracking, so this is not-yet-measured rather than stable."
                    : "No due date has been pushed later in this project."}
                </p>
              ) : (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-xs uppercase tracking-[0.14em] text-slate-500">
                        <th className="pb-2.5 pr-4 font-semibold">Task</th>
                        <th className="pb-2.5 pr-4 font-semibold">Moves</th>
                        <th className="pb-2.5 pr-4 font-semibold">Days lost</th>
                        <th className="pb-2.5 pr-4 font-semibold">Worst</th>
                        <th className="pb-2.5 pr-4 font-semibold">Original</th>
                        <th className="pb-2.5 font-semibold">Now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.slippageRetrospective.map((row) => (
                        <tr key={row.taskId} className="border-b border-white/5">
                          <td className="py-3 pr-4">
                            <Link
                              href={`/tasks/${row.taskId}`}
                              className="font-medium text-slate-100 hover:text-teal-200"
                            >
                              {row.title}
                            </Link>
                            {row.isBlocker && (
                              <span
                                className="ml-2 rounded-full border border-amber-300/25 bg-amber-300/[0.08] px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-amber-200"
                                title="This task blocks other open work, so its slips propagate downstream."
                              >
                                Blocker
                              </span>
                            )}
                          </td>
                          <td className="py-3 pr-4 font-mono text-slate-300">{row.pushes}</td>
                          <td className="py-3 pr-4 font-mono text-amber-200">
                            +{Math.round(row.totalDaysPushed)}d
                          </td>
                          <td className="py-3 pr-4 font-mono text-slate-400">
                            +{Math.round(row.worstPushDays)}d
                          </td>
                          <td className="py-3 pr-4 text-slate-400">
                            {formatDate(row.originalDueDate)}
                          </td>
                          <td className="py-3 text-slate-200">{formatDate(row.currentDueDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {data.scheduleHistory.truncated && (
                <p className="mt-3 text-xs text-slate-500">
                  Older history beyond the read cap was not analysed.
                </p>
              )}
            </SectionCard>
          </div>

          {/* ── Recommendations ──────────────────────────────────────────── */}
          {health.recommendations.length > 0 && (
            <div className="mt-6">
              <SectionCard>
                <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                  <AlarmClock className="text-teal-300" size={20} aria-hidden />
                  Suggestions
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  Ranked by the signal they address. Nothing here is applied automatically.
                </p>

                <ul className="mt-5 space-y-2">
                  {health.recommendations.map((recommendation) => (
                    <li
                      key={recommendation}
                      className="flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3 text-sm leading-6 text-slate-300"
                    >
                      <Layers className="mt-1 shrink-0 text-slate-500" size={14} aria-hidden />
                      <span>{recommendation}</span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </div>
          )}

          <p className="mt-6 text-xs text-slate-500">
            Generated {new Date(data.generatedAt).toLocaleString()} ·{" "}
            {data.scheduleHistory.changesConsidered} schedule change
            {data.scheduleHistory.changesConsidered === 1 ? "" : "s"} considered
          </p>
        </>
      )}
    </AppShell>
  );
}
