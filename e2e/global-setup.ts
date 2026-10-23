import fs from "node:fs";
import { request, type FullConfig } from "@playwright/test";

import { ACCOUNTS, ROLE_STORAGE_DIR, storageStatePath, type RoleName } from "./fixtures";

/**
 * Authenticate each seeded role through the REAL login endpoint and persist a
 * storageState per role. This uses the login API; it does not inspect or modify
 * signup/login code. If the server is unreachable or the demo users are not
 * seeded, this throws so the run fails loudly rather than reporting false
 * passes.
 *
 * A fresh request context per role keeps each role's cookies isolated.
 */
async function globalSetup(config: FullConfig) {
  const baseURL =
    config.projects[0]?.use?.baseURL ?? process.env.PW_BASE_URL ?? "http://127.0.0.1:3123";

  fs.mkdirSync(ROLE_STORAGE_DIR, { recursive: true });

  for (const role of Object.keys(ACCOUNTS) as RoleName[]) {
    const { email, password } = ACCOUNTS[role];
    const ctx = await request.newContext({ baseURL });
    try {
      const res = await ctx.post("/api/v1/auth/login", { data: { email, password } });
      if (!res.ok()) {
        throw new Error(
          `login failed for ${role} (${email}): HTTP ${res.status()}. ` +
            `Ensure the dev server is running and the disposable DB is seeded (npm run db:seed).`,
        );
      }
      const state = await ctx.storageState();
      if (!state.cookies.some((c) => c.name === "pm_session")) {
        throw new Error(`login for ${role} returned no pm_session cookie`);
      }
      fs.writeFileSync(storageStatePath(role), JSON.stringify(state, null, 2));
    } finally {
      await ctx.dispose();
    }
  }
}

export default globalSetup;
