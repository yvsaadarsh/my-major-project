# Live Gemini Verification — Handoff Procedure

Run this from an **authorized environment with outbound access to
`generativelanguage.googleapis.com`** (your own machine or a deployment). The
Anthropic→Gemini swap, client hardening, and all seven AI features are already
verified for *safety and regression* in CI-style checks; the **only** thing that
cannot be verified without that egress is a **real model response**. This
procedure gets that evidence with the smallest, reproducible set of steps.

> Scope note: the sandbox used for development cannot reach Google's endpoint
> (DNS `ENOTFOUND` / proxy `403`), so live AI there is `BLOCKED`, never `PASS`.
> Nothing below changes application code — it only exercises the real client.

---

## Cloud execution

The Codex cloud environment can run the same TypeScript live suite directly;
Windows and the PowerShell helper are **not required**. Use a dedicated disposable
database and run `npm run db:deploy`, `npm run db:seed`, `npm run build`, then
start the server with that database. Run `npm run test:ai:live` with the same
secure `GEMINI_API_KEY` binding and `LIVE_BASE` pointing to the test server.
Never infer PASS from exit code alone: the suite exits zero when its preflight
reports **NOT RUN**. The current cloud results are in `CLOUD-VALIDATION.md`.

Set the key through secure environment settings and allow outbound HTTPS to
`generativelanguage.googleapis.com`. Do not paste credentials into chat.

## 0. Prerequisites

| Requirement | Detail |
| --- | --- |
| Repo + deps | This repository at the branch you are verifying; `npm ci` once. |
| Node.js | The version the repo targets (Node 20+). |
| Database | A **disposable** PostgreSQL (local or a throwaway Neon branch). **Never** production/shared — the live suite writes rows. |
| Network | Outbound HTTPS to `generativelanguage.googleapis.com` must be allowed. |
| Key | A Google AI Studio `GEMINI_API_KEY` (the `AQ.` prefix is valid). Its project must have access to the models in use. |

The live-test harness (`scripts/test-ai-live.ts`) enforces its own prerequisites
and **self-skips to BLOCKED** (never a false pass) if any are missing:
`GEMINI_API_KEY` set, `DATABASE_URL` set, server reachable at `LIVE_BASE`, seed
accounts present, and an `interpret` probe returning `200`.

---

## 1. Configure secrets securely (never printed, never committed)

`.env` is gitignored — put secrets there, not in code or shell history.

```bash
cp .env.example .env         # then edit .env:
#   DATABASE_URL=...         # your DISPOSABLE database
#   SESSION_SECRET=...       # >= 32 chars
#   GEMINI_API_KEY=...       # paste without echoing (see below)
```

To add the key without echoing it to the terminal or history:

