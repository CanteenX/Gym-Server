# How to deploy Mid City Gym

**Live: https://mid-city-gym.vercel.app**

This is the "how do I ship it" guide. For *why* the deployment is shaped the
way it is — the project split, the serverless constraints, the trade-offs —
read `DEPLOYMENT-VERCEL.md` in this folder. You do not need it to deploy.

---

## The one-paragraph version

Push to `main`. That is the whole deploy.

Pushing `Gym-frontend` builds the website **and** the admin panel and ships
them. Pushing `Gym-Server` ships the API. Pushing `Gym-Admin` tells
`Gym-frontend` to rebuild. Each finishes with a smoke test that fails the run
if the site is broken. Nobody needs the Vercel CLI, and nobody needs to deploy
from a laptop.

---

## What is actually running

Three repositories, **two** Vercel projects, one public URL.

```
mid-city-gym.vercel.app
├── /            Next.js site + member portal   ← Gym-frontend   (project: mid-city-gym)
├── /admin       Vite admin panel               ← Gym-Admin      (built into the above)
└── /api/v1/*    ─ proxied to ─────────────────→ Gym-Server      (project: mid-city-gym-api)
```

| Thing | Value |
|---|---|
| Vercel team | `nventra01-6027s-projects` (`team_QCVr9StaSATn5zCrW1b36vvd`) |
| Front-end project | `mid-city-gym` — `prj_w6f7sEftE6JIka8cUq2qBA0gTx1i` |
| API project | `mid-city-gym-api` — `prj_pjpOziG978CpMyXwF9QY5LrskORl` |
| API's own URL | `https://mid-city-gym-api.vercel.app` |
| GitHub org | `CanteenX` |

**The one thing that surprises people:** `VERCEL_PROJECT_ID` means the
*front end*. The front end kept the original project when the deployment was
split, so it kept that id. The API deploys using `VERCEL_API_PROJECT_ID`.
Mixing them up deploys the API over the public website.

---

## Deploying

### The normal way

```bash
git push origin main
```

| You pushed | What runs | What it does |
|---|---|---|
| `Gym-frontend` | *Deploy to Vercel* | Builds Gym-Admin, assembles it into `public/admin/`, deploys the front-end project, smoke tests |
| `Gym-Server` | *Deploy API to Vercel* | Deploys the API project only, smoke tests |
| `Gym-Admin` | *Trigger deploy* | Sends a `repository_dispatch` to Gym-frontend, which then does the above with your commit |

Watch it at `https://github.com/CanteenX/<repo>/actions`, or:

```bash
gh run watch -R CanteenX/Gym-frontend --exit-status
```

Deploys are queued, not cancelled, so two pushes close together both ship.

### By hand, without pushing

Only needed if CI is unavailable. You need the Vercel CLI and a token.

```bash
# 1. Build the admin panel and put it where the front end expects it
cd Gym-Admin
npm run check:icons          # fails the build on an icon class that does not exist
npm run build
cd ../Gym-frontend
rm -rf public/admin && mkdir -p public/admin
cp -r ../Gym-Admin/build/. public/admin/

# 2. Ship the front end
vercel deploy --prod         # remote build; do NOT use --prebuilt

# 3. Ship the API (separate project)
cd ../Gym-Server
vercel deploy --prod
```

Then, in `Gym-Admin`, undo the build output — it is committed to git and you do
not want it in your diff:

```bash
git checkout -- build/ && git clean -fdq build/
```

Two traps here:

- **Do not pass `ADMIN_BASE_PATH`.** `/admin/` is already the default. On Git
  Bash, MSYS rewrites `/admin/` into a Windows path and the SPA ships with
  asset URLs that 404 — a blank panel with a completely green build.
- **Do not use `--prebuilt`.** The API bundles native modules (`bcrypt`,
  `sharp`). A prebuilt deploy ships whatever binaries your machine produced,
  and anything that is not the exact Vercel runtime crashes on every request.

---

## Checking it worked

CI already smoke tests `/`, `/admin`, `/admin/`, a real `/admin/assets/*.js`,
the icon font, and `/api` for `"database":"Connected"`. If the run is green,
the site is up.

By hand:

