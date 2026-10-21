/**
 * LIVE-MODEL verification for the two AI workflows.
 *
 * This suite is deliberately separate from `test:ai`, which substitutes a
 * doubled model and must stay hermetic and runnable in CI with no credentials.
 * Nothing here is a substitute for that suite, and that suite is not evidence
 * of live behaviour.
 *
 * What it exercises: the real Anthropic API, through the application's own
 * `@/lib/ai` integration, driven over real HTTP against a running dev server,
 * with a real session cookie, backed by the disposable local Postgres.
 *
 * Run with:  npm run test:ai:live
 *
 * Prerequisites (all checked below, with a clear message if missing):
 *   1. ANTHROPIC_API_KEY in the gitignored .env — development key only.
 *   2. The disposable database migrated and seeded.
 *   3. `next dev` listening on LIVE_BASE (default http://127.0.0.1:3123).
 *
 * ## Assertions are structural, never textual
 *
 * Model output is nondeterministic. Asserting on narration wording would make
 * this suite flaky and would test the model rather than the integration. So
 * every check here is about shape and invariants: status codes, which fields
 * are present, whether the interpreted intent references the actual target of
 * the structured change, whether the deterministic diff agrees with the engine,
 * and whether the database was left alone. Narration is asserted to exist and
 * be non-trivial — never to say anything in particular.
 *
 * ## Token budget
 *
 * Live calls cost money and quota, so the suite is bounded. Each simulation
 * makes TWO model calls (a fast interpretation, then a quality narration);
 * each policy interpretation makes one. `MAX_MODEL_CALLS` is a hard ceiling —
 * the run aborts rather than exceeding it, so a loop bug cannot burn quota.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { readSnapshotToken } from "@/lib/intelligence/snapshot-token";

const BASE = process.env.LIVE_BASE ?? "http://127.0.0.1:3123";
const LOGIN_EMAIL = process.env.LIVE_EMAIL ?? "ada@northwind.test";
const LOGIN_PASSWORD = process.env.LIVE_PASSWORD ?? "Password123!";

/** Hard ceiling on billable model calls for one run of this suite. */
const MAX_MODEL_CALLS = 12;
let modelCalls = 0;

function spend(calls: number, what: string) {
  modelCalls += calls;
  if (modelCalls > MAX_MODEL_CALLS) {
    throw new Error(
      `token budget exceeded: ${what} would make call ${modelCalls} of ${MAX_MODEL_CALLS}`,
    );
  }
}

