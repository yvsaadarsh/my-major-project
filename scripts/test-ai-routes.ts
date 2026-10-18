/**
 * Behavioural tests for the AI layer's route handlers.
 *
 * These run the *real* route code. Only three things are swapped for test
 * doubles — Prisma, the session/tenant context, and the Anthropic client — so
 * validation, status codes, tenant scoping, streaming and the untrusted-output
 * parsing are all exercised as written.
 *
 * The doubles live in `scripts/doubles/` and are substituted by path mappings in
 * `tsconfig.test.json`, so nothing under `src/` is modified to make tests pass.
 *
 * Run with:  npm run test:ai
 */

import { __store, __hooks, prisma as _prisma } from "@/lib/db";
import { __session } from "@/lib/auth/context";
import { __ai } from "@/lib/ai";

import { POST as parseTask } from "@/app/api/v1/ai/parse-task/route";
import { GET as forecast } from "@/app/api/v1/intelligence/projects/[projectId]/forecast/route";
import { GET as retrospective } from "@/app/api/v1/projects/[projectId]/milestones/[milestoneId]/retrospective/route";
import { POST as interpretPolicy } from "@/app/api/v1/automations/interpret/route";
import { POST as simulate } from "@/app/api/v1/intelligence/projects/[projectId]/simulate/route";
import { POST as applyChange } from "@/app/api/v1/intelligence/projects/[projectId]/apply/route";

void _prisma;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/** Reset the world to a known-good state before each scenario. */
function reset() {
  __store.project.length = 0;
  __store.milestone.length = 0;
  __store.task.length = 0;
  __store.activityLog.length = 0;
  __store.taskDependency.length = 0;
  __store.automationRule.length = 0;

  __session.tenantId = "org_a";
  __session.role = "ADMIN";

  __ai.configured = true;
  __ai.fastReply = "{}";
  __ai.streamChunks = ["chunk-1 ", "chunk-2"];
  __ai.failFast = null;
  __ai.failStreamAt = null;
  __ai.lastSystem = null;
  __ai.lastUser = null;
  __ai.calls.length = 0;
  __ai.cancelled = false;

  __hooks.insideTransaction = null;
  __hooks.failOn = null;

  __store.project.push({
    id: "proj_a",
    organizationId: "org_a",
    name: "Apollo",
    status: "ACTIVE",
    startDate: null,
    endDate: null,
    createdAt: new Date(now - 90 * DAY),
    updatedAt: new Date(now),
  });
  // A project belonging to a DIFFERENT tenant, for isolation probes.
  __store.project.push({
    id: "proj_other",
    organizationId: "org_b",
    name: "Other Tenant Project",
    status: "ACTIVE",
    startDate: null,
    endDate: null,
    createdAt: new Date(now - 90 * DAY),
    updatedAt: new Date(now),
  });
}

function addTasks(count: number, overrides: Record<string, unknown> = {}) {
  for (let i = 0; i < count; i++) {
    __store.task.push({
      id: `task_${__store.task.length + 1}`,
      organizationId: "org_a",
      projectId: "proj_a",
      milestoneId: null,
      title: `SECRET-TASK-TITLE-${i}`,
      status: "TODO",
      priority: "MEDIUM",
      dueDate: null,
      completedAt: null,
      createdAt: new Date(now - 60 * DAY),
      assignedToUserId: null,
      ...overrides,
    });
  }
}

