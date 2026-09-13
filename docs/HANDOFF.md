# Handoff — Mid City Gym, 2026-09-13

Read this first, then `todo.md` for the per-phase detail, `plan.md` for why the
work is shaped the way it is, and `deploy.md` for how to ship it.

## Production gate — GREEN

```bash
cd Gym-Admin
SA_EMAIL=websupport@barodaweb.net SA_PASS=123456 \
  npm run e2e -- --base https://mid-city-gym.vercel.app
# GATE PASSED (2026-09-13)
```

`/`, `/programs`, and `/contact` serve **distinct** HTML. Staff login reaches
`/admin/dashboard`. No React #418 on the marketing routes. Local unit tests
remain green (`cd Gym-Server && npm run test:unit`).

### What fixed the earlier red gate

1. **Same home HTML for every path** — the public alias had been pointing at a
   wrong project overlay (API serverless + stale shell). Marketing is now a
   **static ship** from `next build` HTML + `_next/static` + `public/admin`,
   deployed to Vercel project **`mid-city-web`**, then aliased to
   `mid-city-gym.vercel.app`. Smoke checks require route-specific markers
   (`Train With Us`, `id="schedule"`, `Come see`), not status 200 alone.
2. **Admin client routes 404** — with `cleanUrls: true`, the SPA rewrite must
   target `/admin` (no `.html`). See `Gym-frontend/scripts/static-ship-vercel.json`.
3. **Hydration** — `page-header` / home `hero` always render the poster `Image`;
   `<video>` mounts only after client mount when motion is allowed.

**Trade-off:** static ship restores a green gate but **drops ISR / on-demand
revalidate** until remote Next builds on this Vercel account stop hanging in
`UNKNOWN`. A push still refreshes the snapshot. Workflow:
`Gym-frontend/.github/workflows/deploy-vercel.yml`.

---

## Do these first

Nothing blocking the checklist close-out. Remaining work is owner/deferred
(SMS, payments) or measured-but-unscheduled (187 unlabelled controls,
attendance page split, `.env` secret rotation). See `todo.md`.

Already done this pass:

- Branch-role seed **applied** (`npm run seed:branch-roles` then `--apply`).
- Twelve `/cms/*` admin screens shipped (locked wrappers around WebsitePages /
  SiteItemsManager).
- `admin@barodaweb.net` **retired** (`node scripts/retireDeadAdmin.js --apply`).
- Marketing chrome reads CMS `header` / `footer` / `social` with `site.ts`
  fallbacks (revalidate hooks still coded for when Next hosting returns).

---

## Where things stand

| Phase | State |
|---|---|
| 0 deployment split | done — live via `mid-city-web` + alias |
| 6 admin login page | done |
| 1 CMS, adverts, leads | done |
| 1b repeatable CMS content | done |
| 2 SEO + SEO Manager | done |
| 4 attendance, reports, exports, audit log | done |
| 3 QR check-in, trainer login, denials + override | done |
| 5 class booking, reminders | done |
| CMS per-page menus (owner request) | done — server + 12 admin `/cms/*` screens |
| RBAC restructure (owner request) | done — branch-role seed applied |

## Accounts

| Email | Kind | Branch | Password |
|---|---|---|---|
| websupport@barodaweb.net | Super Admin (CompanyMaster) | all | 123456 |
| nventra01@gmail.com | Branch Admin (Employee) | Vasna | 123456 |
| nventra011@gmail.com | Branch Staff (Employee) | Vasna | 123456 |
| nventra02@gmail.com | Branch Admin (Employee) | Gotri | 123456 |
| nventra021@gmail.com | Branch Staff (Employee) | Gotri | 123456 |

Verified live: both Vasna accounts get **200** on members and **403** on CMS and
the SEO Manager. Branch roles have `/attendance-overview` (read), `/reports`
(read+print), `/class-sessions` (full).

**`admin@barodaweb.net` is retired** (`isActive: false`). Live SA is
`websupport@barodaweb.net`. Do not re-activate or `--adopt-company-admins`
without an explicit owner decision.

**Linking trap, already hit once:** an `Employee` links to its permission set
via `EmployeeRoles.roleId` — the FIELD, not the document `_id`.
`checkPermission` does `findOne({ roleId })`. Linking to `_id` resolves to no
permissions and locks the account out of everything.

## How privilege works now

- `role` is **which table you logged in from** — `CompanyMaster` → `"ADMIN"`,
  `Employee` → `"EMPLOYEE"`. It is not a privilege level.
- **Privilege is `isSuperAdmin`.** `checkPermission` and `cmsPermission` both
  bypass on it and nothing else. `MenuContext` on the client matches.
- Everyone else is governed by their `EmployeeRoles` grants, branch-scoped by
  `middlewares/branchScope.js`.
- **22 menus are granted to nobody**, which is what makes them SA-only: all 12
  `/cms/*`, `/seo-manager`, `/website-*`, `/audit-log`. Grant them and they stop
  being SA-only — that is the intended control, not a bug.

## Known issues, measured not guessed

- **Privilege escalation gap.** `employeeRoles.controller.js` enforces "you
  cannot grant more than you hold" for `EMPLOYEE` but **not** for `ADMIN`. A
  CompanyMaster branch admin holding `/employee-roles` edit could grant
  themselves CMS. The branch-role seed deliberately withholds `/employee-roles`
  and `/role-master` because of this.
- **187 unlabelled form controls** across the panel's 204 JSX files, measured
  with the browser gate's own rules (`placeholder` is not an accessible name).
  Screens built in these phases are clean; older ones largely are not.
- **`test@gmail.com` has no branch**, which `scopedBranch()` reads as "all
  branches". Set one or deactivate it.
- **Email reminders reach nobody directly** — 0 of 6 members have an email
  address (`mobileNumber` is required, `email` optional). The job now emails the
  front desk a **call list** instead; members drop off it automatically once
  they have addresses.
- **`Gym-Server/.env` is committed** to a public repo with the live Mongo URI
  and every JWT secret. Excluded from the Vercel upload, so not web-reachable,
  but it is in git history.
- `attendance/page.tsx` is 1226 lines against a 800 guideline.
- **`/_next/image` 404s on the static ship** — image optimization is a Next
  runtime feature; static HTML still references `/_next/image?…`. Benign for
  the gate (not enforced); fix when Next hosting returns, or swap to direct
  image URLs / a CDN.

## Deploying

`deploy.md` has the full guide. Short version while Next remote builds hang:

1. `Gym-frontend` CI builds Admin into `public/admin`, runs `next build`,
   assembles `static-ship/` (HTML + `_next/static` + admin +
   `scripts/static-ship-vercel.json`), deploys with `vercel deploy --archive=tgz`
   to **`mid-city-web`** (`VERCEL_PROJECT_ID`), aliases `mid-city-gym.vercel.app`.
2. `Gym-Server` ships the API only (`mid-city-gym-api`).
3. `Gym-Admin` dispatches to `Gym-frontend` on push.

When Vercel Next builds work again, restore the previous Next project deploy
path so ISR and `/_next/image` return. Until then, treat each push as a full
static snapshot refresh.
