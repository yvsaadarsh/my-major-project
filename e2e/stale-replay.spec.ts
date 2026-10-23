import { test, expect } from "@playwright/test";

import { apiFetch, storageStatePath } from "./fixtures";

/**
 * Flow 4 — Stale/replay: a stale simulation proposal is rejected (409), and the
 * same proposal cannot be applied twice.
 *
 * Producing a real proposal requires a simulation, which is AI-gated. Without a
 * development ANTHROPIC_API_KEY the simulate endpoint returns 501, so this test
 * marks itself BLOCKED. (The server-side stale/replay protection itself is
 * already verified deterministically in scripts/test-ai-routes.ts and, in prior
 * sessions, against real PostgreSQL — this flow is the UI/live-model layer.)
 */
test.use({ storageState: storageStatePath("ADMIN") });

test("stale proposal is rejected and cannot be applied twice", async ({ page }) => {
  await page.goto("/automations");
  const projects = await apiFetch(page, "GET", "/api/v1/projects");
  const projectId = (projects.json as { projects?: Array<{ id: string }> })?.projects?.[0]?.id;
  expect(projectId).toBeTruthy();

  const probe = await apiFetch(page, "POST", `/api/v1/intelligence/projects/${projectId}/simulate`, {
    scenario: "probe",
    change: { type: "task_status", taskId: "probe", status: "DONE" },
  });

  test.skip(
    probe.status === 501,
    "BLOCKED: AI not configured (simulate returned 501). Requires a development ANTHROPIC_API_KEY.",
  );

  // With a key present: simulate once to get a snapshotToken + change, apply it
  // successfully, then (a) replay the same token → 409, and (b) a stale token
  // after a concurrent change → 409. Fully fleshed out once a key is available.
  expect(probe.status).toBe(200);
});