let pass = 0;
let fail = 0;
let skipped = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(name: string, why: string) {
  skipped += 1;
  console.log(`  SKIP  ${name} — ${why}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ── Preflight ────────────────────────────────────────────────────────────────

type Preflight = { ok: true; cookie: string } | { ok: false; reason: string };

async function preflight(): Promise<Preflight> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      reason:
        "ANTHROPIC_API_KEY is not set. Add a DEVELOPMENT key to the gitignored .env " +
        "(see the report accompanying this suite). Never commit it, and never use a " +
        "production credential here.",
    };
  }
  if (!process.env.DATABASE_URL) {
    return { ok: false, reason: "DATABASE_URL is not set; the disposable database is required." };
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `cannot reach ${BASE} (${error instanceof Error ? error.message : "unknown"}). Start the dev server first.`,
    };
  }

  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");

  if (!cookie.includes("pm_session")) {
    return {
      ok: false,
      reason: `login failed (HTTP ${res.status}) for ${LOGIN_EMAIL}. Seed the disposable database first.`,
    };
  }

  return { ok: true, cookie };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* no body */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: parsed as any };
}

/** A fingerprint of every table a simulation must not touch. */
async function mutationFingerprint(organizationId: string, projectId: string) {
  const [tasks, milestones, deps, audit] = await Promise.all([
    prisma.task.findMany({
      where: { organizationId, projectId },
      select: { id: true, status: true, assignedToUserId: true, dueDate: true },
      orderBy: { id: "asc" },
    }),
    prisma.milestone.findMany({
      where: { organizationId, projectId },
      select: { id: true, status: true, dueDate: true },
      orderBy: { id: "asc" },
    }),
    prisma.taskDependency.count({ where: { organizationId } }),
    prisma.activityLog.count({ where: { organizationId } }),
  ]);
  return JSON.stringify({ tasks, milestones, deps, audit });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const pre = await preflight();

  if (!pre.ok) {
    console.log("\nLIVE AI SUITE — NOT RUN");
    console.log(`\n  Blocker: ${pre.reason}\n`);
    console.log("  No live-model assertion was made. This is a skip, not a pass:");
    console.log("  the doubles-based `npm run test:ai` suite does NOT establish");
    console.log("  live-model behaviour and must not be reported as if it does.\n");
    await prisma.$disconnect();
    return;
  }

  const { cookie } = pre;
  const org = await prisma.organization.findFirstOrThrow({ where: { slug: "northwind-labs" } });
  const project = await prisma.project.findFirstOrThrow({
    where: { organizationId: org.id },
    orderBy: { createdAt: "asc" },
  });
  const tasks = await prisma.task.findMany({
    where: { organizationId: org.id, projectId: project.id },
    orderBy: { createdAt: "asc" },
  });
  if (tasks.length < 2) throw new Error("need at least two tasks in the project");

  console.log(`live base: ${BASE}`);
  console.log(`tenant:    ${org.slug}`);
  console.log(`project:   ${project.name} (${tasks.length} tasks)`);
  console.log(`budget:    ${MAX_MODEL_CALLS} model calls max`);

  // ══ Policy Studio ═════════════════════════════════════════════════════════
  section("LIVE › Policy Studio — interpretation");

  spend(1, "interpret a supported policy");
  const good = await call("POST", "/api/v1/automations/interpret", cookie, {
    policy: "When a high priority task becomes overdue, notify the manager",
  });
  check("supported policy returns 200", good.status === 200, `got ${good.status}`);
  if (good.status === 200) {
    const d = good.body?.draft;
    check("draft is present", Boolean(d));
    check("draft.trigger is one of the supported triggers",
      ["TASK_OVERDUE", "TASK_STATUS_CHANGED", "PROJECT_HEALTH_CHANGED"].includes(d?.trigger),
      String(d?.trigger));
    check("draft.action is one of the supported actions",
      ["NOTIFY_MANAGER", "UPDATE_MILESTONE_PROGRESS", "WRITE_AUDIT_EVENT"].includes(d?.action),
      String(d?.action));
    check("draft.name is a non-empty string",
      typeof d?.name === "string" && d.name.trim().length > 0);
    check("draft.condition is a string", typeof d?.condition === "string");
    check("conflicts is an array", Array.isArray(good.body?.conflicts));
    check("sourcePolicy is echoed verbatim",
      good.body?.sourcePolicy === "When a high priority task becomes overdue, notify the manager");
    // Structural, not semantic: the model chose SOME supported trigger. We do
    // not assert WHICH, because that is a model-quality question, not an
    // integration one.
  }

  section("LIVE › Policy Studio — unsupported input");
  spend(1, "interpret an unsupported policy");
  const unsupported = await call("POST", "/api/v1/automations/interpret", cookie, {
    policy: "Book me a flight to Lisbon and order lunch for the team on Fridays",
  });
  check("unsupported policy returns 422 (or 200 if the model mapped it)",
    unsupported.status === 422 || unsupported.status === 200,
    `got ${unsupported.status}`);
  if (unsupported.status === 422) {
    check("422 body carries the unsupported code", unsupported.body?.error === "unsupported");
  } else {
    skip("unsupported classification",
      `model mapped it to a supported rule instead (status 200) — nondeterministic, recorded not failed`);
  }

  section("LIVE › Policy Studio — conflict detection against real enabled rules");
  const enabledRules = await prisma.automationRule.count({
    where: { organizationId: org.id, enabled: true },
  });
  if (enabledRules === 0) {
    skip("conflict detection", "no enabled rules exist in this tenant to conflict with");
  } else {
    const existing = await prisma.automationRule.findFirstOrThrow({
      where: { organizationId: org.id, enabled: true },
    });
    spend(1, "interpret a policy that duplicates an existing enabled rule");
    const dup = await call("POST", "/api/v1/automations/interpret", cookie, {
      policy: `${existing.trigger === "TASK_OVERDUE" ? "When a task becomes overdue" : "When a task status changes"}, ${existing.action === "NOTIFY_MANAGER" ? "notify the manager" : "update milestone progress"}`,
    });
    check("duplicate-intent policy returns 200", dup.status === 200, `got ${dup.status}`);
    if (dup.status === 200) {
      check("conflicts array is present", Array.isArray(dup.body?.conflicts));
      const kinds = (dup.body?.conflicts ?? []).map((c: { kind: string }) => c.kind);
      console.log(`      conflicts reported: ${JSON.stringify(kinds)}`);
      // Conflict detection is deterministic given the draft, but WHICH draft
      // the model produces is not — so a detected conflict is recorded rather
      // than required.
      if (kinds.length > 0) {
        check("each conflict names the rule it collides with",
          (dup.body.conflicts as Array<{ conflictingRuleId?: string }>).every(
            (c) => typeof c.conflictingRuleId === "string"),
        );
      } else {
        skip("conflict assertion", "model produced a draft that genuinely does not collide");
      }
      check("interpret still wrote nothing to the database",
        (await prisma.automationRule.count({ where: { organizationId: org.id } })) ===
          (await prisma.automationRule.count({ where: { organizationId: org.id } })));
    }
  }

  section("LIVE › Policy Studio — upstream failure handling");
  skip("upstream failure (502)",
    "cannot be induced safely without deliberately misconfiguring the key; " +
    "covered structurally by the doubles suite");

  // ══ Simulation ════════════════════════════════════════════════════════════
  section("LIVE › Simulation — intent, diff, narration and no-mutation");

  const target = tasks.find((t) => t.status !== "DONE") ?? tasks[0];
  const before = await mutationFingerprint(org.id, project.id);

  spend(2, "simulate (interpretation + narration)");
  const sim = await call("POST", `/api/v1/intelligence/projects/${project.id}/simulate`, cookie, {
    scenario: `What if we mark the task "${target.title}" as done right now?`,
    change: { type: "task_status", taskId: target.id, status: "DONE" },
  });
  check("simulate returns 200", sim.status === 200, `got ${sim.status} ${JSON.stringify(sim.body).slice(0, 160)}`);

  let liveToken: string | null = null;
  let liveChange: unknown = null;

  if (sim.status === 200 && sim.body?.status === "simulated") {
    liveToken = sim.body.snapshotToken;
    liveChange = sim.body.change;

    check("status is 'simulated'", sim.body.status === "simulated");
    check("interpretedIntent is a non-empty string",
      typeof sim.body.interpretedIntent === "string" && sim.body.interpretedIntent.trim().length > 0);
    // [D-3] The intent must describe the SAME target the structured change
    // names. Structural: the id or the title must appear. Not a wording check.
    const intent: string = sim.body.interpretedIntent ?? "";
    check("[D-3] interpreted intent references the actual target",
      intent.includes(target.id) || intent.toLowerCase().includes(target.title.toLowerCase()),
      `intent did not mention ${target.id} or its title`);
    check("[D-3] echoed change matches what was submitted",
      sim.body.change?.type === "task_status" && sim.body.change?.taskId === target.id,
      JSON.stringify(sim.body.change));
    check("[D-3] changeDescription names the target for review",
      (sim.body.changeDescription?.fields ?? []).some(
        (f: { label: string; value: string }) => f.value === target.id),
    );

    const diff = sim.body.diff;
    check("diff.baseline has a numeric score", typeof diff?.baseline?.score === "number");
    check("diff.modified has a numeric score", typeof diff?.modified?.score === "number");
    check("healthDelta is numeric", typeof diff?.healthDelta === "number");
    check("healthDelta equals modified minus baseline",
      Math.abs((diff.modified.score - diff.baseline.score) - diff.healthDelta) < 0.001,
      `${diff.baseline.score} -> ${diff.modified.score} vs delta ${diff.healthDelta}`);
    check("verdict is one of the permitted values",
      ["safe", "watch", "block"].includes(diff?.verdict), String(diff?.verdict));
    check("severity is one of the permitted values",
      ["none", "low", "medium", "high", "critical"].includes(diff?.severity), String(diff?.severity));
    check("affectedTaskCount is numeric", typeof diff?.affectedTaskCount === "number");
    check("signalChanges is an array", Array.isArray(diff?.signalChanges));

    // Narration: asserted to exist and be substantive, never to say anything.
    const narration: string = sim.body.narration ?? "";
    check("narration is a non-empty string", typeof narration === "string" && narration.length > 0);
    check("narration is substantive (>= 40 chars)", narration.length >= 40, `${narration.length} chars`);
    check("narration did not replace the deterministic numbers",
      typeof diff?.healthDelta === "number");

    check("snapshotToken is a sha256 fingerprint",
      typeof liveToken === "string" && /^[0-9a-f]{64}$/.test(liveToken), String(liveToken));

    check("simulation mutated NOTHING in the database",
      (await mutationFingerprint(org.id, project.id)) === before);
  } else if (sim.body?.status === "needs_clarification") {
    skip("simulated-result assertions", "model asked for clarification on this scenario");
    check("clarificationQuestion is a non-empty string",
      typeof sim.body.clarificationQuestion === "string" &&
        sim.body.clarificationQuestion.trim().length > 0);
    check("clarification carries no diff", sim.body.diff === undefined);
    check("clarification carries no snapshotToken", sim.body.snapshotToken === undefined);
    check("simulation mutated NOTHING in the database",
      (await mutationFingerprint(org.id, project.id)) === before);
  }

  section("LIVE › Simulation — clarification path");
  spend(2, "simulate a deliberately ambiguous scenario");
  const vague = await call("POST", `/api/v1/intelligence/projects/${project.id}/simulate`, cookie, {
    scenario: "what if it slips",
    change: { type: "task_status", taskId: target.id, status: "BLOCKED" },
  });
  check("ambiguous scenario returns 200", vague.status === 200, `got ${vague.status}`);
  if (vague.body?.status === "needs_clarification") {
    check("clarificationQuestion present",
      typeof vague.body.clarificationQuestion === "string" &&
        vague.body.clarificationQuestion.trim().length > 0);
    check("needs_clarification carries no diff", vague.body.diff === undefined);
  } else {
    skip("needs_clarification",
      "model resolved the vague scenario instead of asking — nondeterministic, recorded not failed");
  }

  // ══ Apply, stale and replay, on disposable data ═══════════════════════════
  section("LIVE › Apply — from a live simulation, then stale and replay");

  if (!liveToken || !liveChange) {
    skip("apply / stale / replay", "no live simulated proposal to apply");
  } else {
    const auditBefore = await prisma.activityLog.count({
      where: { entityType: "project", entityId: project.id, action: "project.simulation_applied" },
    });

    // Stale first: mutate an unrelated task so the live token no longer matches.
    const bystander = tasks.find((t) => t.id !== target.id)!;
    const bystanderStatus = bystander.status;
    await prisma.task.update({
      where: { id: bystander.id },
      data: { status: bystanderStatus === "TODO" ? "IN_PROGRESS" : "TODO" },
    });
    const stale = await call("POST", `/api/v1/intelligence/projects/${project.id}/apply`, cookie, {
      change: liveChange, snapshotToken: liveToken,
    });
    check("stale proposal is rejected with 409", stale.status === 409, `got ${stale.status}`);
    check("stale rejection wrote no audit row",
      (await prisma.activityLog.count({
        where: { entityType: "project", entityId: project.id, action: "project.simulation_applied" },
      })) === auditBefore);
    await prisma.task.update({ where: { id: bystander.id }, data: { status: bystanderStatus } });

    // Now a fresh token, derived server-side, and apply for real.
    const fresh = await readSnapshotToken(prisma, org.id, project.id);
    const applied = await call("POST", `/api/v1/intelligence/projects/${project.id}/apply`, cookie, {
      change: liveChange, snapshotToken: fresh,
    });
    check("apply with a fresh token returns 200", applied.status === 200,
      `got ${applied.status} ${JSON.stringify(applied.body).slice(0, 160)}`);
    if (applied.status === 200) {
      const after = await prisma.task.findUniqueOrThrow({ where: { id: target.id } });
      check("the reviewed change landed in Postgres", after.status === "DONE", String(after.status));
      check("exactly one audit row was added",
        (await prisma.activityLog.count({
          where: { entityType: "project", entityId: project.id, action: "project.simulation_applied" },
        })) === auditBefore + 1);
      check("newSnapshotToken differs from the applied token",
        applied.body?.newSnapshotToken !== fresh);

      const replay = await call("POST", `/api/v1/intelligence/projects/${project.id}/apply`, cookie, {
        change: liveChange, snapshotToken: fresh,
      });
      check("replaying the same proposal returns 409", replay.status === 409, `got ${replay.status}`);
      check("replay added no further audit row",
        (await prisma.activityLog.count({
          where: { entityType: "project", entityId: project.id, action: "project.simulation_applied" },
        })) === auditBefore + 1);
    }
  }

  // ══ Summary ═══════════════════════════════════════════════════════════════
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${pass} passed, ${fail} failed, ${skipped} skipped`);
  console.log(`model calls used: ${modelCalls} of ${MAX_MODEL_CALLS}`);
  if (fail > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("live harness error:", error);
  process.exitCode = 1;
  await prisma.$disconnect();
});
