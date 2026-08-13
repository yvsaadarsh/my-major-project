/**
 * Dependency risk & bottleneck detection.
 *
 * Pure, deterministic, dependency-free. No Prisma, no React, no network, no
 * model provider. Given already-fetched tasks and dependency edges, this module
 * answers four questions about the blocking graph:
 *
 *   1. Which unfinished tasks are holding up the most work?  (bottlenecks)
 *   2. What is the longest chain of blocking work?            (critical chain)
 *   3. Are there impossible cycles?                           (cycles)
 *   4. What should a human look at first, and why?            (findings)
 *
 * Design rules
 * ------------
 * - **Explainable, not scored-in-a-box.** Every risk level is accompanied by the
 *   specific counts that produced it, and every recommendation names the task it
 *   refers to. There is no hidden weighting a reader cannot reconstruct.
 * - **Read-only by construction.** Nothing here mutates its inputs. The module
 *   returns descriptions and suggestions; it never expresses an action to take
 *   automatically, and the API layer that calls it performs no writes.
 * - **Iterative, not recursive.** Traversals use explicit stacks/queues. A
 *   recursive walk over a customer's 5,000-edge graph is a stack overflow
 *   waiting to happen, and cycles must be survivable rather than fatal.
 * - **Tenant-agnostic.** This layer never sees an organization id. The caller
 *   fetches rows already scoped to one tenant, so cross-tenant leakage is
 *   impossible here by construction rather than by discipline.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type RiskTaskStatus = "TODO" | "IN_PROGRESS" | "BLOCKED" | "DONE";
export type RiskTaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type RiskDependencyType = "BLOCKS" | "DEPENDS_ON" | "RELATED_TO";

export type RiskTask = {
  id: string;
  title: string;
  status: RiskTaskStatus;
  priority: RiskTaskPriority;
  dueDate: Date | null;
  assignedToUserId: string | null;
};

export type RiskDependency = {
  id: string;
  sourceTaskId: string;
  targetTaskId: string;
  type: RiskDependencyType;
};

/** Priority ordering used for weighting downstream cost. */
const PRIORITY_WEIGHT: Record<RiskTaskPriority, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 4,
  URGENT: 6,
};

const OPEN_STATUSES = new Set<RiskTaskStatus>(["TODO", "IN_PROGRESS", "BLOCKED"]);

export function isOpen(task: RiskTask): boolean {
  return OPEN_STATUSES.has(task.status);
}