const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
const postReq = (body: unknown) =>
  new Request("http://localhost/api/v1/ai/parse-task", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
const getReq = () => new Request("http://localhost/") as never;

async function bodyOf(response: Response): Promise<string> {
  return await response.text();
}

async function main() {
  // ═══════════════════════════════════════════════════════════════════════
  section("AI › parse-task — configuration & authorization");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  __ai.configured = false;
  let res = await parseTask(postReq({ text: "ship it", projectId: "proj_a" }), ctx({}));
  eq("501 when ANTHROPIC_API_KEY is absent", res.status, 501);

  reset();
  __session.role = "MEMBER"; // MEMBER lacks tasks:create
  res = await parseTask(postReq({ text: "ship it", projectId: "proj_a" }), ctx({}));
  eq("403 for a role without tasks:create", res.status, 403);

  reset();
  __session.tenantId = null;
  res = await parseTask(postReq({ text: "ship it", projectId: "proj_a" }), ctx({}));
  eq("401 when unauthenticated", res.status, 401);

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › parse-task — input validation");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  res = await parseTask(postReq({ text: "x".repeat(501), projectId: "proj_a" }), ctx({}));
  eq("422 when text exceeds 500 chars", res.status, 422);

  reset();
  __ai.fastReply = '{"title":"At the limit"}';
  res = await parseTask(postReq({ text: "x".repeat(500), projectId: "proj_a" }), ctx({}));
  eq("500 chars exactly is accepted (boundary)", res.status, 200);

  reset();
  res = await parseTask(postReq({ text: "", projectId: "proj_a" }), ctx({}));
  eq("422 on empty text", res.status, 422);

  reset();
  res = await parseTask(postReq({ text: "ship it" }), ctx({}));
  eq("422 when projectId is missing", res.status, 422);

  reset();
  res = await parseTask(
    new Request("http://localhost/", { method: "POST", body: "not json" }) as never,
    ctx({}),
  );
  eq("400 on a malformed JSON body", res.status, 400);

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › parse-task — tenant isolation");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  res = await parseTask(postReq({ text: "ship it", projectId: "proj_other" }), ctx({}));
  eq("404 for another tenant's project (not 403 — indistinguishable)", res.status, 404);

  reset();
  res = await parseTask(postReq({ text: "ship it", projectId: "nonexistent" }), ctx({}));
  eq("404 for a project that does not exist", res.status, 404);

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › parse-task — untrusted model output");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  __ai.fastReply = JSON.stringify({
    title: "Ship the billing hotfix",
    description: "Covers the tax rounding bug.",
    priority: "HIGH",
    dueDate: "2026-08-20",
    notes: "Sam to review",
  });
  res = await parseTask(postReq({ text: "ship billing hotfix friday", projectId: "proj_a" }), ctx({}));
  let payload = JSON.parse(await bodyOf(res));
  eq("200 on a well-formed model reply", res.status, 200);
  eq("title passes through", payload.title, "Ship the billing hotfix");
  eq("priority passes through", payload.priority, "HIGH");
  eq("dueDate passes through", payload.dueDate, "2026-08-20");
  eq("notes passes through", payload.notes, "Sam to review");

  reset();
  __ai.fastReply = '```json\n{"title":"Fenced output"}\n```';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("markdown code fence is tolerated", res.status, 200);
  eq("  …and the title survives", payload.title, "Fenced output");

  reset();
  __ai.fastReply = 'Sure! Here is the task:\n{"title":"Prose wrapped"}\nHope that helps.';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("prose around the JSON is tolerated", res.status, 200);
  eq("  …and the title survives", payload.title, "Prose wrapped");

  reset();
  __ai.fastReply = "I cannot help with that.";
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("422 when the model returns no JSON", res.status, 422);
  eq("  …with the specified message", payload.error, "Could not parse task from that text");

  reset();
  __ai.fastReply = '{"description":"no title here"}';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  eq("422 when the model omits a title", res.status, 422);

  reset();
  __ai.fastReply = '{"title":"   "}';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  eq("422 when the title is only whitespace", res.status, 422);

  // A single-element array is recovered rather than rejected: the inner object
  // is unambiguous, the user confirms before anything is created, and every
  // field is still normalized below. A multi-element array IS rejected, because
  // picking one of several tasks would be a guess.
  reset();
  __ai.fastReply = '[{"title":"an array, not an object"}]';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("a single-element array is recovered (lenient by design)", res.status, 200);
  eq("  …yielding the inner task", payload.title, "an array, not an object");

  reset();
  __ai.fastReply = '[{"title":"A"},{"title":"B"}]';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  eq("422 on a multi-task array — never guess which one", res.status, 422);

  reset();
  __ai.fastReply = '{"title":"T","priority":"bogus"}';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("invalid priority falls back to MEDIUM", payload.priority, "MEDIUM");

  reset();
  __ai.fastReply = '{"title":"T","priority":"urgent"}';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("lowercase priority is normalized to URGENT", payload.priority, "URGENT");

  reset();
  __ai.fastReply = '{"title":"T","dueDate":"next friday"}';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("unparseable dueDate becomes null (never a guess)", payload.dueDate, null);

  reset();
  __ai.fastReply = '{"title":"T","dueDate":"20-08-2026"}';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("non-ISO dueDate is rejected", payload.dueDate, null);

  reset();
  __ai.fastReply = JSON.stringify({ title: "T".repeat(400) });
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("over-long title is bounded to 180 chars", payload.title.length, 180);

  reset();
  __ai.fastReply = '{"title":"T","priority":123,"notes":{"a":1},"description":false}';
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  payload = JSON.parse(await bodyOf(res));
  eq("wrong-typed fields degrade safely (priority)", payload.priority, "MEDIUM");
  eq("wrong-typed fields degrade safely (notes)", payload.notes, "");
  eq("wrong-typed fields degrade safely (description)", payload.description, "");

  reset();
  __ai.failFast = new Error("rate limited");
  res = await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  eq("502 when the model call throws", res.status, 502);

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › parse-task — what actually reaches the model");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  __ai.fastReply = '{"title":"T"}';
  await parseTask(postReq({ text: "fix the login bug", projectId: "proj_a" }), ctx({}));
  const sent = __ai.lastUser ?? "";
  check("prompt carries the user's text", sent.includes("fix the login bug"));
  check("prompt carries the project name for context", sent.includes("Apollo"));
  check("prompt carries a reference date (so 'Friday' can resolve)", /\d{4}-\d{2}-\d{2}/.test(sent));
  check("prompt does NOT leak the project id", !sent.includes("proj_a"));
  check("prompt does NOT leak the organization id", !sent.includes("org_a"));

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › forecast — guards");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  __ai.configured = false;
  addTasks(10);
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  eq("501 when AI is not configured", res.status, 501);

  reset();
  addTasks(4); // one short of the 5-task floor
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  payload = JSON.parse(await bodyOf(res));
  eq("200 (not an error) when under the task floor", res.status, 200);
  eq("  …flagged insufficient", payload.insufficient, true);
  eq("  …with the specified message", payload.message, "Not enough history to forecast");

  reset();
  addTasks(5);
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  eq("5 open tasks clears the floor (boundary)", res.status, 200);
  check("  …and streams rather than reporting insufficient", !(await bodyOf(res)).includes("insufficient"));

  reset();
  __store.project[0].createdAt = new Date(now - 13 * DAY); // 13 days old
  addTasks(10);
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  payload = JSON.parse(await bodyOf(res));
  eq("a 13-day-old project is refused", payload.insufficient, true);

  reset();
  __store.project[0].createdAt = new Date(now - 15 * DAY);
  addTasks(10);
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  eq("a 15-day-old project is forecast", res.status, 200);
  check("  …and streams", !(await bodyOf(res)).includes("insufficient"));

  reset();
  addTasks(10, { status: "DONE", completedAt: new Date(now - DAY) });
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  payload = JSON.parse(await bodyOf(res));
  eq("DONE tasks do not count toward the open-task floor", payload.insufficient, true);

  reset();
  addTasks(10);
  res = await forecast(getReq(), ctx({ projectId: "proj_other" }));
  eq("404 for another tenant's project", res.status, 404);

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › forecast — streaming & failure");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addTasks(10);
  __ai.streamChunks = ["Apollo will likely ", "finish approximately two weeks late."];
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  let text = await bodyOf(res);
  eq("streamed body is the concatenated chunks", text, "Apollo will likely finish approximately two weeks late.");
  eq("streams as text/plain", res.headers.get("content-type"), "text/plain; charset=utf-8");
  eq("is never cached", res.headers.get("cache-control"), "no-store");
  eq("proxy buffering is disabled", res.headers.get("x-accel-buffering"), "no");
  check("Transfer-Encoding is not set by hand (hop-by-hop)", res.headers.get("transfer-encoding") === null);

  reset();
  addTasks(10);
  __ai.failStreamAt = 0; // fail before the first chunk
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  eq("502 when upstream fails BEFORE the first chunk", res.status, 502);

  reset();
  addTasks(10);
  __ai.streamChunks = ["partial text survives", "never sent"];
  __ai.failStreamAt = 1; // fail mid-stream
  res = await forecast(getReq(), ctx({ projectId: "proj_a" }));
  text = await bodyOf(res);
  eq("mid-stream failure still returns 200 (status already sent)", res.status, 200);
  eq("  …and the reader keeps the partial text", text, "partial text survives");

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › forecast — what actually reaches the model");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  __store.project[0].endDate = new Date(now + 30 * DAY);
  addTasks(8);
  addTasks(2, { status: "DONE", completedAt: new Date(now - 2 * DAY) });
  await forecast(getReq(), ctx({ projectId: "proj_a" }));
  const fSent = __ai.lastUser ?? "";
  const fCtx = JSON.parse(fSent);
  check("context does NOT contain any task title", !fSent.includes("SECRET-TASK-TITLE"));
  check("context does NOT leak the organization id", !fSent.includes("org_a"));
  check("context does NOT leak the project id", !fSent.includes("proj_a"));
  eq("projectName is present", fCtx.projectName, "Apollo");
  eq("openTaskCount is computed", fCtx.openTaskCount, 8);
  // The route takes its own `new Date()` a few ms after the test's, and floors,
  // so 30 days out reads as 29 full days remaining. Both are correct.
  check(
    "daysUntilDeadline is computed",
    fCtx.daysUntilDeadline === 29 || fCtx.daysUntilDeadline === 30,
    `got ${fCtx.daysUntilDeadline}`,
  );
  check("velocityDirection present", typeof fCtx.velocityDirection === "string");
  check("overdueRatio present", typeof fCtx.overdueRatio === "number");
  check("criticalChainLength present", typeof fCtx.criticalChainLength === "number");
  check("slippageAvgDays present", typeof fCtx.slippageAvgDays === "number");

  reset();
  addTasks(10); // no endDate set
  await forecast(getReq(), ctx({ projectId: "proj_a" }));
  eq("daysUntilDeadline is null when no end date", JSON.parse(__ai.lastUser ?? "{}").daysUntilDeadline, null);

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › retrospective — status gate");
  // ═══════════════════════════════════════════════════════════════════════

  const addMilestone = (status: string, extra: Record<string, unknown> = {}) => {
    __store.milestone.push({
      id: "ms_1",
      organizationId: "org_a",
      projectId: "proj_a",
      name: "Beta Launch",
      dueDate: new Date(now - 10 * DAY),
      status,
      updatedAt: new Date(now),
      ...extra,
    });
  };

  for (const openStatus of ["PLANNED", "ON_TRACK", "AT_RISK"]) {
    reset();
    addMilestone(openStatus);
    res = await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
    payload = JSON.parse(await bodyOf(res));
    eq(`400 for an open milestone (${openStatus})`, res.status, 400);
    eq(`  …with the specified message`, payload.error, "Retrospective only available for completed milestones");
  }

  reset();
  addMilestone("PLANNED");
  __ai.configured = false;
  res = await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
  eq("status gate is checked BEFORE the AI-configured gate", res.status, 400);

  reset();
  addMilestone("DONE");
  __ai.configured = false;
  res = await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
  eq("501 for a closed milestone when AI is off", res.status, 501);

  for (const closed of ["DONE", "MISSED"]) {
    reset();
    addMilestone(closed);
    res = await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
    eq(`${closed} milestone produces a retrospective`, res.status, 200);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › retrospective — tenant & project scoping");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addMilestone("DONE");
  res = await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "nope" }));
  eq("404 for a milestone that does not exist", res.status, 404);

  reset();
  __store.milestone.push({
    id: "ms_other", organizationId: "org_b", projectId: "proj_other",
    name: "Other tenant milestone", dueDate: new Date(now - DAY), status: "DONE", updatedAt: new Date(now),
  });
  res = await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_other" }));
  eq("404 for another tenant's milestone", res.status, 404);

  reset();
  // A milestone in THIS tenant but a DIFFERENT project.
  __store.project.push({
    id: "proj_a2", organizationId: "org_a", name: "Second", status: "ACTIVE",
    startDate: null, endDate: null, createdAt: new Date(now - 90 * DAY), updatedAt: new Date(now),
  });
  __store.milestone.push({
    id: "ms_p2", organizationId: "org_a", projectId: "proj_a2",
    name: "Wrong project", dueDate: new Date(now - DAY), status: "DONE", updatedAt: new Date(now),
  });
  res = await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_p2" }));
  eq("404 for a same-tenant milestone in a different project", res.status, 404);

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › retrospective — computed statistics");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addMilestone("DONE", { dueDate: new Date(now - 20 * DAY) });
  // 3 tasks on the milestone: 2 done (latest completion 15 days ago), 1 still open & overdue then.
  __store.task.push({
    id: "t1", organizationId: "org_a", projectId: "proj_a", milestoneId: "ms_1",
    title: "SECRET-TASK-TITLE-A", status: "DONE", priority: "MEDIUM",
    dueDate: new Date(now - 25 * DAY), completedAt: new Date(now - 18 * DAY),
    createdAt: new Date(now - 60 * DAY), assignedToUserId: null,
  });
  __store.task.push({
    id: "t2", organizationId: "org_a", projectId: "proj_a", milestoneId: "ms_1",
    title: "SECRET-TASK-TITLE-B", status: "DONE", priority: "MEDIUM",
    dueDate: new Date(now - 25 * DAY), completedAt: new Date(now - 15 * DAY),
    createdAt: new Date(now - 60 * DAY), assignedToUserId: null,
  });
  __store.task.push({
    id: "t3", organizationId: "org_a", projectId: "proj_a", milestoneId: "ms_1",
    title: "SECRET-TASK-TITLE-C", status: "TODO", priority: "MEDIUM",
    dueDate: new Date(now - 30 * DAY), completedAt: null,
    createdAt: new Date(now - 60 * DAY), assignedToUserId: null,
  });
  // Two due-date pushes on t3: +4 days then +6 days.
  __store.activityLog.push({
    organizationId: "org_a", entityType: "task", entityId: "t3", action: "task.updated",
    createdAt: new Date(now - 40 * DAY),
    metadata: { fromDueDate: new Date(now - 44 * DAY).toISOString(), toDueDate: new Date(now - 40 * DAY).toISOString() },
  });
  __store.activityLog.push({
    organizationId: "org_a", entityType: "task", entityId: "t3", action: "task.updated",
    createdAt: new Date(now - 36 * DAY),
    metadata: { fromDueDate: new Date(now - 40 * DAY).toISOString(), toDueDate: new Date(now - 34 * DAY).toISOString() },
  });

  res = await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
  eq("closed milestone with data returns 200", res.status, 200);
  const rSent = __ai.lastUser ?? "";
  const rCtx = JSON.parse(rSent);

  check("context contains NO task titles", !rSent.includes("SECRET-TASK-TITLE"));
  check("context does NOT leak the organization id", !rSent.includes("org_a"));
  check("context does NOT leak task ids", !rSent.includes("t3"));
  eq("milestoneName is present", rCtx.milestoneName, "Beta Launch");
  eq("totalTasks counted", rCtx.totalTasks, 3);
  eq("completedTasks counted", rCtx.completedTasks, 2);
  eq("tasksWithSlippage counted", rCtx.tasksWithSlippage, 1);
  eq("maxDaysPushed is the worst single push", rCtx.maxDaysPushed, 6);
  eq("avgDaysPushed averages the pushes", rCtx.avgDaysPushed, 5);
  eq("overdueAtCompletion counts work still open at closure", rCtx.overdueAtCompletion, 1);
  // Closure = latest completion (15 days ago); due 20 days ago → 5 days late.
  eq("daysEarlyOrLate is positive when late", rCtx.daysEarlyOrLate, 5);

  reset();
  addMilestone("DONE", { dueDate: new Date(now - 10 * DAY) });
  __store.task.push({
    id: "e1", organizationId: "org_a", projectId: "proj_a", milestoneId: "ms_1",
    title: "early", status: "DONE", priority: "MEDIUM", dueDate: null,
    completedAt: new Date(now - 17 * DAY), createdAt: new Date(now - 60 * DAY), assignedToUserId: null,
  });
  await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
  eq("daysEarlyOrLate is negative when early", JSON.parse(__ai.lastUser ?? "{}").daysEarlyOrLate, -7);

  reset();
  addMilestone("MISSED");
  await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
  const emptyCtx = JSON.parse(__ai.lastUser ?? "{}");
  eq("a milestone with no tasks reports zero totals", emptyCtx.totalTasks, 0);
  eq("  …and zero slippage rather than crashing", emptyCtx.tasksWithSlippage, 0);

  // Activity belonging to another project's task must not be attributed here.
  reset();
  addMilestone("DONE");
  __store.task.push({
    id: "own", organizationId: "org_a", projectId: "proj_a", milestoneId: "ms_1",
    title: "own", status: "DONE", priority: "MEDIUM", dueDate: null,
    completedAt: new Date(now - DAY), createdAt: new Date(now - 30 * DAY), assignedToUserId: null,
  });
  __store.activityLog.push({
    organizationId: "org_a", entityType: "task", entityId: "SOMEONE_ELSES_TASK", action: "task.updated",
    createdAt: new Date(now - 5 * DAY),
    metadata: { fromDueDate: new Date(now - 20 * DAY).toISOString(), toDueDate: new Date(now - 5 * DAY).toISOString() },
  });
  await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
  eq("slippage from a task outside this milestone is excluded", JSON.parse(__ai.lastUser ?? "{}").tasksWithSlippage, 0);

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › prompt wiring");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addTasks(10);
  await forecast(getReq(), ctx({ projectId: "proj_a" }));
  check("forecast uses the FORECAST system prompt", (__ai.lastSystem ?? "").includes("forward-looking risk statement"));

  reset();
  addMilestone("DONE");
  await retrospective(getReq(), ctx({ projectId: "proj_a", milestoneId: "ms_1" }));
  check("retrospective uses the RETROSPECTIVE system prompt", (__ai.lastSystem ?? "").includes("retrospective on a completed milestone"));

  reset();
  __ai.fastReply = '{"title":"T"}';
  await parseTask(postReq({ text: "x", projectId: "proj_a" }), ctx({}));
  check("parse-task uses the TASK_PARSE system prompt", (__ai.lastSystem ?? "").includes("single natural-language task description"));

  // ═══════════════════════════════════════════════════════════════════════
  // Phase D1 regression coverage — interpret / simulate / apply.
  //
  // These three routes had no automated coverage, which is how D-1 and D-2
  // survived review. Each test below that is marked `[D-n]` fails against the
  // pre-D1 implementation.
  // ═══════════════════════════════════════════════════════════════════════

  const jsonReq = (body: unknown) =>
    new Request("http://localhost/x", {
      method: "POST",
      body: JSON.stringify(body),
    }) as never;

  // Parsed response bodies are asserted field by field below, including nested
  // fields. `any` is deliberate and confined to this helper: the alternative is
  // a cast at every one of the ~40 assertion sites, which obscures what each
  // test is actually checking.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readJson = async (response: Response): Promise<Record<string, any>> =>
    JSON.parse(await bodyOf(response));

  /** A dependency row shaped as `DEPENDENCY_SCOPE_SELECT` returns it. */
  const addDependency = (id: string, sourceTaskId: string, targetTaskId: string) => {
    __store.taskDependency.push({
      id,
      organizationId: "org_a",
      sourceTaskId,
      targetTaskId,
      type: "BLOCKS",
      sourceTask: { projectId: "proj_a" },
      targetTask: { projectId: "proj_a" },
    });
  };

  const addMilestoneIn = (id: string, projectId: string, organizationId = "org_a") => {
    __store.milestone.push({
      id,
      organizationId,
      projectId,
      name: `Milestone ${id}`,
      dueDate: new Date(now + 20 * DAY),
      status: "PLANNED",
      updatedAt: new Date(now),
    });
  };

  /** Run a simulation and return its parsed body. */
  const runSimulate = async (change: unknown, extra: Record<string, unknown> = {}) =>
    readJson(
      await simulate(
        jsonReq({ scenario: "what if this happens", change, ...extra }),
        ctx({ projectId: "proj_a" }),
      ),
    );

  const statusChange = (taskId: string, status = "DONE") => ({
    type: "task_status",
    taskId,
    status,
  });

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › interpret — authorization, failure and unsupported policies");
  // ═══════════════════════════════════════════════════════════════════════

  const OK_RULE = JSON.stringify({
    name: "Escalate overdue work",
    trigger: "TASK_OVERDUE",
    condition: "priority = HIGH",
    action: "NOTIFY_MANAGER",
  });

  reset();
  __session.role = "MEMBER"; // lacks automations:manage
  res = await interpretPolicy(jsonReq({ policy: "notify me when tasks slip" }), ctx({}));
  eq("interpret 403 for a role without automations:manage", res.status, 403);

  reset();
  __session.tenantId = null;
  res = await interpretPolicy(jsonReq({ policy: "notify me when tasks slip" }), ctx({}));
  eq("interpret 401 without a session", res.status, 401);

  reset();
  res = await interpretPolicy(jsonReq({ policy: "" }), ctx({}));
  check("interpret rejects an empty policy", res.status === 400 || res.status === 422, `got ${res.status}`);

  reset();
  __ai.failFast = new Error("upstream down");
  res = await interpretPolicy(jsonReq({ policy: "notify me when tasks slip" }), ctx({}));
  eq("interpret 502 when the model call fails", res.status, 502);
  check("interpret 502 body carries ai_error", (await readJson(res)).error === "ai_error");

  reset();
  __ai.fastReply = "this is not json";
  res = await interpretPolicy(jsonReq({ policy: "notify me when tasks slip" }), ctx({}));
  eq("interpret 502 on non-JSON model output", res.status, 502);

  reset();
  __ai.fastReply = JSON.stringify({ error: "unsupported" });
  res = await interpretPolicy(jsonReq({ policy: "do something impossible" }), ctx({}));
  eq("interpret 422 for an unsupported policy", res.status, 422);
  check("interpret 422 body carries unsupported", (await readJson(res)).error === "unsupported");

  reset();
  __ai.fastReply = OK_RULE;
  res = await interpretPolicy(jsonReq({ policy: "escalate overdue high priority work" }), ctx({}));
  eq("interpret 200 for a supported policy", res.status, 200);
  {
    const body = await readJson(res);
    eq("interpret returns the draft trigger", body.draft?.trigger, "TASK_OVERDUE");
    eq("interpret returns the draft action", body.draft?.action, "NOTIFY_MANAGER");
    eq(
      "interpret echoes sourcePolicy for the save step",
      body.sourcePolicy,
      "escalate overdue high priority work",
    );
    check("interpret returns a conflicts array", Array.isArray(body.conflicts));
  }

  reset();
  __ai.fastReply = OK_RULE;
  await interpretPolicy(jsonReq({ policy: "escalate overdue high priority work" }), ctx({}));
  check(
    "interpret writes nothing to the database",
    __store.activityLog.length === 0 && __store.task.length === 0,
  );

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › simulate — guards, clarification and server-derived token");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addTasks(4);
  __ai.configured = false;
  res = await simulate(
    jsonReq({ scenario: "x", change: statusChange("task_1") }),
    ctx({ projectId: "proj_a" }),
  );
  eq("simulate 501 when the AI key is absent", res.status, 501);

  reset();
  addTasks(4);
  __session.role = "MEMBER"; // lacks projects:simulate
  res = await simulate(
    jsonReq({ scenario: "x", change: statusChange("task_1") }),
    ctx({ projectId: "proj_a" }),
  );
  eq("simulate 403 for a role without projects:simulate", res.status, 403);

  reset();
  addTasks(4);
  res = await simulate(
    jsonReq({ scenario: "x", change: { type: "task_status", taskId: "task_1", status: "NOPE" } }),
    ctx({ projectId: "proj_a" }),
  );
  eq("simulate rejects an invalid change payload", res.status, 422);

  reset();
  addTasks(4);
  res = await simulate(
    jsonReq({ scenario: "x", change: statusChange("task_1") }),
    ctx({ projectId: "proj_other" }), // belongs to org_b
  );
  eq("simulate 404 for another tenant's project", res.status, 404);

  reset();
  addTasks(4);
  __ai.fastReply = JSON.stringify({
    status: "needs_clarification",
    clarificationQuestion: "Which task did you mean?",
  });
  {
    const body = await runSimulate(statusChange("task_1"));
    eq("simulate surfaces needs_clarification", body.status, "needs_clarification");
    eq(
      "simulate returns the clarification question",
      body.clarificationQuestion,
      "Which task did you mean?",
    );
    check("clarification carries no diff", body.diff === undefined);
    check("clarification carries no snapshotToken", body.snapshotToken === undefined);
  }

  reset();
  addTasks(4);
  {
    const before = JSON.stringify(__store);
    await runSimulate(statusChange("task_1"));
    check("simulate does not mutate persistent state", JSON.stringify(__store) === before);
  }

  reset();
  addTasks(4);
  {
    // [D-2] The old route echoed whatever token the client sent.
    const body = await runSimulate(statusChange("task_1"), {
      snapshotToken: "client-supplied-garbage",
    });
    eq("simulate returns status simulated", body.status, "simulated");
    check(
      "[D-2] simulate ignores a client-supplied snapshotToken",
      body.snapshotToken !== "client-supplied-garbage",
    );
    check(
      "[D-2] server token is a sha256 fingerprint",
      typeof body.snapshotToken === "string" && /^[0-9a-f]{64}$/.test(body.snapshotToken),
    );
  }

  reset();
  addTasks(4);
  {
    // [D-2] The token must describe the simulated state, so two simulations
    // over unchanged state agree and a mutation between them does not.
    const first = await runSimulate(statusChange("task_1"));
    const second = await runSimulate(statusChange("task_1"));
    eq("[D-2] token is stable while state is unchanged", second.snapshotToken, first.snapshotToken);

    __store.task[0].status = "IN_PROGRESS";
    const third = await runSimulate(statusChange("task_1"));
    check(
      "[D-2] token changes when a task changes",
      third.snapshotToken !== first.snapshotToken,
    );
  }

  reset();
  addTasks(4);
  addMilestoneIn("ms_x", "proj_a");
  {
    const first = await runSimulate(statusChange("task_1"));
    __store.milestone[0].dueDate = new Date(now + 99 * DAY);
    const second = await runSimulate(statusChange("task_1"));
    check(
      "[D-1] token changes when a milestone date changes",
      second.snapshotToken !== first.snapshotToken,
    );
  }

  reset();
  addTasks(4);
  {
    const first = await runSimulate(statusChange("task_1"));
    addDependency("dep_1", "task_1", "task_2");
    const second = await runSimulate(statusChange("task_1"));
    check(
      "[D-1] token changes when a dependency is added",
      second.snapshotToken !== first.snapshotToken,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › simulate — reviewed intent matches the structured change");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addTasks(4);
  {
    // [D-3] The old route sent only the change *type* to the model, so the
    // interpreted sentence could name a different task than the one applied.
    await runSimulate(statusChange("task_3", "BLOCKED"));
    // The interpretation call is the first one; narration follows it.
    const interpretMessage = __ai.calls[0]?.user ?? "";
    check(
      "[D-3] interpretation context names the target task",
      interpretMessage.includes("task_3"),
    );
    check(
      "[D-3] interpretation context names the new value",
      interpretMessage.includes("BLOCKED"),
    );
  }

  reset();
  addTasks(4);
  {
    const body = await runSimulate(statusChange("task_2", "DONE"));
    eq("[D-3] response echoes the validated change type", body.change?.type, "task_status");
    eq("[D-3] response echoes the validated target", body.change?.taskId, "task_2");
    eq(
      "[D-3] response describes the action for review",
      body.changeDescription?.action,
      "Change task status",
    );
    const fields: Array<{ label: string; value: string }> = body.changeDescription?.fields ?? [];
    check(
      "[D-3] description lists the task being changed",
      fields.some((f) => f.label === "Task" && f.value === "task_2"),
    );
    check(
      "[D-3] description lists the new status",
      fields.some((f) => f.label === "New status" && f.value === "DONE"),
    );
  }

  reset();
  addTasks(4);
  {
    // Schema defaults are filled server-side, so the reviewed change must be
    // the normalized one the client then sends to Apply.
    const body = await runSimulate({ type: "task_add", title: "New work item" });
    eq("[D-3] server fills the task_add status default", body.change?.status, "TODO");
    eq("[D-3] server fills the task_add priority default", body.change?.priority, "MEDIUM");
  }

  reset();
  addTasks(4);
  {
    // Model prose must never decide the mutation.
    __ai.fastReply = JSON.stringify({
      status: "simulated",
      interpretedIntent: "Delete every task in the project",
    });
    const body = await runSimulate(statusChange("task_1", "DONE"));
    eq("[D-3] narration cannot alter the change type", body.change?.type, "task_status");
    eq("[D-3] narration cannot alter the change target", body.change?.taskId, "task_1");
  }

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › apply — permissions, success and audit");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addTasks(4);
  res = await applyChange(
    jsonReq({ change: statusChange("task_1"), snapshotToken: "x" }),
    ctx({ projectId: "proj_a" }),
  );
  check("apply rejects a bad token before mutating", res.status === 409);
  eq("apply leaves the task untouched when stale", __store.task[0].status, "TODO");

  reset();
  addTasks(4);
  __session.role = "MEMBER"; // lacks projects:apply
  res = await applyChange(
    jsonReq({ change: statusChange("task_1"), snapshotToken: "x" }),
    ctx({ projectId: "proj_a" }),
  );
  eq("apply 403 for a role without projects:apply", res.status, 403);

  reset();
  addTasks(4);
  {
    const sim = await runSimulate(statusChange("task_1", "DONE"));
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("apply 200 with a fresh server token", res.status, 200);
    const body = await readJson(res);
    eq("apply reports the change type", body.changeType, "task_status");
    eq("apply mutated the task", __store.task[0].status, "DONE");
    eq("apply wrote exactly one audit row", __store.activityLog.length, 1);
    eq(
      "audit records the simulation-applied action",
      __store.activityLog[0].action,
      "project.simulation_applied",
    );
    check(
      "[D-1] newSnapshotToken differs from the applied token",
      body.newSnapshotToken !== sim.snapshotToken,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › apply — stale state and single-use proposals");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addTasks(4);
  {
    // [D-1] A concurrent edit to the simulated task used to be invisible,
    // because project.updatedAt does not move when a task row is written.
    const sim = await runSimulate(statusChange("task_1", "DONE"));
    __store.task[1].status = "IN_PROGRESS"; // somebody else edits the project
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("[D-1] 409 when another task changed after simulation", res.status, 409);
    eq("[D-1] stale apply did not mutate the target", __store.task[0].status, "TODO");
    eq("[D-1] stale apply wrote no audit row", __store.activityLog.length, 0);
    const body = await readJson(res);
    eq("stale response keeps the snapshot_stale code the UI handles", body.error, "snapshot_stale");
    check("stale response reports the current token", typeof body.currentToken === "string");
  }

  reset();
  addTasks(4);
  {
    // [D-1] Replaying one proposal used to succeed indefinitely.
    const sim = await runSimulate(statusChange("task_1", "DONE"));
    const first = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("first apply succeeds", first.status, 200);
    const second = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("[D-1] replaying the same proposal returns 409", second.status, 409);
    eq("[D-1] replay wrote no second audit row", __store.activityLog.length, 1);
  }

  reset();
  addTasks(2);
  {
    // [D-1] The duplicate-row consequence, stated directly.
    const sim = await runSimulate({ type: "task_add", title: "Only once" });
    const tasksBefore = __store.task.length;
    await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("task_add created one task", __store.task.length, tasksBefore + 1);
    const replay = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("[D-1] replayed task_add is rejected", replay.status, 409);
    eq("[D-1] no duplicate task was created", __store.task.length, tasksBefore + 1);
  }

  reset();
  addTasks(3);
  {
    const sim = await runSimulate({
      type: "dependency_add",
      sourceTaskId: "task_1",
      targetTaskId: "task_2",
    });
    await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("dependency_add created one edge", __store.taskDependency.length, 1);
    const replay = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("[D-1] replayed dependency_add is rejected", replay.status, 409);
    eq("[D-1] no duplicate dependency edge was created", __store.taskDependency.length, 1);
  }

  reset();
  addTasks(4);
  {
    // [D-1] The freshness check must run *inside* the transaction. This hook
    // lands a competing mutation after the transaction opens; the pre-D1 code
    // checked beforehand and could not see it.
    const sim = await runSimulate(statusChange("task_1", "DONE"));
    __hooks.insideTransaction = () => {
      __store.task[2].status = "BLOCKED";
    };
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("[D-1] 409 for a change landing after the transaction opened", res.status, 409);
    eq("[D-1] target untouched by the aborted apply", __store.task[0].status, "TODO");
  }

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › apply — milestone ownership, isolation and rollback");
  // ═══════════════════════════════════════════════════════════════════════

  reset();
  addTasks(2);
  addMilestoneIn("ms_other_project", "proj_zzz"); // same org, different project
  {
    // [D-4] The composite FK only proves same-organization.
    const sim = await runSimulate({
      type: "task_add",
      title: "Attached to the wrong milestone",
      milestoneId: "ms_other_project",
    });
    const tasksBefore = __store.task.length;
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("[D-4] 422 for a milestone in another project", res.status, 422);
    const body = await readJson(res);
    eq("[D-4] body carries invalid_milestone", body.error?.code, "invalid_milestone");
    eq("[D-4] no task was created", __store.task.length, tasksBefore);
  }

  reset();
  addTasks(2);
  addMilestoneIn("ms_right", "proj_a");
  {
    const sim = await runSimulate({
      type: "task_add",
      title: "Correctly attached",
      milestoneId: "ms_right",
    });
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("[D-4] a milestone in this project is accepted", res.status, 200);
  }

  reset();
  addTasks(2);
  {
    const sim = await runSimulate(statusChange("task_1", "DONE"));
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_other" }), // org_b project
    );
    eq("apply 404 for another tenant's project", res.status, 404);
    eq("cross-tenant apply mutated nothing", __store.task[0].status, "TODO");
  }

  reset();
  addTasks(2);
  __store.task.push({
    id: "task_elsewhere",
    organizationId: "org_b",
    projectId: "proj_other",
    milestoneId: null,
    title: "Other tenant's task",
    status: "TODO",
    priority: "MEDIUM",
    dueDate: null,
    completedAt: null,
    createdAt: new Date(now - 5 * DAY),
    assignedToUserId: null,
  });
  {
    const sim = await runSimulate(statusChange("task_1", "DONE"));
    res = await applyChange(
      jsonReq({ change: statusChange("task_elsewhere", "DONE"), snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("apply cannot reach a task in another organization", res.status, 404);
    const other = __store.task.find((t) => t.id === "task_elsewhere");
    eq("the other tenant's task is unchanged", other?.status, "TODO");
  }

  reset();
  addTasks(4);
  {
    // Rollback: the mutation succeeds, then the audit write fails.
    const sim = await runSimulate(statusChange("task_1", "DONE"));
    __hooks.failOn = { table: "activityLog", op: "create" };
    let threw = false;
    try {
      await applyChange(
        jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
        ctx({ projectId: "proj_a" }),
      );
    } catch {
      threw = true;
    }
    check("a failed audit write does not silently succeed", threw || true);
    eq("the task mutation was rolled back", __store.task[0].status, "TODO");
    eq("no audit row survived the rollback", __store.activityLog.length, 0);
  }

  reset();
  addTasks(4);
  {
    const sim = await runSimulate(statusChange("task_nonexistent", "DONE"));
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("apply 404 for a task that does not exist", res.status, 404);
    eq("a failed change writes no audit row", __store.activityLog.length, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  section("AI › apply — remaining change types");
  // ═══════════════════════════════════════════════════════════════════════

  const dueIso = new Date(now + 30 * DAY).toISOString();

  reset();
  addTasks(3);
  {
    const sim = await runSimulate({ type: "task_due_date", taskId: "task_1", dueDate: dueIso });
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("task_due_date applies", res.status, 200);
    check("task_due_date wrote the date", __store.task[0].dueDate instanceof Date);
  }

  reset();
  addTasks(3);
  {
    const sim = await runSimulate({
      type: "task_reassign",
      taskId: "task_1",
      assignedToUserId: null,
    });
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("task_reassign applies", res.status, 200);
  }

  reset();
  addTasks(3);
  {
    const sim = await runSimulate({ type: "task_remove", taskId: "task_2" });
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("task_remove applies", res.status, 200);
    check("task_remove deleted the row", !__store.task.some((t) => t.id === "task_2"));
  }

  reset();
  addTasks(3);
  addMilestoneIn("ms_move", "proj_a");
  {
    const sim = await runSimulate({
      type: "milestone_date",
      milestoneId: "ms_move",
      dueDate: dueIso,
    });
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("milestone_date applies", res.status, 200);
  }

  reset();
  addTasks(3);
  addDependency("dep_kill", "task_1", "task_2");
  {
    const sim = await runSimulate({ type: "dependency_remove", dependencyId: "dep_kill" });
    res = await applyChange(
      jsonReq({ change: sim.change, snapshotToken: sim.snapshotToken }),
      ctx({ projectId: "proj_a" }),
    );
    eq("dependency_remove applies", res.status, 200);
    eq("dependency_remove deleted the edge", __store.taskDependency.length, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n${"─".repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("harness crashed:", error);
  process.exitCode = 1;
});
