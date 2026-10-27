import { test, expect } from "@playwright/test";
import { apiFetch, storageStatePath } from "./fixtures";

test.use({ storageState: storageStatePath("ADMIN") });

test("data pages hydrate, refresh, and preserve project view preferences", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const path of [
    "/dashboard",
    "/projects",
    "/progress",
    "/shortcuts",
    "/tasks/latest",
    "/automations",
    "/analytics",
    "/intelligence",
    "/work-os",
    "/notifications",
    "/members",
  ]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await expect(
      page.getByText("Loading workspace", { exact: false }),
    ).toHaveCount(0);
  }
  await page.goto("/projects?new=task&title=Review%20handoff");
  await expect(page.getByRole("textbox", { name: "Task title" })).toHaveValue(
    "Review handoff",
  );
  await page.getByRole("button", { name: "Table", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Table", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.goto("/search?q=launch");
  await expect(page.locator("input").first()).toHaveValue("launch");
  await page.locator("input").first().fill("zzzz-unmatched-review");
  await expect(
    page.getByText(/No results|Nothing matched/i).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("project/task writes and cross-tenant reads use the real database", async ({
  page,
  browser,
}) => {
  await page.goto("/projects");
  const projectResponse = await apiFetch(page, "POST", "/api/v1/projects", {
    name: `Review ${Date.now()}`,
    description: "Disposable E2E project",
  });
  expect(projectResponse.status).toBe(201);
  const projectId = (projectResponse.json as { project: { id: string } })
    .project.id;
  const taskResponse = await apiFetch(
    page,
    "POST",
    `/api/v1/projects/${projectId}/tasks`,
    { title: "Review regression task", status: "TODO", priority: "HIGH" },
  );
  expect(taskResponse.status).toBe(201);
  const taskId = (taskResponse.json as { task: { id: string } }).task.id;
  expect(
    (
      await apiFetch(page, "PATCH", `/api/v1/tasks/${taskId}`, {
        status: "DONE",
      })
    ).status,
  ).toBe(200);
  const task = await apiFetch(page, "GET", `/api/v1/tasks/${taskId}`);
  expect((task.json as { task: { status: string } }).task.status).toBe("DONE");
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const outsider = await context.newPage();
  try {
    await outsider.goto("/");
    expect((await apiFetch(outsider, "GET", "/api/v1/projects")).status).toBe(
      401,
    );
    const registered = await apiFetch(
      outsider,
      "POST",
      "/api/v1/auth/register",
      {
        name: "Review Visitor",
        email: `review-${Date.now()}@example.test`,
        password: "Cobalt!River7Lantern",
      },
    );
    expect(registered.status).toBe(200);
    expect(
      (
        await apiFetch(outsider, "POST", "/api/v1/organizations", {
          name: `Other tenant ${Date.now()}`,
        })
      ).status,
    ).toBe(201);
    const own = await apiFetch(outsider, "GET", "/api/v1/projects");
    expect((own.json as { projects: unknown[] }).projects).toEqual([]);
    expect(
      (await apiFetch(outsider, "GET", `/api/v1/tasks/${taskId}`)).status,
    ).toBe(404);
    expect(
      (
        await apiFetch(outsider, "PATCH", `/api/v1/tasks/${taskId}`, {
          status: "TODO",
        })
      ).status,
    ).toBe(404);
    const unchanged = await apiFetch(page, "GET", `/api/v1/tasks/${taskId}`);
    expect((unchanged.json as { task: { status: string } }).task.status).toBe(
      "DONE",
    );
  } finally {
    await context.close();
  }
});