export function isTaskOverdue(task: RiskTask, now: Date): boolean {
  return Boolean(task.dueDate && task.status !== "DONE" && task.dueDate.getTime() < now.getTime());
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * A normalized blocking graph.
 *
 * Both `BLOCKS` and `DEPENDS_ON` describe the same relationship from opposite
 * ends: "A BLOCKS B" and "B DEPENDS_ON A" both mean work cannot start on B
 * until A is done. We normalize everything to a single `blocker -> blocked`
 * direction so the traversals only ever deal with one edge kind. `RELATED_TO`
 * carries no ordering and is excluded entirely — treating it as a blocker would
 * invent constraints the user never expressed.
 */
export type BlockingGraph = {
  /** blockerId -> ids it blocks (downstream). */
  downstream: Map<string, string[]>;
  /** blockedId -> ids blocking it (upstream). */
  upstream: Map<string, string[]>;
  /** Every task id that participates in at least one blocking edge. */
  nodes: Set<string>;
  /** Edge count after normalization and de-duplication. */
  edgeCount: number;
};

function pushEdge(map: Map<string, string[]>, from: string, to: string) {
  const existing = map.get(from);

  if (existing === undefined) {
    map.set(from, [to]);
    return;
  }

  existing.push(to);
}

export function buildBlockingGraph(dependencies: RiskDependency[]): BlockingGraph {
  const downstream = new Map<string, string[]>();
  const upstream = new Map<string, string[]>();
  const nodes = new Set<string>();
  const seen = new Set<string>();
  let edgeCount = 0;

  for (const dependency of dependencies) {
    if (dependency.type === "RELATED_TO") {
      continue;
    }

    // Normalize to blocker -> blocked.
    const blocker =
      dependency.type === "BLOCKS" ? dependency.sourceTaskId : dependency.targetTaskId;
    const blocked =
      dependency.type === "BLOCKS" ? dependency.targetTaskId : dependency.sourceTaskId;

    // Self-edges are meaningless and would make every traversal look cyclic.
    if (blocker === blocked) {
      continue;
    }

    // The same pair can arrive twice (once as BLOCKS, once as DEPENDS_ON).
    // Counting it twice would double a bottleneck's apparent fan-out.
    const key = `${blocker}>${blocked}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    pushEdge(downstream, blocker, blocked);
    pushEdge(upstream, blocked, blocker);
    nodes.add(blocker);
    nodes.add(blocked);
    edgeCount += 1;
  }

  // Sort adjacency so every traversal — and therefore every output list — is
  // byte-identical across runs regardless of the order rows arrived from SQL.
  for (const list of downstream.values()) {
    list.sort();
  }
  for (const list of upstream.values()) {
    list.sort();
  }

  return { downstream, edgeCount, nodes, upstream };
}

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

export type DependencyCycle = {
  /**
   * Task ids forming the cycle, in traversal order, with the entry point
   * repeated at the end so the loop reads as a closed path (a -> b -> a).
   */
  path: string[];
  /** Human-readable titles for the same path, for direct display. */
  titles: string[];
};

/**
 * Find blocking cycles using iterative DFS with an explicit colour marking.
 *
 * A cycle means the work can never start: every task in the loop waits for
 * another task in the same loop. The route that creates dependencies rejects
 * cycles it can foresee, but data can still become cyclic through concurrent
 * writes or direct database edits, so detection here is not redundant — and a
 * cycle must never hang the analysis.
 *
 * Returns at most one cycle per distinct entry point, de-duplicated by node set,
 * so a 3-node loop is reported once rather than three times.
 */
export function findCycles(
  graph: BlockingGraph,
  titleOf: (taskId: string) => string,
): DependencyCycle[] {
  const WHITE = 0; // unvisited
  const GREY = 1; // on the current stack
  const BLACK = 2; // fully explored

  const colour = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const cycles: DependencyCycle[] = [];
  const reported = new Set<string>();

  const roots = [...graph.nodes].sort();

  for (const root of roots) {
    if ((colour.get(root) ?? WHITE) !== WHITE) {
      continue;
    }

    // Each frame tracks how many of its children we have already dispatched,
    // which is what lets us emulate recursion without the call stack.
    const stack: Array<{ node: string; childIndex: number }> = [
      { childIndex: 0, node: root },
    ];
    colour.set(root, GREY);
    parent.set(root, null);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = graph.downstream.get(frame.node) ?? [];

      if (frame.childIndex >= children.length) {
        colour.set(frame.node, BLACK);
        stack.pop();
        continue;
      }

      const child = children[frame.childIndex];
      frame.childIndex += 1;

      const childColour = colour.get(child) ?? WHITE;

      if (childColour === GREY) {
        // Walk back up the parent chain to recover the loop.
        const path: string[] = [child];
        let cursor: string | null | undefined = frame.node;

        while (cursor && cursor !== child) {
          path.push(cursor);
          cursor = parent.get(cursor) ?? null;
        }

        path.push(child);
        path.reverse();

        const signature = [...new Set(path)].sort().join("|");
        if (!reported.has(signature)) {
          reported.add(signature);
          cycles.push({ path, titles: path.map(titleOf) });
        }

        continue;
      }

      if (childColour === WHITE) {
        colour.set(child, GREY);
        parent.set(child, frame.node);
        stack.push({ childIndex: 0, node: child });
      }
    }
  }

  return cycles;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * Every task transitively blocked by `taskId`, excluding itself.
 *
 * Breadth-first with a visited set, so a cycle terminates instead of spinning.
 */
export function downstreamOf(graph: BlockingGraph, taskId: string): Set<string> {
  const reached = new Set<string>();
  const queue = [taskId];

  while (queue.length > 0) {
    const current = queue.shift() as string;

    for (const next of graph.downstream.get(current) ?? []) {
      if (reached.has(next) || next === taskId) {
        continue;
      }
      reached.add(next);
      queue.push(next);
    }
  }

  return reached;
}

// ---------------------------------------------------------------------------
// Longest blocking chain
// ---------------------------------------------------------------------------

export type BlockingChain = {
  /** Task ids from the first blocker to the final blocked task. */
  path: string[];
  titles: string[];
  /** Number of tasks in the chain. */
  length: number;
  /** How many of the chain's tasks are still open. */
  openCount: number;
};

/**
 * The longest path through the blocking graph, counting only chains that still
 * matter (at least one open task).
 *
 * This is the project's structural floor: however many people are available,
 * work in a chain of length N cannot compress below N sequential handoffs. It is
 * computed with memoised depth over a topological-ish DFS, and returns an empty
 * chain when the graph is cyclic in a way that makes "longest" undefined.
 */
export function longestBlockingChain(
  graph: BlockingGraph,
  taskById: Map<string, RiskTask>,
): BlockingChain {
  const memo = new Map<string, { depth: number; next: string | null }>();
  const state = new Map<string, number>(); // 0 unvisited, 1 in progress, 2 done

  // Iterative post-order so children are resolved before their parent.
  for (const root of [...graph.nodes].sort()) {
    if ((state.get(root) ?? 0) !== 0) {
      continue;
    }

    const stack: Array<{ node: string; childIndex: number }> = [
      { childIndex: 0, node: root },
    ];
    state.set(root, 1);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const children = graph.downstream.get(frame.node) ?? [];

      if (frame.childIndex >= children.length) {
        // All children resolved — pick the deepest.
        let best = { depth: 0, next: null as string | null };

        for (const child of children) {
          const childMemo = memo.get(child);
          // A child still in progress means we closed a cycle; skip that edge
          // rather than treating it as infinite depth.
          if (childMemo === undefined) {
            continue;
          }
          if (childMemo.depth + 1 > best.depth) {
            best = { depth: childMemo.depth + 1, next: child };
          }
        }

        memo.set(frame.node, best);
        state.set(frame.node, 2);
        stack.pop();
        continue;
      }

      const child = children[frame.childIndex];
      frame.childIndex += 1;
      const childState = state.get(child) ?? 0;

      if (childState === 0) {
        state.set(child, 1);
        stack.push({ childIndex: 0, node: child });
      }
    }
  }

  // Choose the best starting node, preferring chains that contain open work.
  let bestStart: string | null = null;
  let bestDepth = -1;

  for (const node of [...graph.nodes].sort()) {
    const depth = memo.get(node)?.depth ?? 0;
    if (depth > bestDepth) {
      bestDepth = depth;
      bestStart = node;
    }
  }

  if (bestStart === null || bestDepth <= 0) {
    return { length: 0, openCount: 0, path: [], titles: [] };
  }

  // Reconstruct by following the recorded `next` pointers.
  const path: string[] = [];
  const guard = new Set<string>();
  let cursor: string | null = bestStart;

  while (cursor !== null && !guard.has(cursor)) {
    path.push(cursor);
    guard.add(cursor);
    cursor = memo.get(cursor)?.next ?? null;
  }

  const openCount = path.filter((id) => {
    const task = taskById.get(id);
    return task !== undefined && isOpen(task);
  }).length;

  return {
    length: path.length,
    openCount,
    path,
    titles: path.map((id) => taskById.get(id)?.title ?? id),
  };
}

// ---------------------------------------------------------------------------
// Bottlenecks
// ---------------------------------------------------------------------------

export type BottleneckSeverity = "critical" | "high" | "medium" | "low";

export type Bottleneck = {
  taskId: string;
  title: string;
  status: RiskTaskStatus;
  priority: RiskTaskPriority;
  assignedToUserId: string | null;
  dueDate: Date | null;
  /** True when this task is itself past its due date. */
  overdue: boolean;
  /** Tasks blocked directly by this one. */
  directBlockedCount: number;
  /** Tasks blocked directly or transitively. */
  totalBlockedCount: number;
  /** Of the transitively blocked tasks, how many are still open. */
  openBlockedCount: number;
  /** Of the transitively blocked tasks, how many are HIGH or URGENT. */
  highPriorityBlockedCount: number;
  /** Of the transitively blocked tasks, how many are themselves overdue. */
  overdueBlockedCount: number;
  /** True when nothing blocks this task — it can be started right now. */
  actionableNow: boolean;
  /**
   * Relative cost of leaving this task unfinished. Comparable *within* one
   * result set for ordering; not a percentage and not comparable across
   * projects. Always shown alongside the counts that produced it.
   */
  impactScore: number;
  severity: BottleneckSeverity;
  /** Why this is flagged, in plain language, most significant first. */
  reasons: string[];
  /** What a human might do. Advisory only — nothing is applied automatically. */
  recommendation: string;
};

/** Points that make up `impactScore`, named so the number is reconstructable. */
export const IMPACT_WEIGHTS = {
  /** Per open task transitively blocked. */
  openBlocked: 10,
  /** Extra per blocked task at HIGH/URGENT priority. */
  highPriorityBlocked: 6,
  /** Extra per blocked task already overdue. */
  overdueBlocked: 8,
  /** Bonus when the blocker itself is overdue — it is late *and* gating. */
  selfOverdue: 15,
  /** Bonus when the blocker is unblocked, so the fix is available today. */
  actionableNow: 12,
  /** Bonus when the blocker is itself marked BLOCKED — a stalled gate. */
  selfBlocked: 10,
} as const;

function severityFor(impactScore: number, openBlockedCount: number): BottleneckSeverity {
  if (openBlockedCount === 0) {
    return "low";
  }
  if (impactScore >= 70) {
    return "critical";
  }
  if (impactScore >= 40) {
    return "high";
  }
  if (impactScore >= 18) {
    return "medium";
  }
  return "low";
}

/**
 * Rank the unfinished tasks that are holding up other work.
 *
 * Only open tasks can be bottlenecks: a DONE task blocks nothing, even though
 * its edges remain in the graph for history. Tasks that block nothing open are
 * excluded entirely rather than listed at zero, so the output is a worklist
 * rather than a table of every task in the project.
 */
export function findBottlenecks(
  tasks: RiskTask[],
  dependencies: RiskDependency[],
  now: Date,
  limit = 10,
): Bottleneck[] {
  const graph = buildBlockingGraph(dependencies);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const results: Bottleneck[] = [];

  for (const task of tasks) {
    if (!isOpen(task)) {
      continue;
    }

    const direct = graph.downstream.get(task.id) ?? [];
    if (direct.length === 0) {
      continue;
    }

    const reachable = downstreamOf(graph, task.id);
    const blockedTasks = [...reachable]
      .map((id) => taskById.get(id))
      .filter((candidate): candidate is RiskTask => candidate !== undefined);

    const openBlocked = blockedTasks.filter(isOpen);

    if (openBlocked.length === 0) {
      continue;
    }

    const highPriorityBlocked = openBlocked.filter(
      (blocked) => blocked.priority === "HIGH" || blocked.priority === "URGENT",
    );
    const overdueBlocked = openBlocked.filter((blocked) => isTaskOverdue(blocked, now));
    const upstreamOpen = (graph.upstream.get(task.id) ?? []).filter((id) => {
      const blocker = taskById.get(id);
      return blocker !== undefined && isOpen(blocker);
    });

    const selfOverdue = isTaskOverdue(task, now);
    const actionableNow = upstreamOpen.length === 0;

    const impactScore =
      openBlocked.length * IMPACT_WEIGHTS.openBlocked +
      highPriorityBlocked.length * IMPACT_WEIGHTS.highPriorityBlocked +
      overdueBlocked.length * IMPACT_WEIGHTS.overdueBlocked +
      (selfOverdue ? IMPACT_WEIGHTS.selfOverdue : 0) +
      (actionableNow ? IMPACT_WEIGHTS.actionableNow : 0) +
      (task.status === "BLOCKED" ? IMPACT_WEIGHTS.selfBlocked : 0);

    // Reasons are ordered by how much they contribute, so the first line is
    // always the strongest argument for looking at this task.
    const reasons: string[] = [];

    reasons.push(
      `Blocks ${openBlocked.length} open task${openBlocked.length === 1 ? "" : "s"}` +
        (reachable.size > direct.length
          ? ` (${direct.length} directly, ${openBlocked.length} once knock-on effects are followed)`
          : ""),
    );

    if (overdueBlocked.length > 0) {
      reasons.push(
        `${overdueBlocked.length} of the blocked task${overdueBlocked.length === 1 ? " is" : "s are"} already overdue`,
      );
    }
    if (highPriorityBlocked.length > 0) {
      reasons.push(
        `${highPriorityBlocked.length} blocked task${highPriorityBlocked.length === 1 ? " is" : "s are"} high or urgent priority`,
      );
    }
    if (selfOverdue) {
      reasons.push("This task is itself past its due date");
    }
    if (task.status === "BLOCKED") {
      reasons.push("This task is marked blocked, so the gate is stalled rather than in progress");
    }
    if (actionableNow) {
      reasons.push("Nothing blocks this task — it can be worked on today");
    } else {
      reasons.push(
        `Waiting on ${upstreamOpen.length} upstream task${upstreamOpen.length === 1 ? "" : "s"} first`,
      );
    }
    if (!task.assignedToUserId) {
      reasons.push("Unassigned, so nobody currently owns unblocking it");
    }

    results.push({
      actionableNow,
      assignedToUserId: task.assignedToUserId,
      directBlockedCount: direct.length,
      dueDate: task.dueDate,
      highPriorityBlockedCount: highPriorityBlocked.length,
      impactScore,
      openBlockedCount: openBlocked.length,
      overdue: selfOverdue,
      overdueBlockedCount: overdueBlocked.length,
      priority: task.priority,
      reasons,
      recommendation: recommendationFor(task, {
        actionableNow,
        openBlockedCount: openBlocked.length,
        unassigned: !task.assignedToUserId,
        upstreamOpenCount: upstreamOpen.length,
      }),
      severity: severityFor(impactScore, openBlocked.length),
      status: task.status,
      taskId: task.id,
      title: task.title,
      totalBlockedCount: reachable.size,
    });
  }

  // Total ordering: impact desc, then open-blocked desc, then title, then id.
  // The trailing keys matter — without them two equally costly bottlenecks
  // could swap places between runs and make the UI look unstable.
  results.sort(
    (a, b) =>
      b.impactScore - a.impactScore ||
      b.openBlockedCount - a.openBlockedCount ||
      a.title.localeCompare(b.title) ||
      a.taskId.localeCompare(b.taskId),
  );

  return results.slice(0, limit);
}

/**
 * Advisory next step. Phrased as a suggestion to a person, never as an
 * instruction to the system — this product does not auto-modify data.
 */
function recommendationFor(
  task: RiskTask,
  context: {
    actionableNow: boolean;
    openBlockedCount: number;
    unassigned: boolean;
    upstreamOpenCount: number;
  },
): string {
  const count = `${context.openBlockedCount} task${context.openBlockedCount === 1 ? "" : "s"}`;

  if (context.unassigned && context.actionableNow) {
    return `Assign an owner — this is ready to start and ${count} are waiting on it.`;
  }

  if (context.actionableNow && task.status === "BLOCKED") {
    return `Nothing upstream is outstanding, so the BLOCKED status may be stale. Confirm what it is waiting for, or reopen it to unblock ${count}.`;
  }

  if (context.actionableNow) {
    return `Prioritise finishing this to release ${count}.`;
  }

  return `Resolve its ${context.upstreamOpenCount} upstream blocker${
    context.upstreamOpenCount === 1 ? "" : "s"
  } first — until then ${count} stay blocked behind it.`;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type RiskFindingLevel = "critical" | "warning" | "info";

export type RiskFinding = {
  level: RiskFindingLevel;
  /** Stable identifier so the UI can attach an icon without parsing prose. */
  kind: "cycle" | "bottleneck" | "chain" | "hub" | "clear" | "crossProject";
  headline: string;
  detail: string;
  /** Task ids this finding refers to, for deep-linking. */
  taskIds: string[];
  /**
   * Projects this finding spans. Empty for per-project analysis, which has no
   * project vocabulary; populated by the portfolio analyzer.
   */
  projectIds?: string[];
};

export type DependencyRiskReport = {
  /** Tasks and edges actually considered. */
  taskCount: number;
  dependencyCount: number;
  /** Edges after dropping RELATED_TO, self-edges and duplicates. */
  blockingEdgeCount: number;
  cycles: DependencyCycle[];
  longestChain: BlockingChain;
  bottlenecks: Bottleneck[];
  /** Ranked, human-readable findings — the summary a person reads first. */
  findings: RiskFinding[];
};

/** A chain at or beyond this length is called out as a structural risk. */
export const LONG_CHAIN_THRESHOLD = 4;

/** Direct fan-out at or beyond this is called a hub. */
export const HUB_FANOUT_THRESHOLD = 4;

/**
 * Full read-only risk report for one project's task graph.
 *
 * `tasks` and `dependencies` must already be scoped to a single tenant and
 * project by the caller.
 */
export function analyzeDependencyRisk(
  tasks: RiskTask[],
  dependencies: RiskDependency[],
  now: Date,
  options: { bottleneckLimit?: number } = {},
): DependencyRiskReport {
  const graph = buildBlockingGraph(dependencies);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const titleOf = (id: string) => taskById.get(id)?.title ?? "(unknown task)";

  const cycles = findCycles(graph, titleOf);
  const longestChain = longestBlockingChain(graph, taskById);
  const bottlenecks = findBottlenecks(tasks, dependencies, now, options.bottleneckLimit ?? 10);

  const findings: RiskFinding[] = [];

  // Cycles first and always: they are a correctness problem, not a scheduling
  // one. No amount of effort completes a circular dependency.
  for (const cycle of cycles) {
    findings.push({
      detail:
        `${cycle.titles.slice(0, -1).join(" → ")} → ${cycle.titles[cycle.titles.length - 1]}. ` +
        "Each task in this loop is waiting on another task in the same loop, so none of them can start. " +
        "Remove one of these dependency links to break the deadlock.",
      headline: `Circular dependency across ${cycle.path.length - 1} tasks`,
      kind: "cycle",
      level: "critical",
      taskIds: [...new Set(cycle.path)],
    });
  }

  const critical = bottlenecks.filter((item) => item.severity === "critical");
  const high = bottlenecks.filter((item) => item.severity === "high");

  if (critical.length > 0) {
    const worst = critical[0];
    findings.push({
      detail:
        `"${worst.title}" is blocking ${worst.openBlockedCount} open task${
          worst.openBlockedCount === 1 ? "" : "s"
        }` +
        (worst.overdueBlockedCount > 0
          ? `, ${worst.overdueBlockedCount} of which ${worst.overdueBlockedCount === 1 ? "is" : "are"} overdue`
          : "") +
        `. ${worst.recommendation}`,
      headline:
        critical.length === 1
          ? "1 critical bottleneck"
          : `${critical.length} critical bottlenecks`,
      kind: "bottleneck",
      level: "critical",
      taskIds: critical.map((item) => item.taskId),
    });
  } else if (high.length > 0) {
    findings.push({
      detail: `"${high[0].title}" is the most costly: ${high[0].reasons[0].toLowerCase()}. ${high[0].recommendation}`,
      headline: high.length === 1 ? "1 significant bottleneck" : `${high.length} significant bottlenecks`,
      kind: "bottleneck",
      level: "warning",
      taskIds: high.map((item) => item.taskId),
    });
  }

  if (longestChain.length >= LONG_CHAIN_THRESHOLD && longestChain.openCount > 0) {
    findings.push({
      detail:
        `The longest blocking chain runs ${longestChain.length} tasks deep (${longestChain.openCount} still open): ` +
        `${longestChain.titles.join(" → ")}. ` +
        "However many people are available, this work cannot compress below that many sequential handoffs — " +
        "consider whether every link is a genuine dependency.",
      headline: `Critical chain is ${longestChain.length} tasks deep`,
      kind: "chain",
      level: longestChain.length >= LONG_CHAIN_THRESHOLD * 2 ? "warning" : "info",
      taskIds: longestChain.path,
    });
  }

  // Hubs: single points of failure by fan-out, worth naming separately because
  // the fix is usually "split this task", not "work harder on it".
  const hubs = bottlenecks.filter((item) => item.directBlockedCount >= HUB_FANOUT_THRESHOLD);
  if (hubs.length > 0) {
    findings.push({
      detail:
        `"${hubs[0].title}" directly gates ${hubs[0].directBlockedCount} tasks. ` +
        "A single task with this much fan-out is a single point of failure; splitting it into " +
        "independently completable pieces would let some of the blocked work start sooner.",
      headline: hubs.length === 1 ? "1 dependency hub" : `${hubs.length} dependency hubs`,
      kind: "hub",
      level: "info",
      taskIds: hubs.map((item) => item.taskId),
    });
  }

  if (findings.length === 0) {
    findings.push({
      detail:
        graph.edgeCount === 0
          ? "No blocking dependencies have been defined for this project, so there is no dependency risk to report."
          : `All ${graph.edgeCount} blocking link${graph.edgeCount === 1 ? "" : "s"} are either satisfied or gate no open work.`,
      headline: "No dependency risks detected",
      kind: "clear",
      level: "info",
      taskIds: [],
    });
  }

  return {
    blockingEdgeCount: graph.edgeCount,
    bottlenecks,
    cycles,
    dependencyCount: dependencies.length,
    findings,
    longestChain,
    taskCount: tasks.length,
  };
}

// ---------------------------------------------------------------------------
// Portfolio (tenant-wide) analysis
// ---------------------------------------------------------------------------

/**
 * Why a tenant-wide graph rather than per-project analysis plus one hop.
 *
 * Dependencies are no longer confined to a project, so a blocking chain can
 * leave a project, pass through two others and come back. Analysing each project
 * separately — even including edges one hop over the boundary — cannot see that
 * chain, and would report each fragment as a short, low-risk chain while the
 * real critical path is long. Worse, a cycle spanning three projects would be
 * invisible to all three per-project checks, because no single project's subgraph
 * contains a loop.
 *
 * So the graph is built once over the whole tenant, and findings are attributed
 * back to whichever projects they touch. Analysis is global; presentation is
 * per project.
 */

/** A task plus the project it belongs to. Required for attribution. */
export type PortfolioRiskTask = RiskTask & { projectId: string };

export type RiskProject = { id: string; name: string };

/** A blocking edge whose endpoints live in different projects. */
export type CrossProjectEdge = {
  blockerTaskId: string;
  blockerTitle: string;
  blockerProjectId: string;
  blockedTaskId: string;
  blockedTitle: string;
  blockedProjectId: string;
  /** True when the blocker is still open, i.e. the constraint is live. */
  live: boolean;
};

export type PortfolioCycle = DependencyCycle & {
  projectIds: string[];
  crossProject: boolean;
};

export type PortfolioChain = BlockingChain & {
  projectIds: string[];
  crossProject: boolean;
  /** Number of times the chain crosses a project boundary. */
  boundaryCrossings: number;
};

export type PortfolioBottleneck = Bottleneck & {
  projectId: string;
  /** Projects other than its own containing work it blocks. */
  blockedProjectIds: string[];
  crossProject: boolean;
};

export type ProjectRiskAttribution = {
  projectId: string;
  projectName: string;
  /** Findings touching this project, in the global ranking's order. */
  findings: RiskFinding[];
  bottleneckCount: number;
  cycleCount: number;
  /** Edges where something outside this project blocks work inside it. */
  inboundCrossProject: number;
  /** Edges where work inside this project blocks something outside it. */
  outboundCrossProject: number;
};

export type PortfolioDependencyRiskReport = {
  taskCount: number;
  dependencyCount: number;
  blockingEdgeCount: number;
  crossProjectEdgeCount: number;
  crossProjectEdges: CrossProjectEdge[];
  cycles: PortfolioCycle[];
  longestChain: PortfolioChain;
  bottlenecks: PortfolioBottleneck[];
  findings: RiskFinding[];
  byProject: ProjectRiskAttribution[];
  headline: string;
};

/** Distinct project ids for a list of task ids, in first-seen order. */
function projectsFor(taskIds: string[], projectOf: Map<string, string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const id of taskIds) {
    const projectId = projectOf.get(id);
    if (projectId !== undefined && !seen.has(projectId)) {
      seen.add(projectId);
      ordered.push(projectId);
    }
  }

  return ordered;
}

/**
 * Tenant-wide dependency risk with per-project attribution.
 *
 * `tasks` and `dependencies` must cover the whole tenant and be scoped to it by
 * the caller. Passing a subset silently produces a smaller graph and would
 * under-report exactly the cross-boundary risk this function exists to find.
 */
export function analyzePortfolioDependencyRisk(
  tasks: PortfolioRiskTask[],
  dependencies: RiskDependency[],
  projects: RiskProject[],
  now: Date,
  options: { bottleneckLimit?: number } = {},
): PortfolioDependencyRiskReport {
  const graph = buildBlockingGraph(dependencies);
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const projectOf = new Map(tasks.map((task) => [task.id, task.projectId]));
  const nameOf = new Map(projects.map((project) => [project.id, project.name]));
  const titleOf = (id: string) => taskById.get(id)?.title ?? "(unknown task)";
  const projectName = (id: string) => nameOf.get(id) ?? "(unknown project)";

  const rawCycles = findCycles(graph, titleOf);
  const rawChain = longestBlockingChain(graph, taskById);
  const rawBottlenecks = findBottlenecks(tasks, dependencies, now, options.bottleneckLimit ?? 12);

  // ── Cross-project edges ───────────────────────────────────────────────────
  const crossProjectEdges: CrossProjectEdge[] = [];
  for (const [blocker, blockedList] of graph.downstream) {
    const blockerProject = projectOf.get(blocker);
    if (blockerProject === undefined) {
      continue;
    }

    for (const blocked of blockedList) {
      const blockedProject = projectOf.get(blocked);
      if (blockedProject === undefined || blockedProject === blockerProject) {
        continue;
      }

      crossProjectEdges.push({
        blockedProjectId: blockedProject,
        blockedTaskId: blocked,
        blockedTitle: titleOf(blocked),
        blockerProjectId: blockerProject,
        blockerTaskId: blocker,
        blockerTitle: titleOf(blocker),
        live: (() => {
          const task = taskById.get(blocker);
          return task !== undefined && isOpen(task);
        })(),
      });
    }
  }

  // Total order for determinism.
  crossProjectEdges.sort(
    (a, b) =>
      a.blockerProjectId.localeCompare(b.blockerProjectId) ||
      a.blockedProjectId.localeCompare(b.blockedProjectId) ||
      a.blockerTitle.localeCompare(b.blockerTitle) ||
      a.blockerTaskId.localeCompare(b.blockerTaskId),
  );

  // ── Annotate cycles and the chain with the projects they span ─────────────
  const cycles: PortfolioCycle[] = rawCycles.map((cycle) => {
    const projectIds = projectsFor([...new Set(cycle.path)], projectOf);
    return { ...cycle, crossProject: projectIds.length > 1, projectIds };
  });

  const chainProjects = projectsFor(rawChain.path, projectOf);
  let boundaryCrossings = 0;
  for (let i = 1; i < rawChain.path.length; i += 1) {
    if (projectOf.get(rawChain.path[i - 1]) !== projectOf.get(rawChain.path[i])) {
      boundaryCrossings += 1;
    }
  }

  const longestChain: PortfolioChain = {
    ...rawChain,
    boundaryCrossings,
    crossProject: chainProjects.length > 1,
    projectIds: chainProjects,
  };

  // ── Annotate bottlenecks with the projects they reach into ────────────────
  const bottlenecks: PortfolioBottleneck[] = rawBottlenecks.map((bottleneck) => {
    const own = projectOf.get(bottleneck.taskId) ?? "";
    const reached = projectsFor([...downstreamOf(graph, bottleneck.taskId)], projectOf).filter(
      (projectId) => projectId !== own,
    );

    return {
      ...bottleneck,
      blockedProjectIds: reached,
      crossProject: reached.length > 0,
      projectId: own,
    };
  });

  // ── Findings ──────────────────────────────────────────────────────────────
  const findings: RiskFinding[] = [];

  // Cross-project cycles first. A loop inside one project is a planning error a
  // single owner can fix; a loop spanning projects means two teams are each
  // waiting on the other and neither can see the whole picture from their own
  // board. That is strictly worse and is called out separately.
  for (const cycle of cycles.filter((entry) => entry.crossProject)) {
    findings.push({
      detail:
        `${cycle.titles.slice(0, -1).join(" → ")} → ${cycle.titles[cycle.titles.length - 1]}. ` +
        `This loop spans ${cycle.projectIds.length} projects (${cycle.projectIds.map(projectName).join(", ")}), ` +
        "so no single project board shows the whole deadlock — each team sees only that it is waiting on someone else. " +
        "Remove one link to break it.",
      headline: `Circular dependency across ${cycle.projectIds.length} projects`,
      kind: "cycle",
      level: "critical",
      projectIds: cycle.projectIds,
      taskIds: [...new Set(cycle.path)],
    });
  }

  for (const cycle of cycles.filter((entry) => !entry.crossProject)) {
    findings.push({
      detail:
        `${cycle.titles.slice(0, -1).join(" → ")} → ${cycle.titles[cycle.titles.length - 1]}. ` +
        "Each task in this loop is waiting on another in the same loop, so none of them can start. " +
        "Remove one of these dependency links to break the deadlock.",
      headline: `Circular dependency across ${cycle.path.length - 1} tasks`,
      kind: "cycle",
      level: "critical",
      projectIds: cycle.projectIds,
      taskIds: [...new Set(cycle.path)],
    });
  }

  // Cross-project bottlenecks: the headline capability of this feature. A task
  // gating work in another project is invisible from either project's own view.
  const crossBottlenecks = bottlenecks.filter(
    (entry) => entry.crossProject && entry.openBlockedCount > 0,
  );

  if (crossBottlenecks.length > 0) {
    const worst = crossBottlenecks[0];
    findings.push({
      detail:
        `"${worst.title}" in ${projectName(worst.projectId)} is blocking ${worst.openBlockedCount} open task${
          worst.openBlockedCount === 1 ? "" : "s"
        }, reaching into ${worst.blockedProjectIds.map(projectName).join(", ")}. ` +
        "Nobody looking at a single project board would see this. " +
        worst.recommendation,
      headline:
        crossBottlenecks.length === 1
          ? "1 bottleneck blocking another project"
          : `${crossBottlenecks.length} bottlenecks blocking other projects`,
      kind: "crossProject",
      level: "critical",
      projectIds: [
        ...new Set(crossBottlenecks.flatMap((entry) => [entry.projectId, ...entry.blockedProjectIds])),
      ],
      taskIds: crossBottlenecks.map((entry) => entry.taskId),
    });
  }

  const critical = bottlenecks.filter(
    (entry) => entry.severity === "critical" && !entry.crossProject,
  );

  if (critical.length > 0) {
    const worst = critical[0];
    findings.push({
      detail:
        `"${worst.title}" is blocking ${worst.openBlockedCount} open task${
          worst.openBlockedCount === 1 ? "" : "s"
        }` +
        (worst.overdueBlockedCount > 0
          ? `, ${worst.overdueBlockedCount} of which ${worst.overdueBlockedCount === 1 ? "is" : "are"} overdue`
          : "") +
        `. ${worst.recommendation}`,
      headline: critical.length === 1 ? "1 critical bottleneck" : `${critical.length} critical bottlenecks`,
      kind: "bottleneck",
      level: "critical",
      projectIds: [...new Set(critical.map((entry) => entry.projectId))],
      taskIds: critical.map((entry) => entry.taskId),
    });
  }

  if (longestChain.length >= LONG_CHAIN_THRESHOLD && longestChain.openCount > 0) {
    findings.push({
      detail:
        `The longest blocking chain runs ${longestChain.length} tasks deep (${longestChain.openCount} still open): ` +
        `${longestChain.titles.join(" → ")}. ` +
        (longestChain.crossProject
          ? `It crosses a project boundary ${longestChain.boundaryCrossings} time${
              longestChain.boundaryCrossings === 1 ? "" : "s"
            } across ${longestChain.projectIds.map(projectName).join(" → ")}, so no single project's view shows its true length. `
          : "") +
        "However many people are available, this work cannot compress below that many sequential handoffs.",
      headline: longestChain.crossProject
        ? `Critical chain is ${longestChain.length} tasks deep across ${longestChain.projectIds.length} projects`
        : `Critical chain is ${longestChain.length} tasks deep`,
      kind: "chain",
      level: longestChain.crossProject || longestChain.length >= LONG_CHAIN_THRESHOLD * 2 ? "warning" : "info",
      projectIds: longestChain.projectIds,
      taskIds: longestChain.path,
    });
  }

  const hubs = bottlenecks.filter((entry) => entry.directBlockedCount >= HUB_FANOUT_THRESHOLD);
  if (hubs.length > 0) {
    findings.push({
      detail:
        `"${hubs[0].title}" directly gates ${hubs[0].directBlockedCount} tasks. ` +
        "A single task with this much fan-out is a single point of failure; splitting it into " +
        "independently completable pieces would let some of the blocked work start sooner.",
      headline: hubs.length === 1 ? "1 dependency hub" : `${hubs.length} dependency hubs`,
      kind: "hub",
      level: "info",
      projectIds: [...new Set(hubs.map((entry) => entry.projectId))],
      taskIds: hubs.map((entry) => entry.taskId),
    });
  }

  if (findings.length === 0) {
    findings.push({
      detail:
        graph.edgeCount === 0
          ? "No blocking dependencies have been defined anywhere in this workspace, so there is no dependency risk to report."
          : `All ${graph.edgeCount} blocking link${graph.edgeCount === 1 ? "" : "s"} are either satisfied or gate no open work.`,
      headline: "No dependency risks detected",
      kind: "clear",
      level: "info",
      projectIds: [],
      taskIds: [],
    });
  }

  // ── Per-project attribution ───────────────────────────────────────────────
  const byProject: ProjectRiskAttribution[] = projects.map((project) => {
    const inbound = crossProjectEdges.filter((edge) => edge.blockedProjectId === project.id).length;
    const outbound = crossProjectEdges.filter((edge) => edge.blockerProjectId === project.id).length;

    return {
      bottleneckCount: bottlenecks.filter((entry) => entry.projectId === project.id).length,
      cycleCount: cycles.filter((entry) => entry.projectIds.includes(project.id)).length,
      // A finding belongs to a project if it touches any of its tasks, so a
      // cross-project cycle correctly appears on every board it involves.
      findings: findings.filter((finding) => (finding.projectIds ?? []).includes(project.id)),
      inboundCrossProject: inbound,
      outboundCrossProject: outbound,
      projectId: project.id,
      projectName: project.name,
    };
  });

  const liveCross = crossProjectEdges.filter((edge) => edge.live).length;
  const crossCycles = cycles.filter((entry) => entry.crossProject).length;

  const headline = (() => {
    if (graph.edgeCount === 0) {
      return "No blocking dependencies defined yet.";
    }
    if (crossCycles > 0) {
      return `${crossCycles} circular dependenc${crossCycles === 1 ? "y" : "ies"} spanning multiple projects — no single board shows the whole loop.`;
    }
    if (crossBottlenecks.length > 0) {
      return `${crossBottlenecks.length} task${crossBottlenecks.length === 1 ? "" : "s"} ${crossBottlenecks.length === 1 ? "is" : "are"} blocking work in another project.`;
    }
    if (crossProjectEdges.length > 0) {
      return `${crossProjectEdges.length} dependenc${crossProjectEdges.length === 1 ? "y" : "ies"} cross a project boundary (${liveCross} still live).`;
    }
    return `All ${graph.edgeCount} blocking link${graph.edgeCount === 1 ? "" : "s"} stay within a single project.`;
  })();

  return {
    blockingEdgeCount: graph.edgeCount,
    bottlenecks,
    byProject,
    crossProjectEdgeCount: crossProjectEdges.length,
    crossProjectEdges,
    cycles,
    dependencyCount: dependencies.length,
    findings,
    headline,
    longestChain,
    taskCount: tasks.length,
  };
}

/**
 * Would adding `blocker → blocked` create a cycle?
 *
 * Replaces a recursive check that lived in the dependencies route and had two
 * defects: it treated `RELATED_TO` as a blocking edge (so linking two merely
 * related tasks could be rejected as circular), and it re-walked shared
 * subgraphs without memoisation, going exponential on a diamond.
 *
 * This reuses the normalized graph and asks one question: is `blocker` already
 * reachable from `blocked`? If so, adding the edge closes a loop.
 *
 * Must be given every dependency in the tenant, not just one project's — a chain
 * can leave a project and return, so a project-scoped check would miss the loop.
 */
export function wouldCreateCycle(
  blockerTaskId: string,
  blockedTaskId: string,
  dependencies: RiskDependency[],
): boolean {
  if (blockerTaskId === blockedTaskId) {
    return true;
  }

  const graph = buildBlockingGraph(dependencies);

  return downstreamOf(graph, blockedTaskId).has(blockerTaskId);
}