```bash
curl -sL -o /dev/null -w '%{http_code}\n' https://mid-city-gym.vercel.app/
curl -sL https://mid-city-gym.vercel.app/api      # expect "database":"Connected"
```

**`/admin/` answers 308, not 200.** Next redirects the trailing-slash form
before rewrites run. Browsers follow it, so use `curl -sL` and check the final
status. A literal-200 assertion fails a perfectly healthy deploy.

### The full browser check

```bash
cd Gym-Admin
SA_EMAIL=... SA_PASS=... npm run e2e -- --base https://mid-city-gym.vercel.app
```

This is a **gate**, not a report — it exits non-zero on failure. It logs in,
sweeps every admin route, and checks for page errors, unlabelled form controls,
nameless icon buttons, zero-width icons and content clipped off-screen at
390px. Add screens with `--routes a,b,c` (it appends, it does not replace).

It will **not** retry a failed login: three failures lock the account for 24
hours.

> Give the CDN about two minutes after a deploy before judging a result, and
> check the bundle hash actually changed. More than once a "still broken"
> verdict has just been a cached page.

---

## Configuration

### GitHub secrets

| Repo | Secrets it needs |
|---|---|
| `Gym-frontend` | `GH_PAT`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN` |
| `Gym-Server` | `VERCEL_ORG_ID`, `VERCEL_API_PROJECT_ID`, `VERCEL_TOKEN` |
| `Gym-Admin` | `GH_PAT` |

`GH_PAT` needs `repo` access to the `CanteenX` org: Gym-frontend uses it to
clone Gym-Admin, and Gym-Admin uses it to trigger Gym-frontend. A repo's own
`GITHUB_TOKEN` cannot reach another repository.

Both deploy workflows fail fast if their project id is missing. That check
exists because `vercel deploy --yes` with no project id does not error — it
**creates a brand-new project** named after the directory and deploys there, so
the run goes green and the release lands somewhere nobody is looking.

### Vercel environment variables

**`mid-city-gym-api`** — everything the API needs at runtime:
`DATABASE`, `SESSION_SECRET`, `ADMIN_JWT_SECRET_KEY`, `EMPLOYEE_JWT_SECRET_KEY`,
`MEMBER_JWT_SECRET_KEY`, `JWT_EXPIRY`, `RATE_LIMIT_WINDOW_MS`,
`RATE_LIMIT_MAX_REQUESTS`, `AUTH_RATE_LIMIT_MAX`, `ALLOWED_ORIGINS`,
`BLOB_READ_WRITE_TOKEN`, `PUBLIC_SITE_ORIGIN`, `REVALIDATE_SECRET`.

**`mid-city-gym`** (front end) — `API_INTERNAL_URL`, `SITE_URL`,
`REVALIDATE_SECRET`. The older API variables are still present there from
before the split; leave them, they are what makes a rollback to a pre-split
deployment work.

Three of these are easy to get wrong:

- **`ALLOWED_ORIGINS` is the PUBLIC origin** (`https://mid-city-gym.vercel.app`),
  not the API's own hostname. That is what the browser sends as `Origin` through
  the proxy.
- **`REVALIDATE_SECRET` must be identical on both projects.** It is how the API
  tells the site to rebuild a page after a CMS edit. Both sides fail closed: if
  it is missing or mismatched, saves succeed but the website silently keeps
  showing the old copy.
- **`API_INTERNAL_URL` is read at BUILD time** (`next.config.ts` evaluates
  rewrites when the app compiles). Changing it needs a redeploy, not just an
  env var edit.

`NEXT_PUBLIC_API_URL` is deliberately **not set**. The portal already defaults
to same-origin in production, and setting it invites the empty-string quoting
bug that has bitten this project before.

---

## One-off setup steps

These are already done on the live database. You need them only for a fresh
environment, or when a feature says so. All are idempotent — running one twice
is harmless.

```bash
cd Gym-Server

npm run seed:menus            # base navigation
npm run seed:website-menus    # Website group: pages, adverts, leads, SEO manager
npm run seed:insights-menus   # Insights group: attendance, reports, audit log
npm run seed:seo              # 9 SEO rows (portal routes seeded noIndex)
npm run seed:site-content     # the 8 editable page sections
npm run seed:site-items       # 48 repeating rows: programmes, plans, FAQs, trainers, classes...
GMAIL_APP_PASSWORD=xxxx npm run seed:email   # SMTP account, stored in Mongo not .env
```

