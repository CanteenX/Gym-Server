# Vercel deployment (single domain, two projects)

**Live: https://mid-city-gym.vercel.app**

Three repositories, **two** Vercel projects, one URL.

```
mid-city-gym.vercel.app                    project: mid-city-gym   (Gym-frontend)
├── /            Next.js app, dynamic/ISR  Gym-frontend
├── /admin       Vite SPA in public/admin  Gym-Admin  (assembled by CI)
└── /api/v1/*    ---- rewritten to ---->   project: mid-city-gym-api (Gym-Server)
                                           Express serverless, api/index.js
```

The browser only ever sees one origin, so the admin's `express-session` cookie
stays first-party and the member portal issues relative requests: there is no
CORS configuration to maintain on this deployment, and no preflight on any
admin request. The proxy hop is the price.

## Why there are two projects

It used to be one: a single project served a folder of static files (the Next
**export**, plus the admin SPA) alongside one Express function.

The site then had to become dynamic - the CMS work requires an admin edit to be
live in seconds without a rebuild, which a static export cannot do. A dynamic
Next app needs its own runtime for routing, RSC payloads and image
optimization, so it cannot be a folder of static files inside another project.

The split was done the cheap way round, and the ordering matters if you ever
redo it:

- The **existing** project (`mid-city-gym`, id `prj_w6f7sEft…`) was *repurposed*
  as the front end. It therefore keeps both its project id and its
  `*.vercel.app` hostname.
- A **new** project (`mid-city-gym-api`, id `prj_pjpOziG9…`) was created for the
  API.

Doing it the other way - new project for the front end - does not work cleanly:
`mid-city-gym.vercel.app` is Vercel's auto-assigned hostname for the project
*named* `mid-city-gym` and cannot simply be moved, so it would have meant
renaming the project and living with a window where the public URL 404s.

A consequence worth knowing: the `VERCEL_PROJECT_ID` secret still means *the
front end*. `Gym-Server`'s workflow deliberately reads `VERCEL_API_PROJECT_ID`
instead, because reusing `VERCEL_PROJECT_ID` there would deploy the API over the
public site.

## Project settings

`mid-city-gym` (front end) — framework `nextjs`, no `buildCommand` or
`outputDirectory` override. Both overrides existed for the old assembled-`public/`
layout and **had to be cleared**: a project-level override beats `vercel.json`,
so `next build` would never have run.

`mid-city-gym-api` (API) — `framework: null`, `regions: ["bom1"]`.

`bom1` is not cosmetic. Atlas is in Mumbai and the function defaulted to `iad1`,
which put a ~1.4 s floor under every request that touched the database.

The API's `vercel.json` sets a throwaway `buildCommand` that creates
`public/index.txt` plus `outputDirectory: "public"`. That looks redundant and is
not: with `framework: null` **and no output directory**, Vercel's "Other" preset
serves the *repository root* as static output, which would publish the committed
`.env` - live Mongo URI and every JWT secret - at the API project's URL. The
empty `public/` gives it nothing to serve. The API workflow's smoke test asserts
this stays true.

## Environment variables

All runtime env vars live on **`mid-city-gym-api`**: `DATABASE`,
`SESSION_SECRET`, `ADMIN_JWT_SECRET_KEY`, `EMPLOYEE_JWT_SECRET_KEY`,
`MEMBER_JWT_SECRET_KEY`, `JWT_EXPIRY`, `RATE_LIMIT_*`, `AUTH_RATE_LIMIT_MAX`,
`ALLOWED_ORIGINS`, `BLOB_READ_WRITE_TOKEN`.

`ALLOWED_ORIGINS` is `https://mid-city-gym.vercel.app` - the **public** origin,
not the API's own hostname. That is what the proxy forwards as `Origin`, and
`getCorsConfig`'s `selfOrigins` (built from `VERCEL_PROJECT_PRODUCTION_URL`)
only knows the API project's hostname, so the public origin has to be listed
explicitly.

On **`mid-city-gym`** (front end) only `API_INTERNAL_URL` matters. It is read at
**build** time, because `rewrites()` in `next.config.ts` is evaluated when the
app is compiled - changing it needs a redeploy, not just an env var edit.

