/**
 * Behavioral tests for the Stage 2 intelligence engines.
 *
 * Run with Node 22+:
 *   node --experimental-strip-types scripts/test-intelligence.ts
 *
 * These test behaviour, not implementation: the assertions describe what a user
 * of the API would observe. Several of them exist specifically to pin bugs found
 * in the previous scorer so they cannot come back.
 */

import {
  analyzeDependencyRisk,
  analyzePortfolioDependencyRisk,
  buildBlockingGraph,
  downstreamOf,
  findBottlenecks,
  findCycles,
  longestBlockingChain,
  wouldCreateCycle,
  type PortfolioRiskTask,
  type RiskDependency,
  type RiskTask,
} from "../src/lib/domain/dependency-risk.ts";

import {
  edgesForProject,
  edgeTouchesProject,
  flattenDependencies,
  type NestedDependencyRow,
} from "../src/lib/dependencies/scope.ts";

import {
  analyzeProjectHealth,
  bandForScore,
  blockerIdsFrom,
  scheduleChangesFromActivity,
  slippageByTask,
  slippageStats,
  SIGNAL_WEIGHTS,
  summarizePortfolio,
  velocityTrend,
  type IntelMilestone,
  type IntelProject,
  type IntelTask,
  type ScheduleChange,
} from "../src/lib/domain/project-intelligence.ts";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${name}`);
  if (detail !== undefined) {
    console.error(`        got: ${JSON.stringify(detail, null, 2).slice(0, 900)}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

