# Vercel deployment (single domain)

**Live: https://mid-city-gym.vercel.app**

Three repositories, one Vercel project, one URL.

```
mid-city-gym.vercel.app
├── /            Next.js static export        Gym-frontend
├── /admin       Vite SPA                     Gym-Admin
└── /api/v1/*    Express serverless function  Gym-Server  (api/index.js)
```

Because all three are served from one origin, the admin's `express-session`
cookie is first-party and the member portal issues relative requests, so there
is no CORS configuration to maintain on this deployment.

## Status

Already done (Vercel project `nventra01-6027s-projects/mid-city-gym`):

- Project created and linked; `.vercel/project.json` holds the ids.
- Blob store `mid-city-gym-uploads` created and connected, so
  `BLOB_READ_WRITE_TOKEN` is injected into all three environments.
- Production env vars set: `DATABASE`, `SESSION_SECRET` (freshly generated -
  see below), `ADMIN_JWT_SECRET_KEY`, `EMPLOYEE_JWT_SECRET_KEY`,
  `MEMBER_JWT_SECRET_KEY`, `JWT_EXPIRY`, `RATE_LIMIT_*`, `AUTH_RATE_LIMIT_MAX`.
- Vercel's own Git integration is **disabled** (`git.deploymentEnabled: false`
  in `vercel.json`). It auto-connected on link and would otherwise build the
  repo with no `public/` assembled, shipping an empty site alongside CI.
- GitHub secrets set on `CanteenX/Gym-Server`: `VERCEL_ORG_ID`,
  `VERCEL_PROJECT_ID`, `DATABASE`.

Still required before the workflow can run:

| Secret | How to get it |
|---|---|
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens, **signed in as `nventra01@gmail.com`**. This, not anyone's local CLI login, decides where CI deploys. |
| `GH_PAT` | PAT with `repo` scope on the `CanteenX` org. Needed in **all three** repos: here to clone the siblings, and in each sibling to dispatch a deploy. |

`SESSION_SECRET` was absent from `.env` entirely, which is why `server.js` was
falling back to the string hardcoded at `server.js:135` - so production was
running on a secret committed to the repository. The Vercel value is a fresh
48-byte random one. **Rotate it on the PM2 host too**, and treat the old one as
compromised; every existing staff session signed with it stays valid until then.

## Why the pipeline assembles the build

Vercel's Git integration builds the one repository it is connected to. These are
three independent repos, so `.github/workflows/deploy-vercel.yml` in
**Gym-Server** checks out all three, builds the two front ends, lays them out
under `public/`, and deploys. `main` in Gym-Server is the release trigger;
`workflow_dispatch` lets you pin a different admin/frontend ref.

The deploy is a **remote** build (`vercel deploy --prod`, not
`vercel build` + `--prebuilt`). The API bundles native modules - `bcrypt` and
`sharp` - and a prebuilt deployment ships whatever binaries the builder
produced. Building on Windows failed outright with a bcrypt binding error, and
any runner whose platform or libc differs from the Vercel runtime risks the
same. Letting Vercel install on its own infrastructure removes that whole class
of failure; the front ends are still built in CI and uploaded in `public/`,
which the placeholder `buildCommand` leaves untouched.

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

## Menu seeding

`seedFaqMenus` / `seedHelpAndGuideMenus` used to run inline on every server
boot. A serverless container cold-starts constantly, so they now live in
`scripts/seedMenus.js`: the PM2 process still calls them at boot, and the
workflow runs `npm run seed:menus` once per release. Both are idempotent.

## What triggers a deploy

Any of the three repos. Pushing to `main` on Gym-Admin or Gym-frontend runs a
tiny `trigger-deploy.yml` in that repo which sends a `repository_dispatch` to
Gym-Server, carrying the pushed SHA so the deploy builds exactly that commit
rather than whatever `main` has become by the time it runs.

```
push Gym-Server/main     -------------------> Deploy to Vercel
push Gym-Admin/main      --dispatch-------->    admin_ref    = pushed SHA
push Gym-frontend/main   --dispatch-------->    frontend_ref = pushed SHA
manual workflow_dispatch -------------------> refs you choose
```

Deploys are queued, not cancelled (`cancel-in-progress: false`), so two pushes
landing close together both reach production instead of one discarding the
other.

Because of this, `GH_PAT` must exist in **all three** repositories: Gym-Server
uses it to clone the siblings, and the siblings use it to dispatch, since a
repository's own `GITHUB_TOKEN` cannot reach another repository.

## Running it

Push to `main`, or run the workflow manually. It builds, deploys, seeds menus,
then smoke tests `/`, `/admin/` and `/api`, failing the run if any is not 200.

To reproduce a deploy by hand:

```bash
cd ../Gym-frontend && NEXT_PUBLIC_API_URL="" npm run build
cd ../Gym-Admin    && npm run build   # /admin/ is the default; do NOT pass
                                   # ADMIN_BASE_PATH on Git Bash - MSYS rewrites
                                   # it to a Windows path and the SPA ships with
                                   # unreachable asset URLs (blank page).
cd ../Gym-Server
rm -rf public && mkdir -p public
cp -r ../Gym-frontend/out/. public/
mkdir -p public/admin && cp -r ../Gym-Admin/build/. public/admin/
vercel deploy --prod          # remote build; do NOT use --prebuilt
```

## Known gaps

- **Existing uploads do not migrate themselves.** Files on the VPS under
  `uploads/` are referenced by relative paths in Mongo. On Vercel those resolve
  to `/uploads/...` on the new domain, where nothing serves them. Either copy
  them into Blob and rewrite the rows, or keep the old host serving them.
- **The Blob store is public.** Member photos and ID proofs are reachable by
  anyone with the URL, guessable only by UUID. This matches the current disk
  deployment, which serves `/uploads/**` publicly - but it is worth revisiting
  for ID proofs specifically, which is exactly the kind of document that should
  not be a permanent public object.
- **Deleting a member's file leaves the Blob object behind.**
  `deleteFileIfExists` in `company.controller.js` tests `fs.existsSync` on what
  is now a URL, so it silently does nothing.
- **Unknown paths return 200 with the 404 page** (soft 404) rather than a 404
  status. Cosmetic, but it affects search engines.
- **The legacy FTP/PM2 target serves the admin build at the domain root**, not
  `/admin`. If you keep that deployment alive, build it with
  `ADMIN_BASE_PATH=/`, or every asset 404s.
- The pre-existing issues in the repository `CLAUDE.md` are unchanged and are
  now internet-facing: the unauthenticated CMS write routes and the
  `set-password` / `portal-access` member routes, plus `.env` being committed.
