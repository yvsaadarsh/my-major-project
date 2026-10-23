import { test, expect } from "@playwright/test";

import { apiFetch, storageStatePath } from "./fixtures";

/**
 * Flow 1 — Policy Studio: a newly created rule is saved DISABLED, and explicit
 * activation flips it to enabled (D-8 end-to-end through the UI).
 *
 * The runnable path is the MANUAL create form, which needs no AI. The
 * AI-interpret variant of this flow (Interpret → draft → Save) is covered by a
 * separate test that marks itself BLOCKED when the deployment has no AI key,
 * since the interpret endpoint returns 501 without one.
 */
test.use({ storageState: storageStatePath("ADMIN") });

/** Innermost rule-card div that contains both the name and a toggle button. */
function ruleCard(page: import("@playwright/test").Page, name: string) {
  return page
    .locator("div")
    .filter({ hasText: name })
    .filter({ has: page.getByRole("button", { name: /^(Enabled|Disabled)$/ }) })
    .last();
}

test("manual rule is created disabled, then explicitly activated", async ({ page }) => {
  const name = `E2E manual ${Date.now()}`;

  await page.goto("/automations");
  await expect(page.getByRole("heading", { name: "New rule" })).toBeVisible();

  // Fill the manual form, leaving "Enable immediately" UNCHECKED.
  await page.getByPlaceholder("Advance milestone on completion").fill(name);
  const enableToggle = page.getByText("Enable immediately");
  await expect(enableToggle).toBeVisible();
  // The checkbox defaults off (D-8); assert we are not enabling it.
  await page.getByRole("button", { name: "Create rule" }).click();

  // The new rule appears with a DISABLED toggle.
  const card = ruleCard(page, name);
  await expect(card).toBeVisible();
  const toggle = card.getByRole("button", { name: /^(Enabled|Disabled)$/ });
  await expect(toggle).toHaveText("Disabled");

  // Explicit activation flips it to enabled.
  await toggle.click();
  await expect(toggle).toHaveText("Enabled");
});

test("AI-interpret save path saves a disabled draft [needs AI key]", async ({ page }) => {
  await page.goto("/automations");
  // Probe the interpret endpoint; without an AI key it returns 501.
  const probe = await apiFetch(page, "POST", "/api/v1/automations/interpret", {
    policy: "When a high priority task becomes overdue, notify the manager",
  });

  test.skip(
    probe.status === 501,
    "BLOCKED: AI not configured (interpret returned 501). Requires a development ANTHROPIC_API_KEY.",
  );

  // With a key present, exercise the real Interpret → Save path and assert the
  // saved rule is disabled.
  await page
    .getByPlaceholder(/When a task becomes overdue/i)
    .fill("When a high priority task becomes overdue, notify the manager");
  await page.getByRole("button", { name: "Interpret policy" }).click();
  await page.getByRole("button", { name: /^Save (rule|anyway)$/ }).click();
  await expect(page.getByText(/saved as a disabled draft/i)).toBeVisible();
});
