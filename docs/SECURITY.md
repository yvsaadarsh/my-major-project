# Security

How Project OS protects tenants, authenticates users, and authorizes actions —
plus the known gaps to close before production.

## Threat model

Assume hostile tenants, compromised user sessions, and malicious input. The core
guarantee is: **a member of organization A can never read or mutate data in
organization B**, through any path (API, search, dashboards, exports).

## Tenant isolation (defense in depth)

**Layer 1 — database structure.** Org-owned child rows carry `organization_id` and
reference their parents via **composite foreign keys** `(id, organization_id)`.
Postgres itself rejects a task whose `(project_id, organization_id)` pair does not
match an existing project row. Cross-tenant references are structurally impossible,
not merely discouraged.

**Layer 2 — server-derived tenant context.** `requireTenantContext()`
(`src/lib/auth/context.ts`) resolves the active organization from the **signed
session cookie**, then confirms the user has an ACTIVE membership in it. The client
cannot supply or override the organization id.

**Layer 3 — scoped queries.** Reads/writes go through helpers in
`src/lib/tenant/queries.ts` that always filter by `organizationId`, returning 404
(not 403) when a resource is absent from the caller's tenant — avoiding existence
leaks.

**Layer 4 — the guard wrapper.** `withTenantGuard(permission, handler)` ensures no
handler can accidentally skip auth, tenant resolution, or permission checks.

## Authentication

- **Sessions:** HS256 JWT signed with `SESSION_SECRET` (rejected if < 32 chars),
  stored in an HTTP-only cookie `pm_session`, `SameSite=Lax`, 7-day expiry.
- **Passwords:** bcrypt, cost 12. Never stored or logged in plaintext.
- **Registration/login:** validated with Zod; emails normalized to lowercase.

### Cookie hardening — action required

`sessionCookieOptions()` currently sets `secure: false` for local HTTP
development. **Before any HTTPS/production deployment, set `secure: true`** (ideally
gated on `NODE_ENV === "production"`). Consider also `SameSite=Strict` for the
session cookie if no cross-site flows are required.

## Authorization

- Roles: `ADMIN`, `MANAGER`, `MEMBER`.
- A single matrix in `src/lib/rbac.ts` maps each role to explicit permissions
  (e.g. `projects:create`, `tasks:assign`, `members:manage`).
- `assertPermission(role, permission)` throws `403 forbidden` when denied.
- `canManageRole` prevents privilege escalation (only ADMIN manages roles).
- `assertNotLastActiveAdmin` prevents an org from being left with no admin.
- The UI hides unpermitted actions (`src/lib/ui/permissions.ts`) but the **server
  is authoritative** — the UI check is convenience, not enforcement.

## Input handling & error hygiene

- Every mutating request body is validated by a Zod schema before use.
- `handleApiError` returns structured, safe JSON. Stack traces, SQL errors and
  internal details are never sent to clients (unknown errors → generic 500).
- Responses are `Cache-Control: no-store` to avoid caching tenant data.

## Authentication hardening (Day 7)

### Password policy

Policy lives in `src/lib/domain/auth-policy.ts` — pure, dependency-free, and
covered by 83 behavioural assertions. The same function backs the API and the
live strength meter in the UI, so the meter can never approve something the
server then rejects.

Following NIST SP 800-63B, we use a modest length floor plus screening for
guessable secrets rather than forced composition rules (one upper, one digit, one
symbol), which push users toward predictable shapes like `Password1!`.

| Rule | Value | Rationale |
| --- | --- | --- |
| Minimum length | 10 | Length is the strongest single signal |
| Maximum length | 72 | bcrypt silently truncates past 72 bytes; accepting more would let two different passwords hash identically |
| Minimum score | 2 of 4 | Scored on length and character variety |
| Rejected: common passwords | ~40 entries | Compared *after* stripping trailing years and punctuation, so `Password2024!` is caught by `password` |
| Rejected: repeats | 3+ identical in a row | `aaa` collapses the search space |
| Rejected: sequences | 4+ run | Keyboard walks and alphabet/digit runs, forwards or backwards |
| Rejected: self-reference | email local part or name token (3+ chars) | Trivially guessable from public information |
| Rejected: edge whitespace | any | Almost always a paste accident |

Sign-in deliberately does **not** apply the strength policy. Rejecting a short
password at login would confirm that no account could have it, and would lock out
users who registered under a looser rule.

### Brute-force lockout

Counters live on the `users` row, not in process memory — serverless instances
share no state, so an in-memory counter would reset on every cold start and
provide no protection whatsoever.

- 5 consecutive failures inside a 15-minute rolling window trigger a lock.
- Backoff doubles per subsequent failure: 60s → 120s → 240s … capped at 1 hour,
  so an account is never permanently bricked.
- A failure older than the window is forgotten, so a user who fumbles a password
  once a week never accumulates a lock.
- Locked requests answer `423` with a `Retry-After` header and a
  `retryAfterSeconds` body field; the UI renders a live countdown.
- A successful sign-in, or a password change, clears the state.

### Account enumeration

The sign-in path is written so that "no such email" and "wrong password" are
indistinguishable:

- identical `401 invalid_credentials` code and message for both;
- identical cost — when no user matches, bcrypt still runs once against a decoy
  hash derived at process start. Without this, unknown-email returns in ~1 ms
  against ~250 ms for a real cost-12 comparison, which is a reliable timing
  oracle for harvesting valid addresses.

Registration necessarily reveals that an address is taken (there is no way to
create a second account on it). That is accepted; the sweep an attacker would
actually run is against sign-in, which leaks nothing.