**Menu seeds are not optional.** Permissions resolve a screen by looking its URL
up in `MenuMaster`; a missing row is a 403, not a fallback. A super admin
bypasses that check, so a missing seed looks fine to the owner and completely
broken to every employee.

**Role grants are deliberately not applied.** Seeding a menu does not give every
role write and delete on it — that would hand a trainer the ability to delete
the website. Assign permissions per role on the Employee Roles screen, or re-run
a seed with `--grant-all` if you genuinely want the blanket behaviour.

### Migrations

```bash
node scripts/migrateAttendanceSubjectType.js --dry-run   # always look first
npm run migrate:attendance-subject
```

Already applied to the live database. It backfills `subjectType`/`source` and —
the important part — rebuilds `memberId_1_date_1` as a *partial* unique index.
As a plain unique index it treated `null` as a value, so the second trainer to
check in on any day would have collided with the first. Mongoose will not
rewrite an existing index when the schema changes; it logs a conflict and keeps
the dangerous one. Only this script fixes it.

---

## When it goes wrong

### Roll back

The two projects roll back independently.

```bash
vercel rollback <deployment-url>
```

Or promote a previous deployment in the Vercel dashboard. Pre-split
deployments in the front-end project still work, because that project kept the
old environment variables.

### Symptoms

| What you see | What it is |
|---|---|
| Deployment state `BLOCKED`, no build logs | Account-level restriction, not your code. Check Usage/Billing on vercel.com. Nothing deploys until it clears |
| `/admin` is blank, build was green | Vite base path. Check `index.html` references `/admin/assets/`, and that `ADMIN_BASE_PATH` was not passed |
| Login returns 200 but you stay logged out | No `Set-Cookie`. The API needs `trust proxy`; check `ALLOWED_ORIGINS` is the public origin |
| CMS save works, website unchanged | `REVALIDATE_SECRET` missing or different between the two projects |
| Icons render as blank boxes | A class the font does not define. `npm run check:icons` catches it before deploy |
| Employee gets "Menu '/x' not found" | A menu seed has not been run |
| A change you made is not visible | CDN cache. Wait two minutes, confirm the bundle hash changed |

### Logs

```bash
gh run view <run-id> -R CanteenX/Gym-frontend --log
vercel logs https://mid-city-gym.vercel.app
```

---

## Things that look alarming and are fine

- **Dead workflows.** `Gym-Server` still has `production.cicd.yaml`,
  `stage.cicd.yaml` and `pr-tests.yaml`, and `Gym-Admin` has `cicd.yaml`. These
  are the old FTP/PM2 pipeline. They cannot run: they trigger on pushes to
  `production`, `staging` and `redacted`, and on PRs into `develop` — and
  **none of those branches exist**. All three repositories have exactly one
  branch, `main` (verified with `git ls-remote --heads origin`).

  So they are inert, not merely idle. But they are also a live tripwire: create
  a branch called `staging` or `production` and the old FTP deploy starts
  running against whatever host those secrets still point at. If you want them
  gone, delete the four files — the history keeps them if the FTP target is
  ever needed again.
- **`Gym-Admin/build/` is committed.** It is a leftover of the old FTP deploy.
  CI rebuilds it from source and ignores the committed copy.
- **`mid-city-gym-api.vercel.app` is publicly reachable.** CORS and
  authentication are the gate, not network isolation. Vercel's deployment
  protection covers preview URLs, not the production alias.
- **`/api/v1/site/*` and `/api/v1/attendance/*` return 401 to anonymous
  callers.** That is the design, and the smoke test asserts it.

## Things that are genuinely not fine

- **`Gym-Server/.env` is committed to a public repository**, containing the live
  Mongo URI and every JWT secret. It is excluded from the Vercel upload, so it
  is not web-reachable — but it is in git history. Rotating those credentials
  and making the repo private is the owner's call and has not been done.
- Several CMS write routes and two member routes have no auth middleware. See
  the "Known broken" section of the repository `CLAUDE.md`.
