/**
 * Shared E2E fixtures: the seeded demo accounts and their storageState paths.
 *
 * These credentials come from `prisma/seed.ts` and exist only in the
 * disposable local database. They are NOT secrets and NOT production
 * credentials — the seed hardcodes them for the demo organization. Nothing here
 * is read from or written to a shared system.
 */
import path from "node:path";

export const ROLE_STORAGE_DIR = path.join(__dirname, ".auth");

export const ACCOUNTS = {
  ADMIN: { email: "ada@northwind.test", password: "Password123!" },
  MANAGER: { email: "grace@northwind.test", password: "Password123!" },
  MEMBER: { email: "linus@northwind.test", password: "Password123!" },
} as const;

export type RoleName = keyof typeof ACCOUNTS;

export function storageStatePath(role: RoleName): string {
  return path.join(ROLE_STORAGE_DIR, `${role.toLowerCase()}.json`);
}

/**
 * Call the API the way the real client does: through the page's in-document
 * `fetch`, so the request runs in the app origin and carries the session
 * cookie.
 *
 * Why not a standalone APIRequestContext: under `next start` the session cookie
 * is `Secure`. Chromium sends Secure cookies to 127.0.0.1 over http (a
 * trustworthy-localhost exception), but Playwright's separate request stack
 * does not, so a standalone context is treated as unauthenticated (401). The
 * page's own fetch uses the browser's origin and cookie handling, matching the
 * application exactly. The page must already be navigated to an app-origin URL.
 */
export async function apiFetch(
  page: import("@playwright/test").Page,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ method, pathname, body }) => {
      const res = await fetch(pathname, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        /* no body */
      }
      return { status: res.status, json };
    },
    { method, pathname, body },
  );
}
