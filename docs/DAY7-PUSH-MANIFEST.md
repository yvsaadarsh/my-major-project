# Day 7 — what to put on GitHub

Committed locally as `226bae6` ("Day 7: authentication hardening"). I could not
push it: this environment has no GitHub credentials and the network proxy blocks
`github.com` outright. So the files are on your disk and need to go up through
github.dev the way you have been doing it.

## Read this first — do not `git push` or `git push --force`

Your local git repo is **behind GitHub**. The last local commit before mine was
`fe991db`, but the Day 3–6 work (search, command palette, `/shortcuts`,
analytics) is *untracked locally* while being live on the deployed site — which
means you committed it through github.dev, not from this folder.

So local `main` and GitHub `main` have now **diverged**. Consequences:

- A plain `git push` will be **rejected** (non-fast-forward). That is git
  protecting you.
- A `git push --force` would **delete your Day 3–6 commits from GitHub**. Do not
  run it.

Use github.dev for this, as below. Once everything is up, the cleanest fix for
the divergence is to delete this folder's `.git` and re-clone from GitHub, so
local and remote share one history again.

Also: `.git/index.lock` is a stale empty lock file from 11 Aug that I could not
delete (the sandbox can create files inside `.git` but not remove them). If you
ever use git locally, delete `C:\...\multi-model\.git\index.lock` in File
Explorer first or every git command will refuse to run.

## Commit all 23 files in ONE github.dev commit

**Important:** stage everything and commit once. If you commit file-by-file,
every intermediate commit triggers a Vercel build that will fail — the new
routes import `src/lib/domain/auth-policy.ts`, and `prisma/schema.prisma` needs
its migration in the same commit.

### New files — create these (12)

| File | Lines |
| --- | --- |
| `src/lib/domain/auth-policy.ts` | 512 |
| `src/lib/auth/login-guard.ts` | 200 |
| `src/lib/security/headers.ts` | 138 |
| `src/middleware.ts` | 44 |
| `src/app/api/v1/auth/password/route.ts` | 116 |
| `prisma/migrations/20260815090000_auth_hardening/migration.sql` | 63 |
| `scripts/test-auth-policy.ts` | 383 |
| `scripts/test-security-headers.ts` | 226 |
| `docs/SECURITY.md` | 232 |
| `docs/ROADMAP.md` | 322 |
| `docs/ARCHITECTURE.md` | 130 |
| `docs/LIVE-TEST-REPORT.md` | 75 |

The four `docs/` files show as "new" because the docs folder was never committed
either. If a file already exists on GitHub, just replace its contents.

### Modified files — replace contents (11)

| File | Lines | What changed |
| --- | --- | --- |
| `prisma/schema.prisma` | 504 | Six new `User` columns, `LoginOutcome` enum, `LoginAttempt` model |
| `src/app/page.tsx` | 382 | Empty fields (no more demo prefill), strength meter, lockout countdown |
| `src/app/api/v1/auth/login/route.ts` | 179 | Lockout, constant-time compare, attempt log |
| `src/app/api/v1/auth/register/route.ts` | 95 | Password policy enforced |
| `src/app/api/v1/auth/logout/route.ts` | 57 | `?everywhere=1` revokes all sessions |
| `src/lib/auth/session.ts` | 105 | `sessionEpoch` claim + `clearedSessionCookieOptions` |
| `src/lib/auth/context.ts` | 156 | Rejects tokens behind the user's epoch |
| `src/lib/validators.ts` | 228 | `passwordChangeSchema`, bounds from the policy layer |
| `src/lib/api/http.ts` | 160 | `ApiError` can carry response headers (`Retry-After`) |
| `src/lib/ui/api-client.ts` | 303 | `ClientApiError` carries `details` |
| `package.json` | 50 | Adds `npm run test:domain` |

## After the commit

1. **Watch the Vercel build.** `prisma migrate deploy` runs during it and will
   apply `20260815090000_auth_hardening` to Neon. The migration is idempotent
   (`IF NOT EXISTS` throughout) so a retry is safe.
2. **The migration needs no backfill.** Every new column has a default or is
   nullable, and `session_epoch` starts at 0 while old tokens read as epoch 0 —
   so nobody currently signed in gets kicked out by the deploy.
3. **Verify on the live site:**
   - Register with `password` → rejected, meter explains why.
   - Register with `Bluetiger42!wax` → accepted, meter reads "excellent".
   - Sign in with a wrong password 5 times → `423` and a ticking countdown.
   - DevTools → Network → any document request → confirm
     `content-security-policy` and `strict-transport-security` response headers.
4. **Nothing to configure.** No new environment variables. `SESSION_SECRET` is
   reused as the salt for hashing IPs in the attempt log, and it was already
   required.

## Known gap worth scheduling next

There is **no password reset flow**. Combined with the new lockout, a user who
forgets their password has no recovery path at all — they can only wait out the
lock and keep guessing. That is now the highest-value next piece of auth work,
ahead of MFA.
