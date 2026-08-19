/**
 * Client-side shapes for the intelligence endpoints.
 *
 * These are **derived** from the domain types, not retyped beside them. That
 * distinction is the whole point of this file: the pages previously kept
 * hand-written copies of `HealthSignal`, `ProjectIntelligence` and
 * `RiskFinding`, and the copies had already drifted — the portfolio page's
 * `RiskFinding["kind"]` was missing `"crossProject"`, and the per-project page
 * had weakened the same field to `string`. Neither could be caught by the
 * compiler, because the response is cast at the `fetch` boundary.
 *
 * Deriving them means a change to a domain type is a compile error here rather
 * than `undefined` at runtime.
 */

import type {
  Bottleneck,
  BlockingChain,
  DependencyCycle,
  DependencyRiskReport,
  PortfolioDependencyRiskReport,
  ProjectRiskAttribution,
  RiskFinding,
} from "@/lib/domain/dependency-risk";
import type {
  HealthBand,
  HealthConfidence,
  HealthSignal,
  PortfolioSummary,
  ProjectIntelligence,
  SignalSeverity,
  SlippageStats,
  TaskSlippage,
  VelocityTrend,
} from "@/lib/domain/project-intelligence";

/**
 * What a domain type looks like after `JSON.stringify` → `JSON.parse`.
 *
 * `Date` becomes an ISO string; everything else keeps its shape. Applied
 * recursively so nested objects and arrays are covered. Functions are not
 * modelled because nothing crossing this boundary carries one.
 */
export type Serialized<T> = T extends Date
  ? string
  : T extends Array<infer Item>
    ? Array<Serialized<Item>>
    : T extends object
      ? { [Key in keyof T]: Serialized<T[Key]> }
      : T;

// ── Health ────────────────────────────────────────────────────────────────

export type Severity = SignalSeverity;
export type Band = HealthBand;

export type ApiHealthSignal = Serialized<HealthSignal>;
export type ApiHealthConfidence = Serialized<HealthConfidence>;
export type ApiVelocityTrend = Serialized<VelocityTrend>;
export type ApiSlippageStats = Serialized<SlippageStats>;
export type ApiTaskSlippage = Serialized<TaskSlippage>;
export type ApiProjectIntelligence = Serialized<ProjectIntelligence>;

// ── Dependency risk ───────────────────────────────────────────────────────

export type ApiBottleneck = Serialized<Bottleneck>;
export type ApiDependencyCycle = Serialized<DependencyCycle>;
export type ApiBlockingChain = Serialized<BlockingChain>;
export type ApiRiskFinding = Serialized<RiskFinding>;
export type ApiDependencyRiskReport = Serialized<DependencyRiskReport>;
export type ApiProjectRiskAttribution = Serialized<ProjectRiskAttribution>;
export type ApiPortfolioSummary = Serialized<PortfolioSummary>;
export type ApiPortfolioDependencyRiskReport = Serialized<PortfolioDependencyRiskReport>;

/** How the schedule-history read cap is reported. Shared by both endpoints. */
export type ScheduleHistoryMeta = {
  changesConsidered: number;
  truncated: boolean;
};

// ── Endpoint responses ────────────────────────────────────────────────────

/** One cross-project dependency edge as the per-project route projects it. */
export type ApiCrossProjectEdge = {
  edgeId: string;
  direction: "inbound" | "outbound";
  otherTaskId: string;
  otherProject: { id: string; name: string } | null;
  type: string;
};

/** `GET /api/v1/intelligence/projects/[projectId]`. */
export type ProjectIntelligenceResponse = {
  generatedAt: string;
  readOnly: boolean;
  project: { id: string; name: string; status: string };
  health: ApiProjectIntelligence;
  risk: ApiDependencyRiskReport;
  slippageRetrospective: ApiTaskSlippage[];
  crossProject: {
    edges: ApiCrossProjectEdge[];
    inbound: number;
    outbound: number;
  };
  scheduleHistory: ScheduleHistoryMeta;
};

/**
 * `GET /api/v1/intelligence/overview`.
 *
 * `dependencyRisk` is the tenant-wide graph view — cycles and bottlenecks that
 * belong to no single project. The portfolio page does not render it today, but
 * it is declared because it is part of the contract; leaving it out is how the
 * previous hand-written copies started drifting.
 */
export type IntelligenceOverviewResponse = {
  generatedAt: string;
  readOnly: boolean;
  portfolio: ApiPortfolioSummary;
  projects: ApiProjectIntelligence[];
  risk: ApiProjectRiskAttribution[];
  dependencyRisk: Pick<
    ApiPortfolioDependencyRiskReport,
    | "blockingEdgeCount"
    | "bottlenecks"
    | "crossProjectEdgeCount"
    | "crossProjectEdges"
    | "cycles"
    | "findings"
    | "headline"
    | "longestChain"
  >;
  scheduleHistory: ScheduleHistoryMeta;
};