The one intentional exception is `423 account_locked`, which does confirm the
address exists. An attacker who has already triggered a lock has learned that
regardless, and hiding it would leave the real owner unable to understand why a
correct password is failing.

### Session revocation

Sessions are stateless JWTs, so they cannot be deleted server-side. Each token
carries the `sessionEpoch` it was minted under, and `requireAuthenticatedUser`
refuses any token whose epoch is behind the user's current value.

- Changing a password bumps the epoch, then re-issues a cookie for the current
  device — every *other* device is signed out, which is what users expect.
- `POST /api/v1/auth/logout?everywhere=1` bumps the epoch without re-issuing.
- Tokens minted before this feature existed have no epoch claim and are treated
  as epoch 0, so shipping it did not sign the existing user base out.

Changing a password requires the current password even though the caller already
holds a valid session. A stolen cookie must not be enough to take permanent
ownership of an account — that is the line between a session compromise and an
account compromise.

### Sign-in audit trail

Every attempt appends a row to `login_attempts` with the outcome
(`SUCCESS` / `INVALID_PASSWORD` / `UNKNOWN_EMAIL` / `LOCKED`), so a
credential-stuffing sweep across many addresses is visible after the fact.

Client IPs are stored as a **salted SHA-256 hash, never in the clear** — enough
to group attempts by source without retaining a personal identifier we have no
product use for. The salt is `SESSION_SECRET`, so rotating it makes old hashes
uncorrelatable, which is the desired direction of failure. The `x-forwarded-for`
header is attacker-controlled and is therefore used only for this grouping, never
for authorization and never for the lockout counter (which keys off the account,
so header spoofing cannot bypass it).

Log writes are wrapped so a failure can never block a sign-in or turn a clean 401
into a 500. The row is nice to have; the auth decision is not negotiable.

### Security headers

Applied by `src/middleware.ts` from the pure `src/lib/security/headers.ts`
(41 behavioural assertions, since a typo in a CSP directive name is not a syntax
error — it is just a directive the browser ignores).

CSP is `'self'`-only with no wildcards and no remote hosts: `object-src`,
`frame-src` and `frame-ancestors` are `'none'`; `form-action` is `'self'` so an
injected form cannot exfiltrate credentials; `connect-src` is `'self'`, which also
means no model-provider egress is possible. Production adds
`upgrade-insecure-requests` and HSTS (1 year, `includeSubDomains`, `preload`);
development adds `'unsafe-eval'` for React Fast Refresh. Also set:
`X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, a `Permissions-Policy` denying camera,
microphone, geolocation, payment and USB, and both `Cross-Origin-*` policies.

**Documented gap:** `script-src` retains `'unsafe-inline'`. Next.js's App Router
injects inline bootstrap and flight-data scripts on every server-rendered page,
and removing it breaks hydration outright until those are nonce-tagged. The
header module already accepts a `nonce`, so the migration path is open. A test
pins the current state so tightening it later is a deliberate change rather than
silent drift in either direction.

The middleware deliberately performs **no** authentication. It runs on the Edge
runtime where Prisma is unavailable, so it could only check that a cookie
*parses* — not that the session is valid, the user exists, or the epoch is
current. A check that weak is worse than none: it looks like authorization while
guaranteeing nothing, and invites callers to stop checking properly downstream.
Authorization stays where the database is.

## Known gaps (tracked in ROADMAP)

| Gap | Risk | Priority |
| --- | --- | --- |
| No CSRF token on cookie-auth mutations | CSRF (mitigated by SameSite=Lax, not eliminated) | **High** |
| No rate limiting on non-auth paths (invite, comment, saved views) | Abuse / spam | High |
| No automated tenant-isolation test in CI | Regressions go unnoticed between manual runs | High |
| No password reset / forgot-password flow | Users locked out permanently have no recovery | High |
| No MFA / passkeys | Account takeover | Medium |
| `script-src 'unsafe-inline'` (see above) | XSS impact is not fully contained | Medium |
| No dependency scanning in CI | Supply chain | Medium |
| `login_attempts` has no retention policy | Table grows unbounded | Low |
| No device/session list in the UI | Users cannot see or name active sessions | Low |

### Closed on Day 7

- ~~No rate limiting on login~~ → exponential lockout, persisted per user.
- ~~No session revocation~~ → session epoch; password change and
  `logout?everywhere=1` both revoke.
- ~~No audit trail for auth events~~ → `login_attempts` with hashed IPs.
- ~~No security headers~~ → CSP, HSTS, and seven more via middleware.
- ~~Account enumeration via timing~~ → constant-cost sign-in path.
- ~~Demo credentials pre-filled in the auth form~~ → fields start empty.

Cookie `secure` was already correct (`secure: process.env.NODE_ENV === "production"`).

## Pre-production security checklist

- [x] `secure: true` cookies over HTTPS; strong, rotated `SESSION_SECRET`.
- [x] Rate limiting on the sign-in path.
- [ ] Rate limiting on invitations and other sensitive mutations.
- [x] Session revocation + "log out other devices".
- [ ] Password reset flow (currently no recovery path).
- [ ] CSRF protection for cookie-authenticated state changes.
- [x] Manual test: Tenant A cannot access Tenant B (API + search + analytics) —
      see `docs/LIVE-TEST-REPORT.md`.
- [ ] The same test, automated and running in CI.
- [x] Structured audit logging for sign-in attempts.
- [ ] Structured audit logging for role-change / invite / delete.
- [ ] Dependency vulnerability scanning in CI.
- [x] Security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy).