```bash
# bash/zsh
read -rs GEMINI_API_KEY && printf 'GEMINI_API_KEY="%s"\n' "$GEMINI_API_KEY" >> .env && unset GEMINI_API_KEY
```
```powershell
# PowerShell
$k=Read-Host -AsSecureString "GEMINI_API_KEY"; $p=[System.Net.NetworkCredential]::new('',$k).Password
Add-Content .env "GEMINI_API_KEY=`"$p`""; Remove-Variable p,k
```

The key is server-side only (no `NEXT_PUBLIC_` prefix; CSP `connect-src 'self'`),
so it never reaches browser code.

---

## 2. Confirm the database is disposable — REQUIRED before any write

Several steps below **write** to the database (migrate, seed, the live apply
flow, the feature‑7 rule). Do them only against a database you created to throw
away. Do **not** rely on eyeballing `DATABASE_URL`. Run this gate — it prints
**only** the database name and host (never the user or password) and refuses
obvious production markers:

```bash
node -e 'const u=require("url");require("fs").readFileSync(".env","utf8").split("\n").forEach(l=>{if(l.startsWith("DATABASE_URL=")){const v=l.slice(13).trim().replace(/^"|"$/g,"");const p=new u.URL(v);const db=p.pathname.replace(/^\//,"").split("?")[0];const host=p.hostname;const bad=/(prod|production|live|main)/i.test(db+host);console.log("db =",db,"| host =",host);if(bad){console.error("ABORT: name/host looks production-like — do not write here.");process.exit(1);}console.log(host==="localhost"||host==="127.0.0.1"?"local disposable OK":"NON-LOCAL host — proceed ONLY if this is a throwaway branch you created.");}})'
```

Proceed only if the printed name/host is a throwaway you own (a local DB or a
disposable Neon **branch**, never the pooled production database from
`docs/DEPLOYMENT.md`). If anything is uncertain, stop — do not write.

> **`npm run db:seed` WIPES the target database** (it deletes the demo org and
> reseeds). The name/host gate above is a safety *signal*, not proof — it would
> happily pass your normal dev database (`projectos_e` on localhost). Point
> `DATABASE_URL` at a database **created solely for this run**, not your working
> dev DB. The automated script `scripts/live-verify.ps1` does this for you: it
> **creates a dedicated `projectos_liveverify_<ts>` database, uses it
> exclusively, and drops it at the end**, never touching your configured DB — so
> prefer the script unless you have deliberately provisioned a throwaway DB for
> these manual steps.

Then prepare the schema and build:

```bash
npm ci
npm run db:deploy      # prisma migrate deploy  (applies the 9 migrations)
npm run db:seed        # WRITES: wipes + seeds org "northwind-labs" + ada/grace/linus@northwind.test
npm run build          # prisma generate && next build  (needs normal network)
```

---

## 3. Start the server the live suite expects

```bash
npx next start --port 3123     # leave running in terminal A
```

`LIVE_BASE` defaults to `http://127.0.0.1:3123`. To use `next dev` on 3000
instead, set `export LIVE_BASE=http://127.0.0.1:3000` before step 4/5.

The server loads `.env`, so it uses the **real** Gemini client — the test double
(`scripts/doubles/ai-client.ts`) is wired **only** into `npm run test:ai` via
`tsconfig.test.json`, never into `next start`/`next dev`.

---

## 4. Live smoke + the live suite (Policy Studio + Simulation)

In terminal B:

```bash
npm run test:ai:live
```

This performs a real `interpret` smoke in preflight, then exercises **Policy
Studio** (structured draft from free text, unsupported→422, conflict detection)
and **What-If Simulation** (interpretation, narration ≥40 chars, deterministic
diff, snapshot token, no-mutation, apply, **stale→409**, **replay→409**) — all
against the disposable DB, capped at **12 model calls**.

**Write effects (why the DB must be disposable):** interpret and simulate write
**nothing** (asserted). The apply flow **persists**: it sets one real task to
`DONE` and inserts one `project.simulation_applied` audit row; it also toggles a
bystander task's status and restores it. Net lasting change: **one task → DONE +
one audit row.** Re-seed afterwards (see Cleanup) if you want a pristine state.