`NEXT_PUBLIC_API_URL` is deliberately **not set**: `src/lib/api.ts` already
defaults to `""` (same origin) in production. Setting it invites the
empty-string-becomes-`""` quoting bug that has bitten this project before.

The old server env vars are still present on the front-end project. Leave them:
a `vercel rollback` to a pre-split deployment would need them.

## Serverless constraints this codebase had to satisfy

These are the changes that made the Express app deployable, and the reasons they
cannot be reverted:

- **No writable filesystem.** `mkdirSync`/`writeFileSync` at module scope throws
  during module evaluation, which fails the *entire* function - every route
  returns `FUNCTION_INVOCATION_FAILED`, not just the one that touched disk. Four
  route files did exactly this at import time; they now call `ensureLocalDir()`
  from `config/runtime.js`, which no-ops when `VERCEL=1`. The error log is also
  routed to stderr instead of `log/error.html`.
- **Uploads go to Blob.** `storage/fileStore.js` is the single seam: Blob when
  `VERCEL=1`, local disk otherwise. It returns an absolute URL in the first case
  and a relative path in the second, and both clients' `fileUrl()` helpers pass
  absolute URLs through untouched, so old and new rows both render.
- **Connection reuse.** `config/db.js` caches the Mongoose connection on
  `globalThis`; connecting per invocation would exhaust the Atlas connection cap.
- **Nothing in `.vercelignore` may be imported at runtime.** It excludes files
  from the upload, and Vercel's tracing can only bundle what was uploaded.
  Ignoring `scripts/` while `server.js` imported `scripts/seedMenus.js` produced
  `ERR_MODULE_NOT_FOUND` on every request.
- **No SPA catch-all.** `app.get("/*")` is gated off, or unmatched API paths
  return 200 + HTML instead of a real 404.
- **`trust proxy` is still required, and is now under-counting hops.** The API
  sits behind Vercel's edge *and* the front end's rewrite, so
  `X-Forwarded-Proto` is what tells express-session it may send a `Secure`
  cookie. Without it login returns 200 and sets no cookie at all. That part is
  unaffected by the extra hop, because the protocol stays `https` all the way.

  `req.ip` is not. Express derives it from the hop count, which is set to `1`
  for the single-edge topology, so with the proxy in front it resolves to an
  intermediate infrastructure address rather than the visitor. Both login
  controllers used to read `req.ip` first when writing `LoginAttempt` and
  calling `geoip.lookup()`, which would have recorded brute-force attempts
  against Vercel instead of the attacker. They now use `utils/clientIp.js`
  (left-most `X-Forwarded-For`), which is hop-count independent - so changing
  `trust proxy` cannot silently move the answer again. Lockout itself is keyed
  on the user, not the IP, so enforcement was never affected.

## Menu seeding

`seedFaqMenus` / `seedHelpAndGuideMenus` used to run inline on every server
boot. A serverless container cold-starts constantly, so they now live in
`scripts/seedMenus.js`: the PM2 process still calls them at boot, and
`npm run seed:menus` runs them by hand. Both are idempotent.

## What triggers a deploy

```
push Gym-frontend/main  ------------------->  Gym-frontend: Deploy to Vercel
push Gym-Admin/main     --dispatch-------->     admin_ref = pushed SHA
push Gym-Server/main    ------------------->  Gym-Server:  Deploy API to Vercel
```

The front end and the API deploy **independently** now. A push to Gym-Server no
longer rebuilds the site, and a push to Gym-frontend no longer redeploys the API.

`Gym-Admin` has no Vercel project of its own; pushing it dispatches to
`Gym-frontend`, carrying the pushed SHA so the deploy builds exactly that commit
rather than whatever `main` has become by the time it runs.

Deploys are queued, not cancelled (`cancel-in-progress: false`), so two pushes
landing close together both reach production instead of one discarding the other.

`GH_PAT` is needed in `Gym-frontend` (to clone Gym-Admin) and in `Gym-Admin` (to
dispatch), since a repository's own `GITHUB_TOKEN` cannot reach another
repository.