const NOW = new Date("2026-08-12T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const daysAhead = (n: number) => new Date(NOW.getTime() + n * DAY);

function task(over: Partial<IntelTask> & { id: string }): IntelTask {
  return {
    assignedToUserId: "u1",
    completedAt: null,
    createdAt: daysAgo(60),
    dueDate: null,
    priority: "MEDIUM",
    status: "TODO",
    title: `Task ${over.id}`,
    ...over,
  };
}

function riskTask(over: Partial<RiskTask> & { id: string }): RiskTask {
  return {
    assignedToUserId: "u1",
    dueDate: null,
    priority: "MEDIUM",
    status: "TODO",
    title: `Task ${over.id}`,
    ...over,
  };
}

function dep(source: string, target: string, type: RiskDependency["type"] = "BLOCKS"): RiskDependency {
  return { id: `${source}-${target}-${type}`, sourceTaskId: source, targetTaskId: target, type };
}

const PROJECT: IntelProject = {
  endDate: null,
  id: "p1",
  name: "Roadmap Q3",
  startDate: daysAgo(90),
  status: "ACTIVE",
};

function analyze(
  tasks: IntelTask[],
  opts: {
    milestones?: IntelMilestone[];
    changes?: ScheduleChange[];
    blockers?: Set<string>;
    project?: IntelProject;
  } = {},
) {
  return analyzeProjectHealth(
    opts.project ?? PROJECT,
    tasks,
    opts.milestones ?? [],
    opts.changes ?? [],
    opts.blockers ?? new Set<string>(),
    NOW,
  );
}

// ===========================================================================
section("Graph construction");
// ===========================================================================

{
  // DEPENDS_ON is the same relationship from the other end and must normalize
  // to the same blocker -> blocked edge as BLOCKS.
  const viaBlocks = buildBlockingGraph([dep("a", "b", "BLOCKS")]);
  const viaDepends = buildBlockingGraph([dep("b", "a", "DEPENDS_ON")]);

  check("BLOCKS a->b gives one edge", viaBlocks.edgeCount === 1, viaBlocks.edgeCount);
  check(
    "DEPENDS_ON normalizes to the same direction",
    JSON.stringify([...viaDepends.downstream.entries()]) ===
      JSON.stringify([...viaBlocks.downstream.entries()]),
    { blocks: [...viaBlocks.downstream], depends: [...viaDepends.downstream] },
  );
}

{
  const graph = buildBlockingGraph([dep("a", "b", "RELATED_TO")]);
  check("RELATED_TO creates no blocking edge", graph.edgeCount === 0 && graph.nodes.size === 0, graph);
}

{
  const graph = buildBlockingGraph([dep("a", "a")]);
  check("self-edge is dropped", graph.edgeCount === 0, graph);
}

{
  // The same pair expressed both ways must not count twice — double counting
  // would inflate a bottleneck's apparent fan-out.
  const graph = buildBlockingGraph([dep("a", "b", "BLOCKS"), dep("b", "a", "DEPENDS_ON")]);
  check("duplicate pair is de-duplicated", graph.edgeCount === 1, graph.edgeCount);
}

{
  const forward = buildBlockingGraph([dep("a", "c"), dep("a", "b")]);
  const reverse = buildBlockingGraph([dep("a", "b"), dep("a", "c")]);
  check(
    "adjacency is sorted so output is order-independent",
    JSON.stringify(forward.downstream.get("a")) === JSON.stringify(reverse.downstream.get("a")),
    { forward: forward.downstream.get("a"), reverse: reverse.downstream.get("a") },
  );
}

// ===========================================================================
section("Reachability");
// ===========================================================================

{
  const graph = buildBlockingGraph([dep("a", "b"), dep("b", "c"), dep("c", "d")]);
  const reach = downstreamOf(graph, "a");

  check("transitive reachability follows the chain", reach.size === 3, [...reach]);
  check("reachability excludes the start node", !reach.has("a"), [...reach]);
  check("leaf reaches nothing", downstreamOf(graph, "d").size === 0);
}

{
  // A cycle must terminate rather than spin forever.
  const graph = buildBlockingGraph([dep("a", "b"), dep("b", "c"), dep("c", "a")]);
  const reach = downstreamOf(graph, "a");
  check("reachability terminates inside a cycle", reach.size === 2, [...reach]);
}

{
  // Deep chain: proves the traversal is iterative, not recursive. A recursive
  // implementation blows the stack well before 10,000 frames.
  const deep: RiskDependency[] = [];
  for (let i = 0; i < 10000; i += 1) {
    deep.push(dep(`n${i}`, `n${i + 1}`));
  }
  const graph = buildBlockingGraph(deep);
  let threw = false;
  let size = 0;
  try {
    size = downstreamOf(graph, "n0").size;
  } catch {
    threw = true;
  }
  check("10k-deep chain does not overflow the stack", !threw && size === 10000, { size, threw });
}

// ===========================================================================
section("Cycle detection");
// ===========================================================================

{
  const graph = buildBlockingGraph([dep("a", "b"), dep("b", "c"), dep("c", "a")]);
  const cycles = findCycles(graph, (id) => `T-${id}`);

  check("a 3-node cycle is found", cycles.length === 1, cycles);
  check(
    "cycle is reported once, not once per member",
    cycles.length === 1,
    cycles.map((c) => c.path),
  );
  check(
    "cycle path closes on itself",
    cycles[0].path[0] === cycles[0].path[cycles[0].path.length - 1],
    cycles[0].path,
  );
  check("cycle contains all three nodes", new Set(cycles[0].path).size === 3, cycles[0].path);
  check("cycle titles are resolved", cycles[0].titles.every((t) => t.startsWith("T-")), cycles[0].titles);
}

{
  const acyclic = buildBlockingGraph([dep("a", "b"), dep("a", "c"), dep("b", "d"), dep("c", "d")]);
  check("diamond is not a cycle", findCycles(acyclic, (id) => id).length === 0);
}

{
  const two = buildBlockingGraph([dep("a", "b"), dep("b", "a")]);
  check("2-node cycle is found", findCycles(two, (id) => id).length === 1);
}

{
  // Two independent cycles must both be reported.
  const graph = buildBlockingGraph([dep("a", "b"), dep("b", "a"), dep("x", "y"), dep("y", "x")]);
  check("two disjoint cycles are both found", findCycles(graph, (id) => id).length === 2);
}

// ===========================================================================
section("Longest blocking chain");
// ===========================================================================

{
  const tasks = ["a", "b", "c", "d"].map((id) => riskTask({ id }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const graph = buildBlockingGraph([dep("a", "b"), dep("b", "c"), dep("c", "d")]);
  const chain = longestBlockingChain(graph, byId);

  check("chain length counts nodes", chain.length === 4, chain);
  check("chain path is in order", JSON.stringify(chain.path) === JSON.stringify(["a", "b", "c", "d"]), chain.path);
  check("chain counts open tasks", chain.openCount === 4, chain);
}

{
  const tasks = ["a", "b", "c"].map((id) => riskTask({ id, status: id === "a" ? "DONE" : "TODO" }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const graph = buildBlockingGraph([dep("a", "b"), dep("b", "c")]);
  const chain = longestBlockingChain(graph, byId);
  check("done tasks are excluded from openCount but stay in the path", chain.openCount === 2 && chain.length === 3, chain);
}

{
  const graph = buildBlockingGraph([]);
  check("empty graph has no chain", longestBlockingChain(graph, new Map()).length === 0);
}

{
  // Cyclic graph must not hang or report an infinite chain.
  const tasks = ["a", "b", "c"].map((id) => riskTask({ id }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const graph = buildBlockingGraph([dep("a", "b"), dep("b", "c"), dep("c", "a")]);
  let threw = false;
  let len = -1;
  try {
    len = longestBlockingChain(graph, byId).length;
  } catch {
    threw = true;
  }
  check("cyclic graph yields a finite chain without throwing", !threw && len <= 3 && len >= 0, { len, threw });
}

// ===========================================================================
section("Bottlenecks");
// ===========================================================================

{
  const tasks = [
    riskTask({ id: "gate" }),
    riskTask({ id: "b1" }),
    riskTask({ id: "b2" }),
    riskTask({ id: "b3" }),
  ];
  const deps = [dep("gate", "b1"), dep("gate", "b2"), dep("b2", "b3")];
  const found = findBottlenecks(tasks, deps, NOW);

  const gate = found.find((b) => b.taskId === "gate");
  check("the gating task is identified", gate !== undefined, found.map((b) => b.taskId));
  check("direct count is direct only", gate?.directBlockedCount === 2, gate);
  check("total count is transitive", gate?.totalBlockedCount === 3, gate);
  check("gate outranks its own dependent", found[0].taskId === "gate", found.map((b) => b.taskId));
  check("gate is actionable with no upstream", gate?.actionableNow === true, gate);
}

{
  // A DONE task blocks nothing, even though its edges still exist.
  const tasks = [riskTask({ id: "done", status: "DONE" }), riskTask({ id: "b1" })];
  const found = findBottlenecks(tasks, [dep("done", "b1")], NOW);
  check("completed tasks are never bottlenecks", found.length === 0, found);
}

{
  // Blocking only completed work is not a bottleneck.
  const tasks = [riskTask({ id: "gate" }), riskTask({ id: "b1", status: "DONE" })];
  check(
    "blocking only DONE tasks is not a bottleneck",
    findBottlenecks(tasks, [dep("gate", "b1")], NOW).length === 0,
  );
}

{
  const tasks = [riskTask({ id: "lonely" }), riskTask({ id: "other" })];
  check("tasks blocking nothing are omitted entirely", findBottlenecks(tasks, [], NOW).length === 0);
}

{
  // Severity must respond to downstream priority and overdueness.
  const mild = findBottlenecks(
    [riskTask({ id: "g" }), riskTask({ id: "b" })],
    [dep("g", "b")],
    NOW,
  );
  const severe = findBottlenecks(
    [
      riskTask({ id: "g", status: "BLOCKED", dueDate: daysAgo(5) }),
      riskTask({ id: "b1", priority: "URGENT", dueDate: daysAgo(3) }),
      riskTask({ id: "b2", priority: "HIGH", dueDate: daysAgo(2) }),
      riskTask({ id: "b3", priority: "URGENT", dueDate: daysAgo(1) }),
      riskTask({ id: "b4", priority: "HIGH" }),
    ],
    [dep("g", "b1"), dep("g", "b2"), dep("g", "b3"), dep("g", "b4")],
    NOW,
  );

  check("a single low-impact blocker is not critical", mild[0].severity !== "critical", mild[0]);
  check("many urgent overdue dependents is critical", severe[0].severity === "critical", severe[0]);
  check("severe bottleneck scores higher", severe[0].impactScore > mild[0].impactScore, {
    mild: mild[0].impactScore,
    severe: severe[0].impactScore,
  });
}

{
  const found = findBottlenecks(
    [riskTask({ id: "g", assignedToUserId: null }), riskTask({ id: "b" })],
    [dep("g", "b")],
    NOW,
  );
  check(
    "unassigned blocker is called out",
    found[0].reasons.some((r) => r.toLowerCase().includes("unassigned")),
    found[0].reasons,
  );
  check(
    "unassigned + actionable recommends assigning an owner",
    found[0].recommendation.toLowerCase().includes("assign"),
    found[0].recommendation,
  );
}

{
  // Every bottleneck must explain itself and suggest something.
  const found = findBottlenecks(
    [riskTask({ id: "g" }), riskTask({ id: "b1" }), riskTask({ id: "b2" })],
    [dep("g", "b1"), dep("g", "b2")],
    NOW,
  );
  for (const item of found) {
    check(`bottleneck ${item.taskId} has reasons`, item.reasons.length > 0, item);
    check(`bottleneck ${item.taskId} has a recommendation`, item.recommendation.length > 10, item);
    check(
      `bottleneck ${item.taskId} first reason mentions the blocked count`,
      item.reasons[0].includes(String(item.openBlockedCount)),
      item.reasons[0],
    );
  }
}

{
  // Recommendations must never read as an automated action.
  const found = findBottlenecks(
    [riskTask({ id: "g" }), riskTask({ id: "b" })],
    [dep("g", "b")],
    NOW,
  );
  const forbidden = ["automatically", "i have ", "we have updated", "has been changed", "reassigned it"];
  check(
    "recommendations never claim the system acted",
    !forbidden.some((phrase) => found[0].recommendation.toLowerCase().includes(phrase)),
    found[0].recommendation,
  );
}

{
  const tasks = Array.from({ length: 30 }, (_, i) => riskTask({ id: `t${i}` }));
  const deps = Array.from({ length: 29 }, (_, i) => dep(`t${i}`, `t${i + 1}`));
  check("limit is respected", findBottlenecks(tasks, deps, NOW, 5).length === 5);
}

// ===========================================================================
section("Dependency risk report");
// ===========================================================================

{
  const report = analyzeDependencyRisk([], [], NOW);
  check("empty project reports no risk", report.findings[0].kind === "clear", report.findings);
  check("empty project has zero counts", report.blockingEdgeCount === 0 && report.taskCount === 0, report);
}

{
  const tasks = ["a", "b", "c"].map((id) => riskTask({ id }));
  const report = analyzeDependencyRisk(tasks, [dep("a", "b"), dep("b", "c"), dep("c", "a")], NOW);

  check("cycle produces a critical finding", report.findings[0].level === "critical", report.findings[0]);
  check("cycle finding is first", report.findings[0].kind === "cycle", report.findings[0]);
  check(
    "cycle finding names the tasks for deep-linking",
    report.findings[0].taskIds.length === 3,
    report.findings[0].taskIds,
  );
  check(
    "cycle detail explains the deadlock",
    report.findings[0].detail.toLowerCase().includes("none of them can start"),
    report.findings[0].detail,
  );
}

{
  const tasks = ["a", "b", "c", "d", "e"].map((id) => riskTask({ id }));
  const report = analyzeDependencyRisk(
    tasks,
    [dep("a", "b"), dep("b", "c"), dep("c", "d"), dep("d", "e")],
    NOW,
  );
  check(
    "long chain produces a chain finding",
    report.findings.some((f) => f.kind === "chain"),
    report.findings.map((f) => f.kind),
  );
  check("chain length is reported", report.longestChain.length === 5, report.longestChain);
}

{
  const tasks = ["hub", "a", "b", "c", "d"].map((id) => riskTask({ id }));
  const report = analyzeDependencyRisk(
    tasks,
    [dep("hub", "a"), dep("hub", "b"), dep("hub", "c"), dep("hub", "d")],
    NOW,
  );
  check(
    "high fan-out produces a hub finding",
    report.findings.some((f) => f.kind === "hub"),
    report.findings.map((f) => f.kind),
  );
  check(
    "hub finding suggests splitting",
    report.findings.find((f) => f.kind === "hub")?.detail.includes("splitting"),
    report.findings.find((f) => f.kind === "hub")?.detail,
  );
}

// ===========================================================================
section("Health — size normalization (the bug the old scorer had)");
// ===========================================================================

{
  // The previous implementation did `score -= overdueTasks * 8`, so 13 overdue
  // tasks scored 0 regardless of project size. These two projects have the SAME
  // number of overdue tasks but wildly different totals, and must not score the
  // same.
  const overdue = (id: string) => task({ dueDate: daysAgo(5), id });
  const healthy = (id: string) => task({ dueDate: daysAhead(10), id });

  const small = analyze([
    ...Array.from({ length: 13 }, (_, i) => overdue(`s-o${i}`)),
    ...Array.from({ length: 2 }, (_, i) => healthy(`s-h${i}`)),
  ]);

  const large = analyze([
    ...Array.from({ length: 13 }, (_, i) => overdue(`l-o${i}`)),
    ...Array.from({ length: 187 }, (_, i) => healthy(`l-h${i}`)),
  ]);

  check(
    "13 overdue of 15 is much worse than 13 overdue of 200",
    large.score > small.score + 15,
    { largeScore: large.score, smallScore: small.score },
  );
  check(
    "the large project is NOT critical (old formula said it was)",
    large.band === "Healthy" || large.band === "Watch",
    { band: large.band, score: large.score },
  );
  check("the small project is genuinely at risk", small.score < 80, { score: small.score, band: small.band });
  check(
    "overdue signal never exceeds its weight cap",
    (small.factors.find((f) => f.key === "overdue")?.points ?? 0) <= SIGNAL_WEIGHTS.overdue,
    small.factors,
  );
}

{
  // No signal may exceed its cap, and the score must equal 100 minus the sum.
  const analysis = analyze(
    [
      ...Array.from({ length: 10 }, (_, i) => task({ dueDate: daysAgo(9), id: `o${i}`, status: "BLOCKED" })),
    ],
    {
      milestones: [{ dueDate: daysAgo(3), id: "m1", name: "Beta", status: "MISSED" }],
      project: { ...PROJECT, endDate: daysAgo(10) },
    },
  );

  const sum = [...analysis.factors, ...analysis.healthy].reduce((t, f) => t + f.points, 0);
  check("score equals 100 minus the sum of all signal points", analysis.score === Math.max(0, 100 - sum), {
    score: analysis.score,
    sum,
  });
  check("score never goes below 0", analysis.score >= 0, analysis.score);
  for (const f of [...analysis.factors, ...analysis.healthy]) {
    check(`${f.key} respects its cap`, f.points <= f.maxPoints, f);
  }
}

{
  const weightSum = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0);
  check("signal weights sum to 100 so the score is interpretable", weightSum === 100, weightSum);
}

// ===========================================================================
section("Health — explanations");
// ===========================================================================

{
  // A genuinely clean project: open work all due in future, AND steady recent
  // delivery. Note that "10 open tasks and nothing ever completed" is NOT clean
  // — that is the noDeliveries case, asserted separately below.
  const clean = analyze([
    ...Array.from({ length: 10 }, (_, i) => task({ dueDate: daysAhead(20), id: `c${i}` })),
    ...Array.from({ length: 3 }, (_, i) => task({ id: `dr${i}`, status: "DONE", completedAt: daysAgo(3 + i) })),
    ...Array.from({ length: 3 }, (_, i) => task({ id: `dp${i}`, status: "DONE", completedAt: daysAgo(35 + i) })),
  ]);

  check("a clean project has no cost factors", clean.factors.length === 0, clean.factors);
  check("a clean project still lists what was checked", clean.healthy.length === 6, clean.healthy.length);
  check("a clean project scores 100", clean.score === 100 && clean.band === "Healthy", clean);
  check(
    "healthy signals do not masquerade as reasons",
    clean.factors.every((f) => f.points > 0),
    clean.factors,
  );
  check("steady delivery is recognised", clean.velocity.direction === "steady", clean.velocity);
}

{
  // Never having completed anything is a real but weaker signal than stalling
  // after real throughput — we cannot tell it apart from stale task statuses.
  const nothingDone = analyze(
    Array.from({ length: 10 }, (_, i) => task({ dueDate: daysAhead(20), id: `n${i}` })),
  );
  const factor = nothingDone.factors.find((f) => f.key === "velocity");

  check("a project with zero completions is flagged", factor !== undefined, nothingDone.factors);
  check("noDeliveries direction is reported", nothingDone.velocity.direction === "noDeliveries", nothingDone.velocity);
  check(
    "noDeliveries costs half the velocity weight, not all of it",
    factor?.points === Math.round(SIGNAL_WEIGHTS.velocity * 0.5),
    factor,
  );
  check(
    "noDeliveries detail admits the ambiguity",
    factor?.detail.toLowerCase().includes("statuses are not being updated"),
    factor?.detail,
  );

  // And a true stall must cost strictly more than never having started.
  const trueStall = analyze([
    ...Array.from({ length: 6 }, (_, i) => task({ id: `p${i}`, status: "DONE", completedAt: daysAgo(40) })),
    ...Array.from({ length: 4 }, (_, i) => task({ id: `o${i}`, dueDate: daysAhead(30) })),
  ]);
  const stallFactor = trueStall.factors.find((f) => f.key === "velocity");
  check(
    "a true stall costs more than never delivering",
    (stallFactor?.points ?? 0) > (factor?.points ?? 0),
    { neverDelivered: factor?.points, trueStall: stallFactor?.points },
  );
}

{
  const messy = analyze(
    [
      ...Array.from({ length: 6 }, (_, i) => task({ dueDate: daysAgo(4), id: `o${i}` })),
      ...Array.from({ length: 3 }, (_, i) => task({ id: `b${i}`, status: "BLOCKED" })),
      ...Array.from({ length: 6 }, (_, i) => task({ id: `d${i}`, status: "DONE", completedAt: daysAgo(40) })),
    ],
  );

  check("factors are ordered by points, worst first",
    messy.factors.every((f, i) => i === 0 || messy.factors[i - 1].points >= f.points),
    messy.factors.map((f) => [f.key, f.points]),
  );
  check("every factor carries its raw numbers", messy.factors.every((f) => Object.keys(f.evidence).length > 0), messy.factors);
  check("every factor detail contains a digit", messy.factors.every((f) => /\d/.test(f.detail)), messy.factors.map((f) => f.detail));
  check("summary names the top driver", messy.summary.includes(messy.factors[0].label.toLowerCase()), messy.summary);
  check("summary states the score", messy.summary.includes(String(messy.score)), messy.summary);
  check("recommendations exist for a messy project", messy.recommendations.length > 0, messy.recommendations);
}

{
  // Recommendations must be advisory, never claim the system acted.
  const messy = analyze([
    ...Array.from({ length: 5 }, (_, i) => task({ dueDate: daysAgo(4), id: `o${i}` })),
  ]);
  const forbidden = ["automatically", "i have updated", "we changed", "has been reassigned"];
  check(
    "no recommendation claims the system modified data",
    messy.recommendations.every((r) => !forbidden.some((p) => r.toLowerCase().includes(p))),
    messy.recommendations,
  );
}

// ===========================================================================
section("Health — velocity");
// ===========================================================================

{
  const declining = velocityTrend(
    [
      ...Array.from({ length: 8 }, (_, i) => task({ id: `p${i}`, status: "DONE", completedAt: daysAgo(40) })),
      ...Array.from({ length: 2 }, (_, i) => task({ id: `r${i}`, status: "DONE", completedAt: daysAgo(5) })),
    ],
    NOW,
  );
  check("declining throughput is detected", declining.direction === "declining", declining);
  check("change ratio is negative", (declining.changeRatio ?? 0) < 0, declining);
}

{
  const stalled = velocityTrend(
    Array.from({ length: 6 }, (_, i) => task({ id: `p${i}`, status: "DONE", completedAt: daysAgo(40) })),
    NOW,
  );
  check("zero recent completions after activity is stalled, not declining", stalled.direction === "stalled", stalled);
}

{
  const improving = velocityTrend(
    [
      task({ id: "p1", status: "DONE", completedAt: daysAgo(40) }),
      ...Array.from({ length: 6 }, (_, i) => task({ id: `r${i}`, status: "DONE", completedAt: daysAgo(4) })),
    ],
    NOW,
  );
  check("improving throughput is detected", improving.direction === "improving", improving);
}

{
  // A brand-new project must not be punished for having no history.
  const fresh = analyze(
    Array.from({ length: 3 }, (_, i) => task({ createdAt: daysAgo(2), id: `n${i}` })),
  );
  const velocityFactor = fresh.factors.find((f) => f.key === "velocity");
  check("a new project loses no points for unknown velocity", velocityFactor === undefined, fresh.factors);
  check("a new project reports unknown direction", fresh.velocity.direction === "unknown", fresh.velocity);
}

{
  const stalledAnalysis = analyze([
    ...Array.from({ length: 6 }, (_, i) => task({ id: `p${i}`, status: "DONE", completedAt: daysAgo(40) })),
    ...Array.from({ length: 4 }, (_, i) => task({ id: `o${i}`, dueDate: daysAhead(30) })),
  ]);
  const factor = stalledAnalysis.factors.find((f) => f.key === "velocity");
  check("a stalled project loses the full velocity weight", factor?.points === SIGNAL_WEIGHTS.velocity, factor);
}

// ===========================================================================
section("Health — slippage");
// ===========================================================================

{
  const stats = slippageStats(
    [
      { changedAt: daysAgo(5), fromDueDate: daysAgo(10), taskId: "t1", toDueDate: daysAhead(4) },
      { changedAt: daysAgo(3), fromDueDate: daysAhead(4), taskId: "t1", toDueDate: daysAhead(10) },
    ],
    new Set(["t1"]),
  );

  check("pushes are counted", stats.pushCount === 2, stats);
  check("distinct tasks pushed is 1", stats.tasksPushed === 1, stats);
  check("blocker pushes are tracked", stats.blockerPushCount === 2, stats);
  check("total days pushed accumulates", stats.totalDaysPushed === 20, stats);
  check("worst single push is captured", stats.worstPushDays === 14, stats);
}

{
  const stats = slippageStats(
    [{ changedAt: NOW, fromDueDate: daysAhead(10), taskId: "t1", toDueDate: daysAhead(2) }],
    new Set(),
  );
  check("pulling a date earlier is not slippage", stats.pushCount === 0 && stats.pullCount === 1, stats);
}

{
  const stats = slippageStats(
    [{ changedAt: NOW, fromDueDate: null, taskId: "t1", toDueDate: daysAhead(5) }],
    new Set(),
  );
  check("setting a first due date is not slippage", stats.pushCount === 0, stats);
}

{
  const stats = slippageStats([], new Set());
  check("no history is flagged distinctly from no slippage", stats.noHistory === true && stats.pushCount === 0, stats);
}

{
  // Honesty requirement: zero slippage with no history must not read as "good".
  const analysis = analyze(Array.from({ length: 10 }, (_, i) => task({ id: `t${i}`, dueDate: daysAhead(10) })));
  const slipSignal = [...analysis.factors, ...analysis.healthy].find((f) => f.key === "slippage");
  check(
    "no-history slippage explains it is unknown, not good",
    slipSignal?.detail.toLowerCase().includes("unknown"),
    slipSignal?.detail,
  );
  check(
    "no-history slippage is listed as a confidence caveat",
    analysis.confidence.caveats.some((c) => c.toLowerCase().includes("due-date history")),
    analysis.confidence.caveats,
  );
}

{
  // Slippage on a blocker must cost more than the same slippage in isolation.
  const changes: ScheduleChange[] = [
    { changedAt: daysAgo(2), fromDueDate: daysAgo(10), taskId: "t1", toDueDate: daysAhead(10) },
  ];
  const tasks = Array.from({ length: 10 }, (_, i) => task({ id: `t${i + 1}` }));

  const isolated = analyze(tasks, { changes, blockers: new Set() });
  const gating = analyze(tasks, { changes, blockers: new Set(["t1"]) });

  const isolatedPoints = [...isolated.factors, ...isolated.healthy].find((f) => f.key === "slippage")?.points ?? 0;
  const gatingPoints = [...gating.factors, ...gating.healthy].find((f) => f.key === "slippage")?.points ?? 0;

  check("slippage on a blocking task costs more", gatingPoints > isolatedPoints, { gatingPoints, isolatedPoints });
}

// ===========================================================================
section("Health — confidence");
// ===========================================================================

{
  const tiny = analyze([task({ id: "t1" }), task({ id: "t2" })]);
  check("a 2-task project has low confidence", tiny.confidence.level !== "high", tiny.confidence);
  check("confidence explains why", tiny.confidence.caveats.length > 0, tiny.confidence);
  check(
    "the caveat mentions the task count",
    tiny.confidence.caveats.some((c) => c.includes("2 tasks")),
    tiny.confidence.caveats,
  );
}

{
  const empty = analyze([]);
  check("an empty project is insufficient, not healthy", empty.confidence.level === "insufficient", empty.confidence);
  check("an empty project does not crash", empty.score >= 0 && empty.score <= 100, empty.score);
  check("an empty project reports 0% completion", empty.completion === 0, empty.completion);
}

{
  const solid = analyze([
    ...Array.from({ length: 20 }, (_, i) => task({ id: `d${i}`, status: "DONE", completedAt: daysAgo(10 + i), createdAt: daysAgo(80) })),
    ...Array.from({ length: 10 }, (_, i) => task({ id: `o${i}`, dueDate: daysAhead(20), createdAt: daysAgo(80) })),
  ], {
    changes: [{ changedAt: daysAgo(5), fromDueDate: daysAgo(9), taskId: "o1", toDueDate: daysAgo(8) }],
  });
  check("a mature project reaches high confidence", solid.confidence.level === "high", solid.confidence);
}

// ===========================================================================
section("Health — bands");
// ===========================================================================

{
  check("100 is healthy", bandForScore(100) === "Healthy");
  check("82 is the healthy floor", bandForScore(82) === "Healthy");
  check("81 drops to watch", bandForScore(81) === "Watch");
  check("66 is the watch floor", bandForScore(66) === "Watch");
  check("65 drops to at risk", bandForScore(65) === "At risk");
  check("45 is the at-risk floor", bandForScore(45) === "At risk");
  check("44 is critical", bandForScore(44) === "Critical");
  check("0 is critical", bandForScore(0) === "Critical");
}

// ===========================================================================
section("Activity log adapter");
// ===========================================================================

{
  const rows = [
    {
      action: "task.updated",
      createdAt: daysAgo(3),
      entityId: "t1",
      entityType: "task",
      metadata: { fromDueDate: daysAgo(10).toISOString(), toDueDate: daysAhead(2).toISOString() },
    },
    // Predates due-date recording — no from/to keys.
    {
      action: "task.updated",
      createdAt: daysAgo(20),
      entityId: "t2",
      entityType: "task",
      metadata: { changedFields: "title", fromStatus: "TODO", toStatus: "TODO" },
    },
    // Wrong entity type.
    {
      action: "task.updated",
      createdAt: daysAgo(1),
      entityId: "p1",
      entityType: "project",
      metadata: { fromDueDate: daysAgo(1).toISOString(), toDueDate: daysAhead(1).toISOString() },
    },
    // Malformed metadata must not throw.
    { action: "task.updated", createdAt: daysAgo(2), entityId: "t3", entityType: "task", metadata: null },
    { action: "task.updated", createdAt: daysAgo(2), entityId: "t4", entityType: "task", metadata: "nonsense" },
    {
      action: "task.updated",
      createdAt: daysAgo(2),
      entityId: "t5",
      entityType: "task",
      metadata: { fromDueDate: "not-a-date", toDueDate: "also-bad" },
    },
  ];

  let threw = false;
  let changes: ScheduleChange[] = [];
  try {
    changes = scheduleChangesFromActivity(rows);
  } catch {
    threw = true;
  }

  check("adapter does not throw on malformed rows", !threw);
  check("only the well-formed task row is extracted", changes.length === 1, changes);
  check("the extracted change has both dates", changes[0]?.fromDueDate !== null && changes[0]?.toDueDate !== null, changes[0]);
  check("legacy rows without due-date keys are skipped", !changes.some((c) => c.taskId === "t2"), changes);
  check("non-task entities are skipped", !changes.some((c) => c.taskId === "p1"), changes);
}

{
  const rows = [
    { action: "task.updated", createdAt: daysAgo(1), entityId: "b", entityType: "task", metadata: { fromDueDate: daysAgo(5).toISOString(), toDueDate: NOW.toISOString() } },
    { action: "task.updated", createdAt: daysAgo(5), entityId: "a", entityType: "task", metadata: { fromDueDate: daysAgo(9).toISOString(), toDueDate: NOW.toISOString() } },
  ];
  const changes = scheduleChangesFromActivity(rows);
  check("changes come back oldest first", changes[0].taskId === "a", changes.map((c) => c.taskId));
}

// ===========================================================================
section("blockerIdsFrom");
// ===========================================================================

{
  const open = new Set(["b"]);
  check("BLOCKS source is a blocker", blockerIdsFrom([{ sourceTaskId: "a", targetTaskId: "b", type: "BLOCKS" }], open).has("a"));
  check(
    "DEPENDS_ON target is the blocker",
    blockerIdsFrom([{ sourceTaskId: "b", targetTaskId: "a", type: "DEPENDS_ON" }], open).has("a"),
  );
  check(
    "RELATED_TO creates no blocker",
    blockerIdsFrom([{ sourceTaskId: "a", targetTaskId: "b", type: "RELATED_TO" }], open).size === 0,
  );
  check(
    "blocking a closed task does not count",
    blockerIdsFrom([{ sourceTaskId: "a", targetTaskId: "z", type: "BLOCKS" }], open).size === 0,
  );
}

// ===========================================================================
section("Portfolio");
// ===========================================================================

{
  const good = analyze(Array.from({ length: 10 }, (_, i) => task({ id: `g${i}`, dueDate: daysAhead(30) })));
  const bad = analyze(
    Array.from({ length: 10 }, (_, i) => task({ id: `b${i}`, dueDate: daysAgo(5), status: "BLOCKED" })),
    { project: { ...PROJECT, id: "p2", name: "Legacy migration" } },
  );

  const portfolio = summarizePortfolio([good, bad]);

  check("portfolio counts projects", portfolio.projectCount === 2, portfolio);
  check("worst score is the minimum", portfolio.worstScore === Math.min(good.score, bad.score), portfolio);
  check("attention order is worst first", portfolio.attentionOrder[0].score <= portfolio.attentionOrder[1].score, portfolio.attentionOrder);
  check("headline names the project needing attention", portfolio.headline.includes("Legacy migration"), portfolio.headline);
  check("band counts sum to project count", Object.values(portfolio.bandCounts).reduce((a, b) => a + b, 0) === 2, portfolio.bandCounts);
}

{
  const empty = summarizePortfolio([]);
  check("empty portfolio does not divide by zero", empty.averageScore === 0 && empty.projectCount === 0, empty);
  check("empty portfolio has a sensible headline", empty.headline.length > 0, empty.headline);
}

// ===========================================================================
section("Determinism");
// ===========================================================================

{
  const tasks = [
    ...Array.from({ length: 12 }, (_, i) => task({ id: `t${i}`, dueDate: i % 3 === 0 ? daysAgo(3) : daysAhead(5) })),
    ...Array.from({ length: 5 }, (_, i) => task({ id: `d${i}`, status: "DONE", completedAt: daysAgo(5 + i) })),
  ];
  const changes: ScheduleChange[] = [
    { changedAt: daysAgo(4), fromDueDate: daysAgo(8), taskId: "t1", toDueDate: daysAhead(3) },
  ];

  const first = JSON.stringify(analyze(tasks, { changes, blockers: new Set(["t1"]) }));
  let stable = true;
  for (let i = 0; i < 100; i += 1) {
    if (JSON.stringify(analyze(tasks, { changes, blockers: new Set(["t1"]) })) !== first) {
      stable = false;
      break;
    }
  }
  check("analyzeProjectHealth is deterministic over 100 runs", stable);

  // Shuffling input order must not change the output.
  const shuffled = [...tasks].reverse();
  check(
    "health is independent of task array order",
    JSON.stringify(analyze(shuffled, { changes, blockers: new Set(["t1"]) })) === first,
  );
}

{
  const tasks = ["a", "b", "c", "d", "e"].map((id) => riskTask({ id }));
  const deps = [dep("a", "b"), dep("a", "c"), dep("b", "d"), dep("c", "d"), dep("d", "e")];

  const first = JSON.stringify(analyzeDependencyRisk(tasks, deps, NOW));
  let stable = true;
  for (let i = 0; i < 100; i += 1) {
    if (JSON.stringify(analyzeDependencyRisk(tasks, deps, NOW)) !== first) {
      stable = false;
      break;
    }
  }
  check("analyzeDependencyRisk is deterministic over 100 runs", stable);

  check(
    "risk report is independent of dependency array order",
    JSON.stringify(analyzeDependencyRisk([...tasks].reverse(), [...deps].reverse(), NOW)) === first,
  );
}

// ===========================================================================
section("Purity — inputs are never mutated");
// ===========================================================================

{
  const tasks = [task({ id: "t1", dueDate: daysAgo(3) }), task({ id: "t2" })];
  const deps = [dep("t1", "t2")];
  const milestones: IntelMilestone[] = [{ dueDate: daysAhead(5), id: "m1", name: "M", status: "AT_RISK" }];
  const changes: ScheduleChange[] = [
    { changedAt: daysAgo(1), fromDueDate: daysAgo(5), taskId: "t1", toDueDate: NOW },
  ];

  const snapshot = JSON.stringify({ changes, deps, milestones, tasks });

  analyzeProjectHealth(PROJECT, tasks, milestones, changes, new Set(["t1"]), NOW);
  analyzeDependencyRisk(
    tasks.map((t) => ({ ...t, dueDate: t.dueDate })) as unknown as RiskTask[],
    deps,
    NOW,
  );

  check("no input array or object was mutated", JSON.stringify({ changes, deps, milestones, tasks }) === snapshot);
}

// ===========================================================================
section("Dependency scoping (two-sided project relevance)");
// ===========================================================================

function nested(
  id: string,
  source: string,
  sourceProject: string,
  target: string,
  targetProject: string,
  type: NestedDependencyRow["type"] = "BLOCKS",
): NestedDependencyRow {
  return {
    id,
    sourceTask: { projectId: sourceProject },
    sourceTaskId: source,
    targetTask: { projectId: targetProject },
    targetTaskId: target,
    type,
  };
}

{
  const flat = flattenDependencies([
    nested("e1", "a", "P1", "b", "P1"),
    nested("e2", "c", "P1", "d", "P2"),
  ]);

  check("intra-project edge is not marked cross-project", flat[0].crossProject === false, flat[0]);
  check("inter-project edge is marked cross-project", flat[1].crossProject === true, flat[1]);
  check("project ids are flattened onto the edge", flat[1].sourceProjectId === "P1" && flat[1].targetProjectId === "P2", flat[1]);
}

{
  // A row with a missing endpoint must be dropped, not turned into an edge with
  // an empty-string project.
  const flat = flattenDependencies([
    { ...nested("e1", "a", "P1", "b", "P1"), sourceTask: null },
    nested("e2", "c", "P1", "d", "P1"),
  ]);
  check("rows with a missing endpoint are dropped", flat.length === 1 && flat[0].id === "e2", flat);
}

{
  const flat = flattenDependencies([nested("e1", "a", "P1", "b", "P2")]);

  check("edge is relevant to the source's project", edgeTouchesProject(flat[0], "P1"));
  check("edge is ALSO relevant to the target's project", edgeTouchesProject(flat[0], "P2"));
  check("edge is not relevant to an unrelated project", !edgeTouchesProject(flat[0], "P3"));
}

{
  // The regression this scoping exists to prevent: an inbound edge must not
  // vanish from the blocked project's view.
  const flat = flattenDependencies([
    nested("in", "ext", "P2", "mine", "P1"),
    nested("out", "mine2", "P1", "ext2", "P2"),
    nested("own", "x", "P1", "y", "P1"),
  ]);

  const forP1 = edgesForProject(flat, "P1");
  check("all three edges are relevant to P1", forP1.length === 3, forP1.map((e) => e.id));
  check(
    "the INBOUND edge is included (one-sided filtering would drop it)",
    forP1.some((e) => e.id === "in"),
    forP1.map((e) => e.id),
  );

  const forP2 = edgesForProject(flat, "P2");
  check("P2 sees only its two boundary edges", forP2.length === 2, forP2.map((e) => e.id));
  check("P2 does not see P1's internal edge", !forP2.some((e) => e.id === "own"), forP2.map((e) => e.id));
}

// ===========================================================================
section("wouldCreateCycle (replaces the route's recursive check)");
// ===========================================================================

{
  const deps = [dep("a", "b"), dep("b", "c")];

  check("adding c→a closes a loop", wouldCreateCycle("c", "a", deps) === true);
  check("adding a→c is a shortcut, not a loop", wouldCreateCycle("a", "c", deps) === false);
  check("self-link is a cycle", wouldCreateCycle("a", "a", deps) === true);
  check("unrelated pair is fine", wouldCreateCycle("x", "y", deps) === false);
}

{
  // The old check treated RELATED_TO as blocking, so merely relating two tasks
  // could be rejected as circular. RELATED_TO carries no ordering.
  const deps = [dep("a", "b", "RELATED_TO"), dep("b", "c", "RELATED_TO")];
  check("RELATED_TO edges cannot create a cycle", wouldCreateCycle("c", "a", deps) === false);
}

{
  // DEPENDS_ON is the same relation from the other end and must be normalized
  // before the reachability test.
  const deps = [dep("b", "a", "DEPENDS_ON")]; // b depends on a  =>  a blocks b
  check("DEPENDS_ON is normalized for cycle checking", wouldCreateCycle("b", "a", deps) === true, {
    got: wouldCreateCycle("b", "a", deps),
  });
}

{
  // A diamond made the old recursive implementation exponential. This must be
  // fast and correct.
  const deps: RiskDependency[] = [];
  for (let i = 0; i < 24; i += 1) {
    deps.push(dep(`n${i}`, `n${i + 1}a`));
    deps.push(dep(`n${i}`, `n${i + 1}b`));
    deps.push(dep(`n${i + 1}a`, `n${i + 1}`));
    deps.push(dep(`n${i + 1}b`, `n${i + 1}`));
  }

  const started = Date.now();
  // n0 already reaches n24 through the diamonds, so making n24 block n0 closes
  // a loop. The reverse (n0 blocking n24) is only a shortcut, not a cycle.
  const closesLoop = wouldCreateCycle("n24", "n0", deps);
  const shortcut = wouldCreateCycle("n0", "n24", deps);
  const elapsed = Date.now() - started;

  check("24-layer diamond: back-edge is a cycle", closesLoop === true, closesLoop);
  check("24-layer diamond: forward shortcut is not a cycle", shortcut === false, shortcut);
  check("24-layer diamond resolves fast (memoised, not exponential)", elapsed < 500, `${elapsed}ms`);
}

// ===========================================================================
section("Cross-project dependency risk");
// ===========================================================================

function pTask(id: string, projectId: string, over: Partial<RiskTask> = {}): PortfolioRiskTask {
  return { ...riskTask({ id, ...over }), projectId };
}

const PROJECTS = [
  { id: "P1", name: "Platform" },
  { id: "P2", name: "Mobile" },
  { id: "P3", name: "Billing" },
];

{
  const tasks = [pTask("plat", "P1"), pTask("mob", "P2")];
  const report = analyzePortfolioDependencyRisk(tasks, [dep("plat", "mob")], PROJECTS, NOW);

  check("cross-project edge is counted", report.crossProjectEdgeCount === 1, report.crossProjectEdgeCount);
  check("edge records both project ids", report.crossProjectEdges[0].blockerProjectId === "P1" && report.crossProjectEdges[0].blockedProjectId === "P2", report.crossProjectEdges[0]);
  check("open blocker makes the edge live", report.crossProjectEdges[0].live === true, report.crossProjectEdges[0]);
  check(
    "a cross-project bottleneck is reported",
    report.findings.some((f) => f.kind === "crossProject"),
    report.findings.map((f) => f.kind),
  );
  check(
    "the finding names the blocked project by name, not id",
    report.findings.find((f) => f.kind === "crossProject")?.detail.includes("Mobile"),
    report.findings.find((f) => f.kind === "crossProject")?.detail,
  );
  check(
    "the finding explains why it was previously invisible",
    report.findings.find((f) => f.kind === "crossProject")?.detail.includes("single project board"),
    report.findings.find((f) => f.kind === "crossProject")?.detail,
  );
}

{
  const tasks = [pTask("a", "P1"), pTask("b", "P1")];
  const report = analyzePortfolioDependencyRisk(tasks, [dep("a", "b")], PROJECTS, NOW);

  check("intra-project edge is not counted as crossing", report.crossProjectEdgeCount === 0, report.crossProjectEdgeCount);
  check(
    "no crossProject finding for an internal edge",
    !report.findings.some((f) => f.kind === "crossProject"),
    report.findings.map((f) => f.kind),
  );
  check("headline says links stay within one project", report.headline.includes("within a single project"), report.headline);
}

{
  // THE case per-project analysis cannot see: a cycle spanning three projects.
  // No single project's subgraph contains a loop, so all three per-project
  // checks would report "no cycles".
  const tasks = [pTask("a", "P1"), pTask("b", "P2"), pTask("c", "P3")];
  const deps = [dep("a", "b"), dep("b", "c"), dep("c", "a")];

  const report = analyzePortfolioDependencyRisk(tasks, deps, PROJECTS, NOW);

  check("a cycle spanning 3 projects is found", report.cycles.length === 1, report.cycles);
  check("the cycle is flagged cross-project", report.cycles[0].crossProject === true, report.cycles[0]);
  check("the cycle lists all 3 projects", report.cycles[0].projectIds.length === 3, report.cycles[0].projectIds);
  check(
    "the cross-project cycle finding comes first",
    report.findings[0].kind === "cycle" && report.findings[0].level === "critical",
    report.findings[0],
  );
  check(
    "its headline says 'across 3 projects', not 'across 3 tasks'",
    report.findings[0].headline.includes("3 projects"),
    report.findings[0].headline,
  );
  check("headline warns no single board shows the loop", report.headline.includes("no single board"), report.headline);

  // Per-project analysis genuinely cannot see it — proving the point.
  const p1Only = analyzeDependencyRisk(
    tasks.filter((t) => t.projectId === "P1"),
    // Only edges wholly inside P1 — which is none of them.
    deps.filter((d) => {
      const s = tasks.find((t) => t.id === d.sourceTaskId)?.projectId;
      const t = tasks.find((task) => task.id === d.targetTaskId)?.projectId;
      return s === "P1" && t === "P1";
    }),
    NOW,
  );
  check(
    "control: per-project analysis of P1 alone finds no cycle",
    p1Only.cycles.length === 0,
    p1Only.cycles,
  );
}

{
  // A chain that leaves a project and comes back. Per-project analysis would see
  // two chains of length 2 instead of one of length 4.
  const tasks = [pTask("a1", "P1"), pTask("b1", "P2"), pTask("c1", "P2"), pTask("d1", "P1")];
  const report = analyzePortfolioDependencyRisk(
    tasks,
    [dep("a1", "b1"), dep("b1", "c1"), dep("c1", "d1")],
    PROJECTS,
    NOW,
  );

  check("full chain length is found across the boundary", report.longestChain.length === 4, report.longestChain);
  check("chain is flagged cross-project", report.longestChain.crossProject === true, report.longestChain);
  check("boundary crossings are counted", report.longestChain.boundaryCrossings === 2, report.longestChain);
  check(
    "chain finding mentions the crossings",
    report.findings.find((f) => f.kind === "chain")?.detail.includes("crosses a project boundary"),
    report.findings.find((f) => f.kind === "chain")?.detail,
  );
}

{
  const tasks = [pTask("gate", "P1"), pTask("m1", "P2"), pTask("m2", "P2"), pTask("b1", "P3")];
  const report = analyzePortfolioDependencyRisk(
    tasks,
    [dep("gate", "m1"), dep("gate", "m2"), dep("gate", "b1")],
    PROJECTS,
    NOW,
  );

  const gate = report.bottlenecks.find((entry) => entry.taskId === "gate");
  check("bottleneck knows its own project", gate?.projectId === "P1", gate);
  check("bottleneck lists the projects it reaches into", gate?.blockedProjectIds.length === 2, gate);
  check("bottleneck does not list its own project as blocked", !gate?.blockedProjectIds.includes("P1"), gate);
  check("bottleneck is flagged cross-project", gate?.crossProject === true, gate);
}

{
  // Attribution: a cross-project finding must appear on every board it involves.
  const tasks = [pTask("a", "P1"), pTask("b", "P2")];
  const report = analyzePortfolioDependencyRisk(tasks, [dep("a", "b")], PROJECTS, NOW);

  const p1 = report.byProject.find((entry) => entry.projectId === "P1");
  const p2 = report.byProject.find((entry) => entry.projectId === "P2");
  const p3 = report.byProject.find((entry) => entry.projectId === "P3");

  check("the blocking project sees the finding", (p1?.findings.length ?? 0) > 0, p1);
  check("the blocked project ALSO sees the finding", (p2?.findings.length ?? 0) > 0, p2);
  check("an uninvolved project sees nothing", p3?.findings.length === 0, p3);
  check("outbound is counted on the blocker's side", p1?.outboundCrossProject === 1 && p1?.inboundCrossProject === 0, p1);
  check("inbound is counted on the blocked side", p2?.inboundCrossProject === 1 && p2?.outboundCrossProject === 0, p2);
  check("every project appears in byProject", report.byProject.length === 3, report.byProject.length);
}

{
  const report = analyzePortfolioDependencyRisk([], [], PROJECTS, NOW);
  check("empty portfolio reports clear", report.findings[0].kind === "clear", report.findings);
  check("empty portfolio has no crossings", report.crossProjectEdgeCount === 0, report);
  check("empty portfolio headline is sensible", report.headline.includes("No blocking dependencies"), report.headline);
}

{
  // A DONE blocker still has an edge, but the constraint is no longer live.
  const tasks = [pTask("done", "P1", { status: "DONE" }), pTask("b", "P2")];
  const report = analyzePortfolioDependencyRisk(tasks, [dep("done", "b")], PROJECTS, NOW);

  check("edge still counted as a crossing", report.crossProjectEdgeCount === 1, report);
  check("but it is not live", report.crossProjectEdges[0].live === false, report.crossProjectEdges[0]);
  check("and produces no bottleneck", report.bottlenecks.length === 0, report.bottlenecks);
}

{
  // Determinism and order-independence for the portfolio analyzer too.
  const tasks = [pTask("a", "P1"), pTask("b", "P2"), pTask("c", "P2"), pTask("d", "P3")];
  const deps = [dep("a", "b"), dep("b", "c"), dep("c", "d"), dep("a", "d")];

  const first = JSON.stringify(analyzePortfolioDependencyRisk(tasks, deps, PROJECTS, NOW));
  let stable = true;
  for (let i = 0; i < 50; i += 1) {
    if (JSON.stringify(analyzePortfolioDependencyRisk(tasks, deps, PROJECTS, NOW)) !== first) {
      stable = false;
      break;
    }
  }
  check("portfolio analysis is deterministic over 50 runs", stable);
  check(
    "portfolio analysis is independent of input order",
    JSON.stringify(
      analyzePortfolioDependencyRisk([...tasks].reverse(), [...deps].reverse(), PROJECTS, NOW),
    ) === first,
  );
}

{
  // Unknown project id on a task must not crash or invent a project name.
  const tasks = [pTask("a", "GHOST"), pTask("b", "P1")];
  let threw = false;
  let report;
  try {
    report = analyzePortfolioDependencyRisk(tasks, [dep("a", "b")], PROJECTS, NOW);
  } catch {
    threw = true;
  }
  check("a task in an unlisted project does not crash", !threw);
  check(
    "unknown project renders as a placeholder, not undefined",
    !JSON.stringify(report ?? {}).includes("undefined"),
    report?.findings,
  );
}

// ===========================================================================
section("Slippage retrospective (per task)");
// ===========================================================================

{
  const titleOf = (id: string) => `Task ${id}`;

  // One task moved 3 times vs three tasks moved once. Identical aggregate totals,
  // completely different situations — which is the point of this breakdown.
  const repeatOffender: ScheduleChange[] = [
    { changedAt: daysAgo(30), fromDueDate: daysAgo(28), taskId: "t1", toDueDate: daysAgo(23) },
    { changedAt: daysAgo(20), fromDueDate: daysAgo(23), taskId: "t1", toDueDate: daysAgo(18) },
    { changedAt: daysAgo(10), fromDueDate: daysAgo(18), taskId: "t1", toDueDate: daysAgo(13) },
  ];

  const rows = slippageByTask(repeatOffender, titleOf, new Set(["t1"]));

  check("repeated pushes collapse to one row", rows.length === 1, rows);
  check("push count is 3", rows[0].pushes === 3, rows[0]);
  check("days accumulate across pushes", rows[0].totalDaysPushed === 15, rows[0]);
  check("worst single push is captured", rows[0].worstPushDays === 5, rows[0]);
  check("original date is the earliest 'from'", rows[0].originalDueDate?.getTime() === daysAgo(28).getTime(), rows[0]);
  check("current date is the latest 'to'", rows[0].currentDueDate?.getTime() === daysAgo(13).getTime(), rows[0]);
  check("blocker status is carried through", rows[0].isBlocker === true, rows[0]);
}

{
  const titleOf = (id: string) => `Task ${id}`;
  // Deliberately out of chronological order: the function must sort internally,
  // or "original" and "current" would be wrong.
  const shuffled: ScheduleChange[] = [
    { changedAt: daysAgo(5), fromDueDate: daysAgo(10), taskId: "t1", toDueDate: daysAhead(5) },
    { changedAt: daysAgo(25), fromDueDate: daysAgo(30), taskId: "t1", toDueDate: daysAgo(20) },
  ];

  const rows = slippageByTask(shuffled, titleOf, new Set());
  check(
    "unsorted input still yields the true original date",
    rows[0].originalDueDate?.getTime() === daysAgo(30).getTime(),
    rows[0],
  );
  check(
    "unsorted input still yields the true current date",
    rows[0].currentDueDate?.getTime() === daysAhead(5).getTime(),
    rows[0],
  );
}

{
  const titleOf = (id: string) => `Task ${id}`;
  const mixed: ScheduleChange[] = [
    // A pull — must not appear.
    { changedAt: daysAgo(3), fromDueDate: daysAhead(10), taskId: "puller", toDueDate: daysAhead(2) },
    // First-ever date — not slippage.
    { changedAt: daysAgo(3), fromDueDate: null, taskId: "new", toDueDate: daysAhead(5) },
    // Cleared date — not slippage.
    { changedAt: daysAgo(3), fromDueDate: daysAhead(5), taskId: "cleared", toDueDate: null },
    // A real push.
    { changedAt: daysAgo(2), fromDueDate: daysAgo(4), taskId: "pusher", toDueDate: daysAhead(6) },
  ];

  const rows = slippageByTask(mixed, titleOf, new Set());
  check("only genuine pushes appear", rows.length === 1 && rows[0].taskId === "pusher", rows.map((r) => r.taskId));
}

{
  const titleOf = (id: string) => `Task ${id}`;
  const changes: ScheduleChange[] = [
    { changedAt: daysAgo(5), fromDueDate: daysAgo(9), taskId: "small", toDueDate: daysAgo(7) },
    { changedAt: daysAgo(5), fromDueDate: daysAgo(30), taskId: "big", toDueDate: NOW },
    { changedAt: daysAgo(5), fromDueDate: daysAgo(12), toDueDate: daysAgo(7), taskId: "mid" },
  ];

  const rows = slippageByTask(changes, titleOf, new Set());
  check("rows are ordered worst-first by days lost", rows[0].taskId === "big", rows.map((r) => r.taskId));
  check(
    "ordering is a total order (descending days)",
    rows.every((row, i) => i === 0 || rows[i - 1].totalDaysPushed >= row.totalDaysPushed),
    rows.map((r) => [r.taskId, r.totalDaysPushed]),
  );
}

{
  const rows = slippageByTask([], (id) => id, new Set());
  check("no history yields an empty retrospective, not a crash", rows.length === 0);
}

{
  const titleOf = (id: string) => (id === "known" ? "Known task" : "(unknown task)");
  const rows = slippageByTask(
    [{ changedAt: NOW, fromDueDate: daysAgo(5), taskId: "ghost", toDueDate: NOW }],
    titleOf,
    new Set(),
  );
  check("a task with no title resolves to a placeholder", rows[0].title === "(unknown task)", rows[0]);
}

{
  const titleOf = (id: string) => `Task ${id}`;
  const many: ScheduleChange[] = Array.from({ length: 30 }, (_, i) => ({
    changedAt: daysAgo(i + 1),
    fromDueDate: daysAgo(40),
    taskId: `t${i}`,
    toDueDate: daysAgo(30 - (i % 5)),
  }));
  check("limit is respected", slippageByTask(many, titleOf, new Set(), 5).length === 5);
}

// ===========================================================================
section("Health band transitions (PROJECT_HEALTH_CHANGED)");
// ===========================================================================

/**
 * Mirrors the executor's decision. Kept here as a pure function so the rule can
 * be tested without a database: the executor was firing against a hardcoded
 * "Healthy" baseline, and these cases pin the corrected behaviour.
 */
function shouldFireHealthChange(
  previous: string | null,
  current: string,
): boolean {
  return previous !== null && previous !== current;
}

{
  check("first ever observation does not fire", shouldFireHealthChange(null, "Critical") === false);
  check("unchanged band does not fire", shouldFireHealthChange("Watch", "Watch") === false);
  check("degrading fires", shouldFireHealthChange("Healthy", "At risk") === true);
  check("recovering fires", shouldFireHealthChange("Critical", "Healthy") === true);
  check(
    "the old hardcoded baseline would have missed a Healthy→At risk drop",
    // Old behaviour: previousStatus was always "Healthy", so a project moving
    // Healthy→At risk produced previous="Healthy", new="At risk" — which does
    // fire — but a project sitting At risk fired on EVERY run, and a project
    // that was already unhealthy and got worse compared against the wrong base.
    shouldFireHealthChange("At risk", "At risk") === false,
  );
}

{
  // Walk a realistic sequence and count events.
  const sequence = ["Healthy", "Healthy", "Watch", "Watch", "At risk", "Healthy"];
  let previous: string | null = null;
  let fired = 0;

  for (const band of sequence) {
    if (shouldFireHealthChange(previous, band)) {
      fired += 1;
    }
    previous = band;
  }

  check("6 observations with 3 transitions fire exactly 3 events", fired === 3, fired);
}

// ===========================================================================

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
