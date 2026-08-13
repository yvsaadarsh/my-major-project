# Deployment (cloud, no local installs)

Run Project OS entirely in the cloud — no Node.js or database on your PC.
Stack: **GitHub** (code) → **Neon** (free PostgreSQL) → **Vercel** (hosting).

Everything below is done in the browser. Total time: ~15 minutes.

---

## Prerequisites

- The code is pushed to GitHub: `https://github.com/yvsaadarsh/my-major-project`
  (see "Pushing the latest code" at the bottom if your newest changes aren't there yet).
- A free Neon account: https://neon.tech
- A free Vercel account: https://vercel.com (sign in with GitHub).

---

## Step 1 — Create the database (Neon)

1. Go to https://neon.tech and sign up (GitHub login is easiest).
2. Click **Create project**. Give it a name (e.g. `project-os`), pick a region near you,
   keep the default Postgres version.
3. After it's created, open **Connection Details**.
4. Copy the connection string. It looks like:
   ```
   postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
   ```
   Use the **Pooled connection** string (it has `-pooler` in the host). Keep this tab open —
   you'll paste this into Vercel as `DATABASE_URL`.

---

## Step 2 — Import the project into Vercel

1. Go to https://vercel.com and log in with GitHub.
2. Click **Add New… → Project**.
3. Find and **Import** the `my-major-project` repository.
4. Vercel auto-detects Next.js — leave the Framework Preset as **Next.js**.
   Do **not** change the build command; the repo's build script runs
   `prisma generate && next build`.

> **The build does not touch the database.** Migrations are applied separately
> (Step 4a) so that a sleeping or unreachable database can never break a deploy
> that has nothing to do with the schema.

---

## Step 3 — Set environment variables (in the Vercel import screen)

Before clicking Deploy, expand **Environment Variables** and add these three:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | the Neon **pooled** connection string from Step 1 — the host must contain `-pooler` and the URL must end with `?sslmode=require` |
| `SESSION_SECRET` | a long random string, at least 32 characters (one is provided in chat) |
| `NODE_ENV` | `production` |

> `NODE_ENV=production` is usually set by Vercel automatically; add it explicitly to be safe —
> it turns on secure (HTTPS-only) session cookies.

---

## Step 4 — Deploy

1. Click **Deploy**.
2. Watch the build log. You'll see Prisma generate the client, then Next build.
   No database connection is made — a green build does **not** mean the schema
   is applied.
3. When it finishes, click the deployment URL (e.g. `https://multi-model.vercel.app`).

---

## Step 4a — Apply migrations (once per schema change)

The database is still empty at this point. Migrations run from a machine that can
reach Neon, not from the build:

```bash
# DATABASE_URL must point at the same Neon database Vercel uses.
# Use the DIRECT (non-pooled) string here — PgBouncer cannot run DDL in a
# transaction, so migrations need the unpooled endpoint even though the app
# itself uses the pooled one.
npm run db:deploy
```

Run this **before** promoting a release whose code depends on the new schema.
Repeat it whenever you add a migration; deploys that don't change the schema need
nothing here.

---

## Step 5 — Create your account

The database starts empty. On the deployed site:

1. Go to the sign-up / register page.
2. Create an account, then create an organization — you become its **ADMIN**.
3. Start creating projects, tasks, milestones, subtasks, and dependencies.

That's it — the app is live.

---

## Optional — load demo data

The empty database is fine (you just register). If you also want the sample
"Northwind Labs" org with demo projects/tasks:

- The seed (`prisma/seed.ts`) needs a Node runtime to run. Since you don't run Node
  locally, the simplest options are:
  - **Just register** and build your own data (recommended — no seed needed), or
  - Ask me to add a one-time, protected seed endpoint you can trigger from the browser.

---

## Troubleshooting

- **`P1001: Can't reach database server at …:5432`** → nothing answered at that
  host. The failure takes almost exactly 5 seconds (Prisma's connect timeout),
  which distinguishes it from an auth or TLS rejection — those fail immediately.
  Work through, in order:
  1. Is the host the **pooled** one? It must contain `-pooler`. A host like
     `ep-xxx.c-4.us-east-2.aws.neon.tech` is the direct endpoint.
  2. Does the URL end with `?sslmode=require`? Neon refuses plaintext.
  3. Does the endpoint still exist in the Neon console? Free-tier branches are
     archived after inactivity and the host stops answering.
  4. Is the variable ticked for the **Production** environment, not only Preview?
- **Tables missing at runtime / `relation does not exist`** → the build no longer
  applies migrations. Run `npm run db:deploy` (Step 4a).
- **"SESSION_SECRET must be at least 32 characters"** → your secret is too short.
  Replace it with the 48-byte value from chat and redeploy.
- **Can't stay logged in** → make sure `NODE_ENV=production` is set (secure cookies over HTTPS).
- **Database connection errors at runtime** → confirm you used the **pooled** Neon
  string (host contains `-pooler`), which is required for serverless functions.

---

## Pushing the latest code (if your newest changes aren't on GitHub)

The Day-1/Day-2 changes live in your local folder. If GitHub doesn't have them yet,
push with **GitHub Desktop** (a GUI, no Node.js needed):

1. Install GitHub Desktop: https://desktop.github.com
2. **File → Add local repository** → choose this project folder.
3. It shows all changed files. Enter a summary like "Day 1–2: stabilize + deep task layer".
4. Click **Commit to main**, then **Push origin**.

Vercel auto-redeploys on every push to `main`.

---

## Redeploying after changes

Any push to the `main` branch triggers an automatic Vercel rebuild and redeploy —
including applying any new database migrations. Nothing else to do.
