/**
 * Behavioral tests for the intelligence narrator.
 *
 * Run with Node 22+:
 *   node --experimental-strip-types scripts/test-narrative.ts
 *
 * `buildSummary` and `buildRecommendations` turn already-computed signals into
 * prose. They are deterministic by design — the same analysis must always read
 * the same way — so they are exactly the kind of thing that should be pinned
 * down by assertions rather than eyeballed in the UI.
 *
 * The contract these tests defend: the narrator only ever *phrases* numbers the
 * scorer produced. It must never invent one, and it must never disagree with
 * the factor list the UI renders beside it.
 */

import {
  buildRecommendations,
  buildSummary,
} from "../src/lib/domain/intelligence-narrative.ts";
import type {
  HealthConfidence,
  HealthSignal,
  SlippageStats,
  VelocityTrend,
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
    console.error(`        got: ${JSON.stringify(detail)}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function signal(overrides: Partial<HealthSignal> & Pick<HealthSignal, "key">): HealthSignal {
  return {
    detail: "Some detail sentence.",
    evidence: {},
    label: "Some signal",
    maxPoints: 26,
    points: 10,
    ratio: 0.4,
    severity: "medium",
    ...overrides,
  } as HealthSignal;
}

const HIGH_CONFIDENCE: HealthConfidence = { level: "high", caveats: [] };
const LOW_CONFIDENCE: HealthConfidence = {
  level: "low",
  caveats: ["Only 3 tasks — percentages are noisy.", "A second caveat."],
};

const NO_SLIPPAGE: SlippageStats = {
  averageDaysPerPush: 0,
  blockerPushCount: 0,
  noHistory: true,
  pullCount: 0,
  pushCount: 0,
  tasksPushed: 0,
  totalDaysPushed: 0,
  worstPushDays: 0,
};

const STEADY_VELOCITY: VelocityTrend = {
  changeRatio: 0,
  direction: "steady",
  priorCompleted: 4,
  priorPerWeek: 1,
  recentCompleted: 4,
  recentPerWeek: 1,
  totalCompleted: 8,
  weeksObserved: 8,
};

// ---------------------------------------------------------------------------
section("buildSummary — opening line");
{
  const text = buildSummary("Apollo", 74, "Watch", 55, [], HIGH_CONFIDENCE);

  check("names the project", text.includes("Apollo"), text);
  check("states the score out of 100", text.includes("74/100"), text);
  check("states the band", text.includes("(Watch)"), text);
  check("states completion", text.includes("55% complete"), text);
}

// ---------------------------------------------------------------------------
section("buildSummary — no factors");
{
  const text = buildSummary("Apollo", 100, "Healthy", 100, [], HIGH_CONFIDENCE);

  check(
    "says nothing is costing points",
    text.includes("No health signals are currently costing points."),
    text,
  );
  check("omits the confidence tail at high confidence", !text.includes("Confidence is"), text);
}

{
  const text = buildSummary("Apollo", 100, "Healthy", 100, [], LOW_CONFIDENCE);

  check("appends the confidence tail when not high", text.includes("Confidence is low"), text);
  check("quotes only the first caveat", text.includes(LOW_CONFIDENCE.caveats[0]), text);
  check("does not quote the second caveat", !text.includes("A second caveat."), text);
}

// ---------------------------------------------------------------------------
section("buildSummary — with factors");
{
  const factors = [
    signal({ key: "overdue", label: "Overdue work", points: 20, detail: "Twelve are late." }),
    signal({ key: "blocked", label: "Blocked work", points: 15 }),
    signal({ key: "slippage", label: "Schedule slippage", points: 9 }),
    signal({ key: "velocity", label: "Delivery velocity", points: 4 }),
  ];

  const text = buildSummary("Apollo", 52, "At risk", 30, factors, HIGH_CONFIDENCE);

  check("lists the top three drivers", text.includes("overdue work (−20)"), text);
  check("includes the second driver", text.includes("blocked work (−15)"), text);
  check("includes the third driver", text.includes("schedule slippage (−9)"), text);
  check("excludes the fourth driver", !text.includes("delivery velocity"), text);
  check("quotes the worst factor's detail verbatim", text.includes("Twelve are late."), text);
  check("lowercases the driver labels", !text.includes("Overdue work (−20)"), text);
}

// ---------------------------------------------------------------------------
section("buildSummary — determinism");
{
  const factors = [signal({ key: "overdue", label: "Overdue work", points: 20 })];
  const first = buildSummary("Apollo", 80, "Watch", 40, factors, LOW_CONFIDENCE);

  let stable = true;
  for (let index = 0; index < 200; index += 1) {
    if (buildSummary("Apollo", 80, "Watch", 40, factors, LOW_CONFIDENCE) !== first) {
      stable = false;
      break;
    }
  }

  check("is deterministic over 200 runs", stable);
}

// ---------------------------------------------------------------------------
section("buildRecommendations — one per factor, in factor order");
{
  const factors = [
    signal({ key: "blocked", points: 15 }),
    signal({ key: "overdue", points: 20 }),
  ];

  const out = buildRecommendations(factors, {
    blockedCount: 3,
    overdueCount: 12,
    slippage: NO_SLIPPAGE,
    unassignedOpen: 0,
    velocity: STEADY_VELOCITY,
  });

  check("emits one line per factor", out.length === 2, out);
  check("preserves the caller's factor order", out[0].includes("blocked task"), out);
  check("pluralises counts correctly", out[0].includes("3 blocked tasks"), out);
  check("second line addresses overdue", out[1].includes("12 overdue tasks"), out);
}

// ---------------------------------------------------------------------------
section("buildRecommendations — singular vs plural");
{
  const out = buildRecommendations([signal({ key: "overdue" })], {
    blockedCount: 0,
    overdueCount: 1,
    slippage: NO_SLIPPAGE,
    unassignedOpen: 0,
    velocity: STEADY_VELOCITY,
  });

  check("uses the singular for one overdue task", out[0].includes("1 overdue task:"), out);
  check("does not say '1 overdue tasks'", !out[0].includes("1 overdue tasks"), out);
}

// ---------------------------------------------------------------------------
section("buildRecommendations — slippage branches on blocker pushes");
{
  const blockerSlippage: SlippageStats = {
    ...NO_SLIPPAGE,
    blockerPushCount: 2,
    noHistory: false,
    pushCount: 5,
    totalDaysPushed: 30,
  };

  const withBlockers = buildRecommendations([signal({ key: "slippage" })], {
    blockedCount: 0,
    overdueCount: 0,
    slippage: blockerSlippage,
    unassignedOpen: 0,
    velocity: STEADY_VELOCITY,
  });

  check(
    "calls out pushes that landed on blocking tasks",
    withBlockers[0].includes("2 due-date pushes") && withBlockers[0].includes("downstream"),
    withBlockers,
  );

  const withoutBlockers = buildRecommendations([signal({ key: "slippage" })], {
    blockedCount: 0,
    overdueCount: 0,
    slippage: { ...blockerSlippage, blockerPushCount: 0 },
    unassignedOpen: 0,
    velocity: STEADY_VELOCITY,
  });

  check(
    "otherwise reports total days moved",
    withoutBlockers[0].includes("30 days"),
    withoutBlockers,
  );
  check(
    "does not mention blocking tasks when none were pushed",
    !withoutBlockers[0].includes("blocking tasks"),
    withoutBlockers,
  );
}

// ---------------------------------------------------------------------------
section("buildRecommendations — velocity branches on stalled");
{
  const stalled = buildRecommendations([signal({ key: "velocity" })], {
    blockedCount: 0,
    overdueCount: 0,
    slippage: NO_SLIPPAGE,
    unassignedOpen: 0,
    velocity: { ...STEADY_VELOCITY, direction: "stalled" },
  });

  check(
    "stalled asks whether status is simply not being updated",
    stalled[0].includes("not updating task status"),
    stalled,
  );

  const declining = buildRecommendations([signal({ key: "velocity" })], {
    blockedCount: 0,
    overdueCount: 0,
    slippage: NO_SLIPPAGE,
    unassignedOpen: 0,
    velocity: { ...STEADY_VELOCITY, direction: "declining" },
  });

  check("declining points at the workload view", declining[0].includes("workload view"), declining);
}

// ---------------------------------------------------------------------------
section("buildRecommendations — unassigned work is appended, not a factor");
{
  const none = buildRecommendations([], {
    blockedCount: 0,
    overdueCount: 0,
    slippage: NO_SLIPPAGE,
    unassignedOpen: 0,
    velocity: STEADY_VELOCITY,
  });

  check("no factors and no unassigned work yields nothing", none.length === 0, none);

  const unassigned = buildRecommendations([], {
    blockedCount: 0,
    overdueCount: 0,
    slippage: NO_SLIPPAGE,
    unassignedOpen: 4,
    velocity: STEADY_VELOCITY,
  });

  check("unassigned work alone still produces a line", unassigned.length === 1, unassigned);
  check("uses plural agreement for four", unassigned[0].includes("4 open tasks have"), unassigned);
  check("refers to them collectively", unassigned[0].includes("moving them"), unassigned);

  const one = buildRecommendations([], {
    blockedCount: 0,
    overdueCount: 0,
    slippage: NO_SLIPPAGE,
    unassignedOpen: 1,
    velocity: STEADY_VELOCITY,
  });

  check("uses singular agreement for one", one[0].includes("1 open task has"), one);
  check("refers to it singularly", one[0].includes("moving it"), one);
}

// ---------------------------------------------------------------------------
section("buildRecommendations — unknown keys are ignored");
{
  // `healthy` signals are never passed in, but a future signal key must not
  // throw or emit an empty string.
  const out = buildRecommendations([signal({ key: "deadline" }), signal({ key: "milestone" })], {
    blockedCount: 0,
    overdueCount: 0,
    slippage: NO_SLIPPAGE,
    unassignedOpen: 0,
    velocity: STEADY_VELOCITY,
  });

  check("emits a line for every known key", out.length === 2, out);
  check("no line is empty", out.every((line) => line.trim().length > 0), out);
}

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