**What proves a real response — objective, not log-based (all must hold):**
- The run is **not** `LIVE AI SUITE — NOT RUN`, i.e. the preflight `interpret`
  probe returned **HTTP 200**. This is the anchor evidence: `interpret` (and
  simulate's first call, and `parse-task`) have **no deterministic fallback** —
  when the model is unreachable they return **502**, never 200. A 200 with a
  model‑chosen `draft.trigger`/`draft.action` therefore cannot be produced by a
  fallback and is positive proof a real Gemini response was received and parsed.
- Final line `model calls used: N of 12` with **N ≥ 1**.
- `PASS draft.trigger is one of the supported triggers` and
  `PASS [D-3] interpreted intent references the actual target` (model output
  consumed by the app).
- *Secondary cross-check only:* terminal A shows no
  `could not reach Gemini. Check network egress.` line. Use this to corroborate,
  not as primary evidence.

---

## 5. Targeted checks for the other five features

Authenticate once. **Important:** under `next start` (`NODE_ENV=production`) the
`pm_session` cookie is `Secure`, so a curl **cookie jar** (`-c/-b`) will refuse
to resend it over plain `http://` and every call will 401. Instead capture the
cookie from the login response headers and send it as an explicit `Cookie:`
header (this is what `scripts/test-ai-live.ts` does, and why it works over http):

```bash
BASE=http://127.0.0.1:3123
COOKIE=$(curl -s -D - -o /dev/null -X POST "$BASE/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"ada@northwind.test","password":"Password123!"}' \
  | tr -d '\r' | sed -n 's/^set-cookie: \(pm_session=[^;]*\).*/\1/p')
test -n "$COOKIE" || { echo "login failed — seed the DB"; exit 1; }

# Grab a project id (and a milestone id for the retrospective):
PID=$(curl -s -H "Cookie: $COOKIE" "$BASE/api/v1/projects" | python3 -c 'import sys,json;print(json.load(sys.stdin)["projects"][0]["id"])')
MID=$(curl -s -H "Cookie: $COOKIE" "$BASE/api/v1/projects/$PID/milestones" | python3 -c 'import sys,json;print(json.load(sys.stdin)["milestones"][0]["id"])')
```

In every per-feature `curl` below, replace `-b cj.txt` with `-H "Cookie: $COOKIE"`.

**3. AI task parsing / compose** — `POST /api/v1/ai/parse-task`
```bash
curl -s -b cj.txt -X POST "$BASE/api/v1/ai/parse-task" \
  -H 'content-type: application/json' \
  -d "{\"text\":\"draft the launch checklist, high priority, due next Friday\",\"projectId\":\"$PID\"}"
# PASS: HTTP 200 with a structured task (title/priority/dueDate) parsed from the sentence.
```

**4. Milestone retrospective** — `GET …/retrospective` (streamed prose)
> **Precondition (verified):** the route only runs for a **closed** milestone
> (`status` ∈ `DONE`|`MISSED`). The seed creates only `AT_RISK`/`ON_TRACK`
> milestones and there is **no milestone-update API**, so a seeded milestone
> returns `400 milestone_not_closed`. To exercise it, close one on the
> **disposable** DB first (reverted by the final re-seed):
> ```bash
> PG=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"' | sed 's/?schema=public//')
> psql "$PG" -c "UPDATE milestones SET status='MISSED' WHERE id='$MID';"
> ```
```bash
curl -s -H "Cookie: $COOKIE" "$BASE/api/v1/projects/$PID/milestones/$MID/retrospective"
# PASS: a non-empty streamed narrative. (501 = no key; 400 = milestone not closed; empty = AI unreachable.)
```

**5. Project health narrative** — `GET …/narrative` (streamed prose)
```bash
curl -s -b cj.txt "$BASE/api/v1/intelligence/projects/$PID/narrative"
# PASS: streamed narrative text referencing the project's real metrics.
```

**6. Forecast** — `GET …/forecast` (streamed prose)
```bash
curl -s -b cj.txt "$BASE/api/v1/intelligence/projects/$PID/forecast"
# PASS: streamed forecast text. ({"insufficient":true,...} = not enough history, not a failure.)
```

**7. Smart notification narration** — requires a precondition the seed does NOT
provide. Verified against the code: the narrator (`healthChangeNarrator`) only
runs inside `runScheduledAutomations` when **an enabled `PROJECT_HEALTH_CHANGED`
rule exists** and a project's computed health differs from the "Healthy"
baseline. The seed creates only enabled `TASK_OVERDUE` / `TASK_STATUS_CHANGED`
rules, so you must create and activate a health rule first (two steps, per D-8:
create saves **disabled**, then PATCH activates — payloads verified against
`automationRuleCreateSchema` / `automationRuleUpdateSchema`):

```bash
# a) create (saved DISABLED by D-8) — note the returned rule id
RID=$(curl -s -b cj.txt -X POST "$BASE/api/v1/automations" -H 'content-type: application/json' \
  -d '{"name":"Live health check","trigger":"PROJECT_HEALTH_CHANGED","action":"NOTIFY_MANAGER","condition":"when project health drops below healthy"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
# b) activate it (explicit PATCH; writes an automation.updated audit row)
curl -s -b cj.txt -X PATCH "$BASE/api/v1/automations/$RID" -H 'content-type: application/json' -d '{"enabled":true}' >/dev/null
# c) run the automations (the seed has overdue/blocked tasks, so some project is non-Healthy)
curl -s -b cj.txt -X POST "$BASE/api/v1/automations/run" -H 'content-type: application/json' -d '{}'
# d) inspect the newest notification body:
curl -s -b cj.txt "$BASE/api/v1/notifications"
```
- **PASS (real AI):** a health-change notification whose body is a fluent,
  context-specific sentence (naming the project / band / score) — *distinct from*
  the deterministic template `planAutomation` emits. Corroborate with the
  session's interpret‑200 (step 4), which already proved the model is reachable.
- **Fallback (NOT real AI):** when the narrator can't reach the model it resolves
  to `null` and the **deterministic** body is used — a safe, templated sentence.
  Do not record this as real-AI.
- **WRITE EFFECTS:** this creates a rule and may insert notifications/audit rows
  on the disposable DB. Re-seed to reset (see Cleanup).

**Streamed features (4–6) — objective evidence:** `narrative`, `forecast` and
`retrospective` stream model prose. When Gemini is unreachable the route emits
**no prose** (empty body / dropped section / `501`), so **receiving substantive
streamed text is itself the positive signal** — it cannot come from a fallback
(there is none that produces prose). Treat the absence of a `could not reach
Gemini` log line only as a secondary cross-check.

---

## 6. Expected outcome classification

**Provenance comes from each route's contract, NOT from a missing log line.**
Only two route shapes can *prove* a real model response:

| Route shape | Features | Proof of real AI |
| --- | --- | --- |
| **No fallback** (returns `502` when the model is unreachable) | Policy Studio `interpret`, task `parse-task` | **`200` with the required fields** (`draft.trigger`+`draft.action` from the supported enums / a non-empty `title`) — a fallback cannot produce it → **PASS (real)** |
| **502-not-prose on failure** | `narrative`, `forecast`, `retrospective` | **`200` with substantive streamed prose** — failure yields `502`, never canned prose → **PASS (real)** |
| **Has a deterministic fallback** (always `200`) | What-If Simulation narration/intent; smart notification body | **UNVERIFIED** — `200`/text does not prove provenance. The simulation **diff** is a separate deterministic **PASS**; the narration is `FALLBACK` if `interpretedIntent == "Evaluate the impact of a <type> change."`, else UNVERIFIED. The notification body has no provenance marker: confirm it belongs to your `PROJECT_HEALTH_CHANGED` rule, then compare it by eye against the deterministic template. |

Error taxonomy (the client normalizes each to a distinct message):

| Message | Meaning | Verdict |
| --- | --- | --- |
| `could not reach Gemini` / DNS `ENOTFOUND` / proxy `403` | egress denied | **BLOCKED (network)** — not a key/code fault |
| `rejected the API key (401/403)` | bad/unauthorized key | **FAIL (authentication)** |
| `Gemini API error 404 … model` / `ACCESS_TOKEN_TYPE_UNSUPPORTED` | model not granted to this key/project | **FAIL (model-access)** |
| `rate limited (429) after retries` | quota/rate | **FAIL (quota)** |
| `timed out after N ms` | deadline hit | raise `GEMINI_TIMEOUT_MS` / investigate latency |

Models: `gemini-2.5-pro` (quality/streamed), `gemini-2.5-flash` (fast/structured),
overridable via `GEMINI_QUALITY_MODEL`/`GEMINI_FAST_MODEL`. Reliability:
`GEMINI_TIMEOUT_MS` (30000), `GEMINI_RETRY_ATTEMPTS` (3; transient 408/429/5xx only).

**Record live AI as PASS only where the route contract proves provenance (rows 1–2
above). Never mark a deterministic fallback, a cached/generic body, or a bare
`200` on a degrading endpoint as PASS — label it UNVERIFIED.**

---

## 7. Cleanup

The live suite and feature‑7 leave writes on the disposable DB (a task set to
`DONE`, audit rows, the health rule, notifications). To reset:

```bash
# stop the server (Ctrl-C in terminal A)
npm run db:seed        # re-seed to a pristine state (wipes + reseeds), OR
#   drop the disposable database entirely if it was created just for this run.
rm -f cj.txt           # remove the cookie jar
```
Never commit `.env` or paste the key into chat, a PR, or logs. Do not run any of
the writing steps against a database whose disposability you did not confirm in
step 2.
