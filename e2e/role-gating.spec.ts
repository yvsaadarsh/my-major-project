import { test, expect } from "@playwright/test";

import { apiFetch, storageStatePath } from "./fixtures";

/**
 * Flow 2 — Role gating: a MEMBER cannot perform policy-management actions,
 * verified both in the UI (controls absent/disabled) and at the API (403).
 *
 * API assertions go through the page's in-document fetch (see apiFetch) so the
 * Secure session cookie is sent exactly as the real client sends it.
 */
test.describe("MEMBER cannot manage policies", () => {
  test.use({ storageState: storageStatePath("MEMBER") });

  test("policy-management controls are not offered in the UI", async ({ page }) => {
    await page.goto("/automations");
    // The page renders for a MEMBER (read access); the management surfaces are
    // gated on `canManage`. Wait for a known read-only element so this is not a
    // vacuous pass on a still-loading page.
    await expect(page.getByText("Enabled rules run automatically on matching events.")).toBeVisible();

    await expect(page.getByRole("heading", { name: "Policy studio" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Enabled|Disabled)$/ })).toHaveCount(0);
    const nameInput = page.getByPlaceholder("Advance milestone on completion");
    if (await nameInput.count()) {
      await expect(nameInput).toBeDisabled();
    }
  });

  test("API refuses rule creation with 403", async ({ page }) => {
    await page.goto("/automations");
    const res = await apiFetch(page, "POST", "/api/v1/automations", {
      name: "member should not create",
      trigger: "TASK_OVERDUE",
      condition: "priority = HIGH",
      action: "NOTIFY_MANAGER",
    });
    expect(res.status).toBe(403);
  });

  test("API refuses simulate and apply with 403", async ({ page }) => {
    await page.goto("/automations");
    const projects = await apiFetch(page, "GET", "/api/v1/projects");
    const projectId = (projects.json as { projects?: Array<{ id: string }> })?.projects?.[0]?.id;
    expect(projectId, "a seeded project is readable by the member").toBeTruthy();

    const sim = await apiFetch(page, "POST", `/api/v1/intelligence/projects/${projectId}/simulate`, {
      scenario: "x",
      change: { type: "task_status", taskId: "t", status: "DONE" },
    });
    expect(sim.status, "MEMBER lacks projects:simulate").toBe(403);

    const apply = await apiFetch(page, "POST", `/api/v1/intelligence/projects/${projectId}/apply`, {
      change: { type: "task_status", taskId: "t", status: "DONE" },
      snapshotToken: "x",
    });
    expect(apply.status, "MEMBER lacks projects:apply").toBe(403);
  });
});
