import { test, expect } from "@playwright/test";

import { apiFetch, storageStatePath } from "./fixtures";

/**
 * Flow 3 — What-If Simulation: review the structured change, apply it, and
 * verify the resulting project state.
 *
 * The UI simulate button calls the AI-gated simulate endpoint, which returns
 * 501 without a development ANTHROPIC_API_KEY. When no key is configured this
 * test marks itself BLOCKED rather than passing, because the review→apply path
 * cannot be exercised through the UI without a model-produced result.
 */
test.use({ storageState: storageStatePath("ADMIN") });

test("simulate → review structured change → apply → verify state", async ({ page }) => {
  await page.goto("/automations"); // any app-origin page to establish fetch origin
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

  // With a key present: drive the workspace. Selectors are intentionally
  // generic because the simulation UI has no test ids; refine once a key is
  // available and the rendered structure can be observed.
  await page.goto(`/intelligence/${projectId}`);
  await page.getByPlaceholder(/scenario|what if/i).first().fill("Mark the first task as done");
  await page.getByRole("button", { name: /simulate|run simulation/i }).first().click();
  await expect(page.getByText(/Change to apply/i)).toBeVisible();
  await page.getByRole("button", { name: /^Apply change$/ }).click();
  await expect(page.getByText(/applied|updated/i)).toBeVisible();
});