### Secrets

| Repo | Secrets |
|---|---|
| `Gym-frontend` | `GH_PAT`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_TOKEN` |
| `Gym-Server` | `VERCEL_ORG_ID`, `VERCEL_API_PROJECT_ID`, `VERCEL_TOKEN` |
| `Gym-Admin` | `GH_PAT` |

## Running it

Push to `main`, or run either workflow manually.

The front-end workflow builds the admin panel, gates on `npm run check:icons`,
assembles `public/admin/`, deploys, then smoke tests `/`, `/admin`, `/admin/`, a
real `/admin/assets/*.js`, the icon font, and `/api` for
`"database":"Connected"`.

**`/admin/` answers 308, not 200.** Next redirects the trailing-slash form
before rewrites run. Browsers follow it, so the smoke test uses `curl -sL` and
asserts the final status; asserting a literal 200 fails a healthy deploy.

To reproduce a deploy by hand:

```bash
cd Gym-Admin && npm run check:icons && npm run build
#   /admin/ is the default; do NOT pass ADMIN_BASE_PATH on Git Bash - MSYS
#   rewrites it to a Windows path and the SPA ships with unreachable asset URLs.

cd ../Gym-frontend
rm -rf public/admin && mkdir -p public/admin
cp -r ../Gym-Admin/build/. public/admin/
vercel deploy --prod          # remote build; do NOT use --prebuilt

cd ../Gym-Server
vercel deploy --prod          # deploys the API project only
```

`Gym-Admin/build/` is committed, so `git checkout -- build/ && git clean -fdq build/`
afterwards to keep the diff clean.

### Verifying a deploy

`Gym-Admin/scripts/e2e/gate.mjs` is the browser half of the plan's per-phase
gate. It is a **gate**, not a report: every check sets a non-zero exit code.

```bash
cd Gym-Admin
SA_EMAIL=... SA_PASS=... npm run e2e -- --base https://mid-city-gym.vercel.app
```

It can also be pointed at a local build (`--base http://localhost:3000`), which
is how the split was verified before it went to production - the rewrites proxy
to the real API project and `http://localhost:3000` is already in
`getCorsConfig`'s default allowlist, so login works end to end with no risk to
the live site.

It does **not** retry a failed login: three failures lock the account for 24h.

### Rolling back

The front end and API roll back independently:

```bash
vercel rollback <deployment-url>     # or promote a previous one in the dashboard
```

The pre-split monolith deployments are still in the front-end project's history
and still work, because that project retains the old env vars.

## Known gaps

- **Existing uploads do not migrate themselves.** Files on the VPS under
  `uploads/` are referenced by relative paths in Mongo. `/uploads/*` is proxied
  to the API project for parity, but nothing there serves them either. Either
  copy them into Blob and rewrite the rows, or keep the old host serving them.
- **The Blob store is public.** Member photos and ID proofs are reachable by
  anyone with the URL, guessable only by UUID. This matches the current disk
  deployment, which serves `/uploads/**` publicly - but it is worth revisiting
  for ID proofs specifically, which is exactly the kind of document that should
  not be a permanent public object.
- **Deleting a member's file leaves the Blob object behind.**
  `deleteFileIfExists` in `company.controller.js` tests `fs.existsSync` on what
  is now a URL, so it silently does nothing.
- **The API project is publicly reachable** at `mid-city-gym-api.vercel.app`.
  CORS and auth are the gate, not network isolation; the plan calls it an
  "internal" URL but Vercel gives it a public hostname. Vercel's Deployment
  Protection covers preview URLs, not the production alias.
- **The legacy FTP/PM2 target serves the admin build at the domain root**, not
  `/admin`. If you keep that deployment alive, build it with
  `ADMIN_BASE_PATH=/`, or every asset 404s.
- The pre-existing issues in the repository `CLAUDE.md` are unchanged and are
  now internet-facing: the unauthenticated CMS write routes and the
  `set-password` / `portal-access` member routes, plus `.env` being committed.
