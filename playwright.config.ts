import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config for ProjectOS (Phase F).
 *
 * Browser: this environment ships a pre-installed Chromium at
 * `/opt/pw-browsers/chromium` and blocks Playwright's own browser download, so
 * `executablePath` is pinned to it rather than relying on a version-matched
 * managed browser. Override with PW_CHROMIUM if the path differs.
 *
 * Server + database: the suite runs against a dev server on PW_BASE_URL
 * (default http://127.0.0.1:3123) backed by the DISPOSABLE local database —
 * never production. The server is started separately (it needs the seeded
 * database and the dev-only env); `reuseExistingServer` means an already-running
 * dev server is reused as-is.
 *
 * Auth: `e2e/global-setup.ts` logs in the seeded demo users through the real
 * login endpoint and writes one storageState per role. The specs load those
 * states; no test touches the signup/login UI or code.
 */
const BASE_URL = process.env.PW_BASE_URL ?? "http://127.0.0.1:3123";
const CHROMIUM = process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // Fail fast and never silently pass: no retries, serial, short timeouts so a
  // missing server/DB surfaces as an error rather than a hang.
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    launchOptions: { executablePath: CHROMIUM },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: CHROMIUM } },
    },
  ],
  webServer: {
    // E2E runs against a PRODUCTION server (`next start`), not `next dev`:
    // the dev server's HMR websocket does not complete in headless Chromium
    // here, which blocks client hydration so pages never leave their
    // "Loading workspace" fallback. A production build hydrates normally.
    //
    // Run `npm run build` first (it needs a generated Prisma client). The
    // server still requires DATABASE_URL pointing at the DISPOSABLE database.
    // An already-running server on this URL is reused as-is.
    command: "npx next start --port 3123",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
