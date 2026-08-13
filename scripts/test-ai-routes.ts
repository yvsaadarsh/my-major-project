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

import { __store, prisma as _prisma } from "@/lib/db";
import { __session } from "@/lib/auth/context";
import { __ai } from "@/lib/ai";

import { POST as parseTask } from "@/app/api/v1/ai/parse-task/route";
import { GET as forecast } from "@/app/api/v1/intelligence/projects/[projectId]/forecast/route";
import { GET as retrospective } from "@/app/api/v1/projects/[projectId]/milestones/[milestoneId]/retrospective/route";

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

  __session.tenantId = "org_a";
  __session.role = "ADMIN";

  __ai.configured = true;
  __ai.fastReply = "{}";
  __ai.streamChunks = ["chunk-1 ", "chunk-2"];
  __ai.failFast = null;
  __ai.failStreamAt = null;
  __ai.lastSystem = null;
  __ai.lastUser = null;
  __ai.cancelled = false;

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
