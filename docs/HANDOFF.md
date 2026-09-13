# Handoff — Mid City Gym, 2026-09-13

Read this first, then `todo.md` for the per-phase detail, `plan.md` for why the
work is shaped the way it is, and `deploy.md` for how to ship it.

## Where things stand

All seven planned phases are **code complete, gate green, and committed**.
Everything below was verified against the live database on a local production
stack (Express + Next + the admin SPA), not just built.

| Phase | State |
|---|---|
| 0 deployment split | done — front end deploy is the switch-over |
| 6 admin login page | done |
| 1 CMS, adverts, leads | done |
| 1b repeatable CMS content | done |
| 2 SEO + SEO Manager | done |
| 4 attendance, reports, exports, audit log | done |
| 3 QR check-in, trainer login, denials + override | done |
| 5 class booking, reminders | done |
| CMS per-page menus (owner request) | server done, **admin screens NOT built** |
| RBAC restructure (owner request) | done, **one seed not yet applied** |

`npm run test:unit` — **170/170**. Browser gate — **42 checks**, green.

## Production gate result — 2026-09-13, FAILING

The switch-over is live and healthy (`/`, `/admin`, `/api`, `/sitemap.xml`,
`/robots.txt` all 200; staff login 1531 ms; `sessionId` httpOnly set). But the
browser gate run against production **fails**, for two separate reasons. Re-run
it before trusting anything below:

```bash
cd Gym-Admin
SA_EMAIL=websupport@barodaweb.net SA_PASS=123456 \
  npm run e2e -- --base https://mid-city-gym.vercel.app
```

**1. Unnamed form controls on members / trainers / membership-plans / employee /
cash-flow / profile — almost certainly a STALE BUNDLE, not a regression.**
These were fixed in commit `bd21b23` (163 → 0) but the deploy carrying it was
still in flight when the gate ran; the previous run shows `cancelled` because a
newer push superseded it. Confirm by re-running the gate once the latest
`Gym-frontend` deploy is green. If they persist, the fix did not reach the
bundle and that is the thing to debug.

**2. React error #418 on `/contact` and `/programs` — REAL, and live now.**
Two `pageerror`s per page. #418 is a hydration text mismatch: the server-rendered
HTML and the first client render disagree. It does not blank the page, which is
why it went unnoticed, but React discards the server HTML for that subtree and
re-renders on the client — losing the SEO benefit those prerendered pages exist
for, on exactly the two pages the CMS feeds.

Most likely cause: something rendering non-deterministically between server and
client in the CMS-driven sections — a date/time formatted with the local
timezone, or the class timetable's derived day/time axes. Start at
`src/lib/site-lists.ts` (`buildScheduleGrid`) and the `class-picker` /
`class-booking` components added in `4f2543a`. Reproduce with
`npm run build && npm start` locally, then open `/programs` with the console
open — the non-minified dev build names the mismatching text.

## Do these first

1. **Apply the branch-role seed.** Written, tested, dry-run verified, NOT applied:
   ```bash
   cd Gym-Server
   npm run seed:branch-roles                          # dry run, writes nothing
   node scripts/seedBranchRolePermissions.js --apply
   ```
   It grants branch roles `/attendance-overview` (read), `/reports`
   (read+print) and `/class-sessions` (full). All three are already
   branch-scoped in the controllers, so it widens what a branch admin may *do*,
   never what they may *see*.

2. **Build the `/cms/*` admin screens.** The server half is finished and
   seeded: a 13-row CMS menu tree, per-page permissions, and header/footer/social
   content rows. The admin routes do not exist yet, so those menu entries lead
   nowhere. See the "Next up" section of `todo.md` — it records the design and
   the gotcha that drives it (`findMenuIdByUrlInComplete` strips the query from
   the incoming URL but not from `menu.url`, so a menu row carrying a query
   string resolves to no permission at all).

3. **`admin@barodaweb.net` is now a dead login.** It is a `CompanyMaster` with
   `isSuperAdmin: false`, so it no longer bypasses RBAC — and a CompanyMaster
   row has no `roleId`, so it has no permission set either. It gets
   "No permissions found for this role" on every gated screen. `CompanyMaster`
   now accepts an optional `roleId`; either set one, make it a super admin, or
   retire the account.

## Accounts

| Email | Kind | Branch | Password |
|---|---|---|---|
| websupport@barodaweb.net | Super Admin (CompanyMaster) | all | 123456 |
| nventra01@gmail.com | Branch Admin (Employee) | Vasna | 123456 |
| nventra011@gmail.com | Branch Staff (Employee) | Vasna | 123456 |
| nventra02@gmail.com | Branch Admin (Employee) | Gotri | 123456 |
| nventra021@gmail.com | Branch Staff (Employee) | Gotri | 123456 |

Verified live: both Vasna accounts get **200** on members and **403** on CMS and
the SEO Manager.

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

## Deploying

`deploy.md` has the full guide. Short version: push to `main`.
`Gym-frontend` builds the site **and** the admin panel; `Gym-Server` ships the
API only; `Gym-Admin` dispatches to `Gym-frontend`.

`VERCEL_PROJECT_ID` means the **front end** (it kept the original project when
the deployment split). The API uses `VERCEL_API_PROJECT_ID`.

An earlier note in these docs claimed the Vercel account was restricted. It is
not — `limited: true` is the Hobby-plan flag, and one `BLOCKED` deployment was
a transient failure. Deploys work; the API has since shipped to production
through CI in 52 s.
