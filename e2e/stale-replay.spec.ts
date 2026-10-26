import { test, expect } from "@playwright/test";

import { apiFetch, storageStatePath } from "./fixtures";

/**
 * Flow 4 — Stale/replay: the same reviewed proposal cannot be applied twice,
 * and a token that no longer matches live state is rejected with 409.
 *
 * This drives the real routes through the page's authenticated fetch. simulate
 * is AI-gated but degrades gracefully (a 200 result from the deterministic
 * engine even when the model is unavailable), so the safety-critical
 * token/stale/replay behaviour — which is entirely deterministic — is
 * verifiable here. Only a hard 501 (no key at all) blocks it.
 */
test.use({ storageState: storageStatePath("ADMIN") });

test("a reviewed proposal is single-use: second apply of the same token is rejected", async ({
  page,
}) => {
  await page.goto("/automations");
  const projects = await apiFetch(page, "GET", "/api/v1/projects");
  const projectId = (projects.json as { projects?: Array<{ id: string }> })?.projects?.[0]?.id;
  expect(projectId).toBeTruthy();

  const tasks = await apiFetch(page, "GET", `/api/v1/projects/${projectId}/tasks`);
  const taskId = ((tasks.json as { tasks?: Array<{ id: string }> })?.tasks ?? [])[0]?.id;
  expect(taskId).toBeTruthy();

  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const change = { type: "task_due_date", taskId, dueDate };

  const sim = await apiFetch(page, "POST", `/api/v1/intelligence/projects/${projectId}/simulate`, {
    scenario: "push this task's due date out a month",
    change,
  });
  test.skip(
    sim.status === 501,
    "BLOCKED: AI not configured (simulate returned 501). Requires a development GEMINI_API_KEY.",
  );
  expect(sim.status).toBe(200);
  const body = sim.json as { status: string; change: unknown; snapshotToken: string };
  expect(body.status).toBe("simulated");
  const token = body.snapshotToken;
  expect(token).toMatch(/^[0-9a-f]{64}$/);

  // First apply succeeds.
  const first = await apiFetch(page, "POST", `/api/v1/intelligence/projects/${projectId}/apply`, {
    change: body.change,
    snapshotToken: token,
  });
  expect(first.status, JSON.stringify(first.json)).toBe(200);

  // Replaying the SAME token is rejected — the apply changed the state the
  // token fingerprints, so it is now stale. 409, not a second mutation.
  const replay = await apiFetch(page, "POST", `/api/v1/intelligence/projects/${projectId}/apply`, {
    change: body.change,
    snapshotToken: token,
  });
  expect(replay.status).toBe(409);
  expect((replay.json as { error?: string })?.error).toBe("snapshot_stale");
});
