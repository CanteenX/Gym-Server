# Mid City Gym — Execution Checklist

Companion to `plan.md`. Tick items in order within a phase; a phase is complete
only when its **Gate** block is fully ticked. Deferred items get a one-line
reason next to them rather than being silently unticked.

Sequence: **0 → 6 → 1 → 2 → 4 → 3 → 5**

## Status — 2026-09-13

> **Production gate is FAILING — do not treat this checklist as finished until
> that gate is green.** See the top of `HANDOFF.md` for both causes and how to
> diagnose them: (1) unnamed form controls, almost certainly a stale admin
> bundle from a superseded deploy; (2) a real React hydration mismatch (#418) on
> `/contact` and `/programs`. First work after reading this file: apply the
> branch-role seed, build the `/cms/*` admin screens, fix #418.


| Phase | Code | Gate | Live |
|---|---|---|---|
| 0 — deployment split | done | passed | **live** |
| 6 — login page | done | passed | live |
| 1 — CMS, adverts, leads | done | passed | live |
| 1b — repeatable CMS content | done | passed | live |
| 2 — SEO + SEO Manager | done | passed | live |
| 4 — attendance, reports, audit | done | passed | live |
| 3 — QR check-in + trainer login | done* | passed | live |
| 5 — booking + reminders | done | passed | live |

\* three items from the original Phase 3 list did not ship — see the section
after Phase 3.

**Deployment works.** An earlier entry here claimed the Vercel account was
restricted, because the account object carries `limited: true` and one
production deployment came back `BLOCKED`. That was wrong: `limited` is the
Hobby-plan flag, not a block — it was equally true minutes earlier when a
deployment succeeded. The `BLOCKED` was a single transient failure. Proven by
re-running it: a preview deploy is `READY` and the API deployed to production
through CI in 52 s with a green smoke test.

`Gym-Server` is pushed and live. `Gym-Admin` and `Gym-frontend` are committed
locally and deploy together — the front-end deploy is the **switch-over**, the
moment `mid-city-gym.vercel.app` starts serving the new Next app with `/api`
proxied to the API project.

Verified against the real database throughout: the full stack runs locally
(Express + Next + the admin SPA), the browser gate passes at **42 checks**, and
`npm run test:unit` is **122/122**.

---

## Decisions

- [x] Phase 6 brand panel: **A** gradient — chosen by owner 2026-09-13. No open decisions remain.
- [x] Repeating content model: a `SiteItem` collection keyed by `collectionKey`, decided 2026-09-13 rather than the `program-1…n` sectionKey convention — the latter breaks ordering, validation and the editor UI.

---

## Phase 0 — Deployment split — DONE except the live deploy itself

Commits: `8a98492` (server) · `3791263` (admin) · `1bf3141` (frontend)

Both Vercel projects exist and are configured, both CI workflows are written
and their secrets are set, and the whole split is verified end to end on a
local production build. The only unfinished item is pushing it live, which the
account restriction prevents.

**Deviation from the plan, deliberate.** The plan said create a *new* project for
the front end and give it the domain. `mid-city-gym.vercel.app` is Vercel's
auto-assigned hostname for the project *named* `mid-city-gym` and cannot be
moved, so that path meant renaming and a window where the public URL 404s.
Instead: the **existing** project was repurposed as the front end (keeping both
its id and its hostname, so `VERCEL_PROJECT_ID` did not even change) and a new
`mid-city-gym-api` was created for the API. See `DEPLOYMENT-VERCEL.md`.

Frontend
- [x] Remove `output: "export"` from `next.config.ts`; remove `images.unoptimized`
- [x] Add `/api/:path*` rewrite → API project (also `/api-docs*`, `/uploads/*`)
- [x] Add `/admin` **and** `/admin/:path*` → `/admin/index.html` (in `afterFiles`, so real assets win). Both sources are needed: Next does not serve `public/admin/index.html` at bare `/admin`
- [x] `API_INTERNAL_URL` set on the front-end project. `NEXT_PUBLIC_API_URL` deliberately **not** set — `src/lib/api.ts` already defaults to `""` in production, and setting it invites the empty-string quoting bug
- [x] Confirm `fileUrl()` still passes absolute Blob URLs through

Vercel
- [x] Front-end project = existing `mid-city-gym` (`prj_w6f7sEft…`), framework switched to `nextjs`, `buildCommand`/`outputDirectory` overrides **cleared** (a project-level override beats `vercel.json`, so `next build` would never have run)
- [x] API project = new `mid-city-gym-api` (`prj_pjpOziG9…`), `regions: ["bom1"]`, all 11 runtime env vars copied
- [x] API `vercel.json`: static rewrites for `/admin` removed; a throwaway `public/` **kept on purpose** — with `framework: null` and no output dir, Vercel serves the repo root and would publish the committed `.env`
- [x] API env: `ALLOWED_ORIGINS` = public domain (already correct); `trust proxy` unchanged
- [x] `public/` is untracked and gitignored in `Gym-Server` — nothing to unwind
- [x] API project verified standalone: `/api` → `"database":"Connected"`, protected route → 401, `.env`/`server.js`/`package.json` not served as source

CI
- [x] `Gym-frontend` workflow: build `Gym-Admin` → `public/admin/`, `check:icons` gate, deploy front-end project, smoke test
- [x] `Gym-Server` workflow: deploys the API project **only**, via `VERCEL_API_PROJECT_ID` (reusing `VERCEL_PROJECT_ID` there would deploy the API over the public site)
- [x] Repoint `repository_dispatch` in `Gym-Admin` → `Gym-frontend`; delete the now-obsolete `Gym-frontend/trigger-deploy.yml`
- [x] Smoke test targets the **public** domain: `/`, `/admin`, `/admin/`, a real `/admin/assets/*.js`, `/api` asserting `"database":"Connected"`, icon font
- [x] `/admin/` answers **308**, not 200 — Next redirects trailing slashes before rewrites. Smoke test uses `curl -sL` and asserts the final status
- [x] No `${{ }}` inside any `run:` block (checked programmatically)
- [x] Secrets: `VERCEL_API_PROJECT_ID` on `Gym-Server`; `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`/`VERCEL_TOKEN` on `Gym-frontend`

Harness
- [x] `Gym-Admin/scripts/e2e/gate.mjs` + `npm run e2e -- --base <url>`; `playwright` added as a devDependency; `.e2e-out/` gitignored
- [x] Rewritten as a real gate. The ~30 predecessor scripts had **no assertions at all** — every one printed and exited 0, so CI could never have used them

**Gate**
- [x] Code review — two parallel adversarial reviews; 0 CRITICAL, 6 HIGH, 7 MEDIUM, 5 LOW. All HIGH fixed:
  - [x] `set -euo pipefail` + `grep -o` with no match **aborted the smoke step at that line** — the run still went red but lost its own `::error::` diagnostic and skipped the icon-font check and `exit $fail`. Verified empirically, fixed with `|| true`
  - [x] No preflight on the deploy target. With `VERCEL_API_PROJECT_ID` unset and no committed `.vercel/` link, `vercel deploy --yes` **provisions a brand-new project** named after the checkout dir and deploys there — green CI, release lands nowhere. Added a fail-fast step to both workflows
  - [x] `req.ip` was the first choice for `LoginAttempt` + `geoip` in both login controllers, but it derives from the `trust proxy` hop count (1) and the split adds a hop — so the audit trail would record Vercel infrastructure instead of the visitor. Extracted `utils/clientIp.js` (left-most `x-forwarded-for`, hop-count independent) and wired all three capture sites to it, which also removed two helpers that disagreed
  - [x] Gate: the SPA-mount phase **collected page errors and discarded the buffer** — only a literally empty `#root` could fail it
  - [x] Gate: per-route `drain()` created a window (checks + screenshot + loop idle) in which events were attributed to the *next* route. Events are now tagged with the active route at capture time and judged once at the end
  - [x] Gate: console + response listeners double-counted the same failed request, and the browser's own `Failed to load resource` echo carries no status — so a routine anonymous 401 on `/auth/verify-session` read as fatal. Added a severity split (pageerror / 5xx / requestfailed fatal; 401/403/404 notes) and drop the browser echo the response listener already covers
- [x] MEDIUM/LOW addressed: `.env*` and `.build` excluded from the Vercel uploads (defense in depth, not relying on routing); `beforeFiles` `/api` shadowing of future Route Handlers documented in `next.config.ts`; the inaccurate "both `/admin` rules required" comment corrected (`:path*` does match zero segments — the rule is kept as belt-and-braces, not necessity); `aria-labelledby` now requires non-empty text; `effectiveBg` walks up to `<html>`
- [x] Reviewer confirmed independently: cookie survives the proxy host-scoped to the public domain, `sameSite: lax` still correct, and `*.vercel.app` on the Public Suffix List means the session cookie can never reach the API project's own hostname
- [x] Contrast remains **report-only by default** (`--enforce-contrast` to bite) — a deliberate, documented hole, because the Velzon template ships pre-existing low-contrast greys
- [x] Browser (local build, `--base http://localhost:3000`): **GATE PASSED**, 33 checks, 0 failures — staff login 1086 ms, `sessionId` httpOnly/sameSite=Lax set through the rewrite, `/admin` and `/admin/` both mount, menus load, 1440 + 390 px screenshots
- [x] Browser: zero page errors across 3 marketing + 9 admin routes; unnamed form controls 0; nameless buttons 0; no overflow at 390 px
- [x] Gate re-run after the review fixes: **GATE PASSED**, 34 checks, exit 0. The overflow detector was proved to have teeth (injected 900px element → detected; wide content inside `overflow-x:auto` → correctly ignored)
- [x] Live smoke green on public domain — deployed 2026-09-13
- [ ] `/menus/by-groups` and `/auth/me` still ≈ 250 ms (bom1 colocation intact) — measure after the live deploy
- [ ] **Confirm the recorded login IP is the visitor's**, not Vercel infrastructure. Log in on the live site, then read the newest `LoginAttempt.ipAddress`. `x-forwarded-for[0]` is the best signal available in-process, but whether the API's edge preserves or overwrites that header across the proxy hop could not be determined without the live topology. If it comes back as infrastructure, the fix is for the front end to forward the original explicitly in a custom header

Pre-existing defects found by the new gate and fixed here (not introduced by Phase 0):
- [x] 14 form controls with no accessible name (search inputs on members/trainers/membership-plans/employee/cash-flow, the trainers branch filter, 9 unassociated `Label`/`Input` pairs on profile)
- [x] 1 nameless icon-only button (cash-flow refresh)
- [ ] Employee-roles placeholder text at 3.95:1 (needs 4.5:1) — reported by the gate, not enforced; fix when that screen is next touched

---

## Phase 6 — Admin login page (3–4 h) — DONE except live deploy

- [x] Left panel: `linear-gradient(135deg, $navy-900, $navy-700)` (`#14213d → #22346b`) as a static rule in `custom.scss`. Verified in-browser. Not routed through `themeType` (default `solid` would flatten it) and not in `pages/_authentication.scss` (`app.scss` imports before `custom.scss`, so `$navy-*` is out of scope there and the build would fail)
- [x] Pure-CSS hairline texture + radial highlight; no external requests
- [x] White rounded logo tile — 269×100 at 22 px radius, logo rendered 210×57. Sized for the 260×70 wordmark rather than a square, which would letterbox it
- [x] Headline + subcopy; branch chips restyled for a dark ground
- [x] Right panel: tinted `#f3f4f9` ground; form in a floating white card, 16 px radius, navy-tinted shadow
- [x] Untouched and verified by grep: `#email`, `#password-input`, both `htmlFor`, both `autoComplete`, both `name`, `.auth-pass-inputgroup`, `<Form onSubmit>`, `type="submit"`
- [x] Not added: consent checkboxes, `confirm()`, geolocation (0 matches)
- [x] Card logo un-letterboxed — was a 260×70 wordmark in a 100×100 box, now 160×43
- [x] Latent bug fixed: the 768–991 px query set `.right-panel` to 50% while the left panel was already hidden by `d-none d-lg-flex`, leaving tablets a half-width form beside dead space. Breakpoint now matches Bootstrap `lg`

**Gate**
- [x] Code review — implemented by subagent, independently verified: form contract intact, only 2 files touched, SCSS compiles, geometry and colours measured in-browser rather than taken on trust
- [x] Browser: **GATE PASSED** (34 checks). Enter-to-login works (1343 ms), `sessionId` httpOnly set, 0 page errors, no overflow at 1440 or 390 px, screenshots captured
- [x] Contrast measured against **both** gradient ends: worst new pair 8.52:1 against a 4.5 requirement; headline 11.85–15.97:1
- [x] Claim checked and rejected: the subagent reported `.text-muted` at 3.43:1, but `custom.scss` already overrides it to `#6b7280` — measured **4.83:1**, passing. No change needed
- [x] Live smoke — deployed; CI smoke step green on the public domain

---

## Phase 1 — CMS, adverts, contact form, leads (8–12 h) — DONE except live deploy

Server
- [x] `services/mailService.js` extracted; OTP **and** `test-email.js` now use it — there was a second inline transport nobody had noticed. Exactly one `createTransport` in the repo
- [x] `EmailSetup` seeded for `nventra01@gmail.com` (Mongo only; password read from `GMAIL_APP_PASSWORD` at seed time, never committed). **Verified by sending a real email** — delivered in 3.6 s
- [x] Models: `SiteContent`, `Advertisement`, `Lead`
- [x] `GET /api/v1/site/content`, `GET /api/v1/site/ads` (public reads)
- [x] Authenticated writes behind `checkPermission` — 14 routes, verified no duplicates or shadowing across all 223 routes
- [x] `POST /api/v1/site/leads`: `authRateLimiter` + honeypot + strict validation. **Verified**: valid → 201 saved; `website:""` and whitespace-only → saved (the form always sends an empty string, so treating key-presence as bot traffic would discard every real lead); filled honeypot → identical 201 but nothing persisted; missing phone → 400; unauthenticated admin list → 401
- [x] Lead notification → `nventra01@gmail.com`, awaited behind an 8 s race (a detached promise never resolves on Vercel), lead saved first so dead SMTP costs latency not data
- [x] Advert creatives via `secureUpload` → `persistBuffer` (no new path)
- [x] `services/siteRevalidate.js` — the **server** calls the site's revalidation hook. The admin SPA cannot: `revalidatePath` is a Next server function and the secret would be in page source
- [x] Unattributed leads (`branch: null`) visible/editable from any branch — the common case for a website enquiry; scoping them away would leave branch staff an empty inbox
- [x] Menu seed does **not** blanket-grant to every role (least privilege); super admins bypass `checkPermission` anyway. `--grant-all` restores the old behaviour

Admin
- [x] Website menu group seeded: Pages, Adverts, Leads inbox — verified rendering in the sidebar
- [x] Lead inbox: status, assignedTo, notes (note author taken from the session, never the body)
- [x] Write buttons mirror the server's ADMIN bypass. Caught in browser testing: the least-privilege seed left the owner looking at an empty state telling them to click an "Add Advert" button that was never rendered

Frontend
- [x] Marketing sections read `SiteContent` server-side; pages stay **prerendered** so crawlers get complete HTML
- [x] Every section falls back to shipped copy — an API blip renders today's site, not an error page. Verified by building against a dead host
- [x] Advert slots render by placement, active window respected
- [x] Contact form posts to the leads endpoint with honeypot, loading/success/error states
- [x] ISR on-demand + 60 s backstop. `revalidatePath` alone is insufficient — it drops the HTML but leaves the tagged fetch, so the page re-embeds the old rows; the hook clears tags too
- [x] Hook lives at `/internal`, not `/api` — `beforeFiles` would proxy an `app/api` handler away to Express

**Gate**
- [x] Code review — three parallel agents; every cross-repo integration claim re-verified rather than trusted. Two agent-reported "bugs" (honeypot empty-string, `CONTACT_FORM` source) were checked and found already correct
- [x] **Full stack run locally** (Express + Next + admin SPA): create → **live on the prerendered page immediately**; update → propagates; delete → removed and fallback copy restored. All via `curl` with no JS executed, which is the SEO property that matters
- [x] Browser: **GATE PASSED**, 37 checks, exit 0, including the three new screens — 0 unnamed controls, 0 nameless buttons, 0 zero-width icons, no overflow at 390 px
- [x] Spam attempt rejected (verified above)
- [x] Live smoke — deployed; CI smoke step green on the public domain

Known gaps carried forward (not defects, decisions needed):
- [ ] Repeating content — the six programme cards, timetable, trainers, pricing, FAQs, testimonials — is still hardcoded in `src/lib/site.ts`. `SiteContent`'s flat shape cannot express structured records. Needs either a repeatable-items model or a `program-1…n` + `sortOrder` convention
- [ ] `SiteContent.imageUrl` is free text in the editor; the server exposes an additive `POST /site/content/:id/image` that the admin does not yet use
- [ ] `pageKey: "about"` has no route of its own; the revalidation hook maps it to `/`
- [ ] An undocumented `sectionKey: "seo"` drives meta title/description — Phase 2 should formalise this

---

## Phase 2 — SEO + page-wise SEO Manager (10–14 h) — DONE except live deploy

Commits: `0c84403` (server) · `eb97650` (admin) · `ad9ded9` (site)

Site-wide
- [x] `sitemap.xml` — **verified**: contains exactly `/`, `/programs`, `/contact`. Filters on membership of the marketing route table rather than on whatever the API returns, so an active row pointing at a route we do not serve cannot publish a URL (tested with a hostile `/evil` row)
- [x] `robots.txt` — disallows `/admin`, all six portal routes, `/internal/`, `/api/`
- [x] JSON-LD per branch — `["ExerciseGym","LocalBusiness"]`, real phones, **per-branch** opening hours (they genuinely differ: Vasna Mon–Sat 05:00–23:00, Gotri 05:30–22:30). `Organization` + `WebSite` + `parentOrganization` linkage. Driven from `site.ts`, so the `Common / Shared Costs` accounting row can never be published as a gym
- [x] Canonical URLs per page; `next/image` sizing pass
- [x] `noIndex` deliberately **not** mirrored into `robots.txt` — disallowing a URL stops the crawl, which stops the crawler seeing the `noindex` tag, so a blocked page can be indexed URL-only and then never de-indexed

Manager
- [x] `SeoMeta` model (slug unique, noIndex, isActive, …)
- [x] 9 rows seeded — 3 marketing + **6 portal with `noIndex: true`**; content is real, not placeholder (home: 35-char title, 135-char description)
- [x] Pane 1: searchable list, category chips, add/edit/delete, completeness as **word + "N of M checks pass"**, never colour alone
- [x] Pane 2: counters amber at 90% / red past 60 & 160, keyword chips, canonical validated, OG block
- [x] Pane 3: score with clickable rules that focus the offending field; Google preview **mobile (50/120) vs desktop (60/160) toggle**; social card
- [x] Icon field uses the existing `IconPicker`
- [x] `generateMetadata()` reads `SeoMeta` via `API_INTERNAL_URL`, falling back to shipped copy. Verified by building against a dead host
- [x] Saves revalidate; a re-pointed slug revalidates **both** old and new, or the old route keeps serving metadata it no longer owns
- [x] `/seo-manager` `MenuMaster` row seeded (least-privilege, no blanket grant)
- [x] Precedence settled: `SeoMeta` beats the Phase 1 `sectionKey: "seo"` row **all-or-nothing**, so a page can never take its title from one editor and its description from another

**Gate**
- [x] Code review — three agents; every cross-repo claim re-verified
- [x] Browser: **GATE PASSED**, 38 checks. Edited a meta title → live page `<title>` changed immediately (via `curl`, no JS), then restored to seeded values
- [x] Fixed a **client/server contract mismatch**: the editor accepted a `localhost` canonical that the server rejects, so every save in local dev would have 400'd on a field the editor never touched
- [x] Fixed a **clipped destructive action**: the SEO table ran 58 px past its scroll container at 1440 px, hiding *Delete*. The gate missed it — it only checks clipping at 390 px and the table is inside `.table-responsive`. Actions are icon-only now with aria-labels naming their page
- [x] Two pre-existing bugs fixed in passing: portal title shipped as `Member Portal · Mid City Gym · Mid City Gym`; portal had no `robots: noindex`
- [x] Live smoke — deployed; CI smoke step green on the public domain

Open item for the owner:
- [x] **Two postal addresses and map pins** — owner decided to leave them omitted. The JSON-LD carries only real data (name, phone, locality, region, country, per-branch opening hours); no street address or coordinates are invented. **Original note: `streetAddress`, `postalCode` and `geo` are omitted from the JSON-LD because they exist nowhere — the `Branch` documents hold `address: ""` for both gyms. Nothing was invented. `Branch.streetAddress`/`postalCode`/`geo` in `src/lib/site.ts` are typed and documented; filling them emits the keys with no other change

---

## Phase 1 carry-forward — repeatable CMS content — server DONE

- [x] `SiteItem` model: programmes, plans, FAQs, trainers, class grid, testimonials, transformations — the structured records `SiteContent`'s flat shape cannot express
- [x] **48 rows seeded from the content the site already ships**, so the editor opens with real data
- [x] `fields` is `Mixed`, not a Mongoose `Map`: a Map read through `.lean()` serialises to `{}`, and the public read *is* `.lean()`, so every row's extras would blank in production while passing any test that skipped it
- [x] `fields` validated against a per-collection allowlist — a typo like `pirce` is a 400 naming the key, not a silently blank price
- [x] `classes` flattened from a positional grid to 24 one-per-cell rows, keyed on `(collection, title, day, time)` because "Zumba" is five separate cells
- [x] Admin editor screen — Content Lists tab in /website-pages
- [x] Frontend switchover — all seven collections read from the CMS, constants kept as fallback

---

## Phase 4 — Visibility: attendance views, reports, exports, audit log — DONE except live deploy

Commits: `fd68998` (server) · `44abe39` (admin)

- [x] `GET /api/v1/attendance/{footfall,live,not-checked-in}` — staff routes, branch-scoped. **None existed before**: members checked in through the portal and no staff could see any of it
- [x] Admin Attendance Overview. Wording holds throughout: "Members to call — no check-in logged", column "Last logged check-in", never-checked-in reads "Never logged one / Portal may not be set up". The word "visited" appears nowhere, because attendance is self-reported and the data cannot support that claim
- [x] Reports: collections by month/branch, expiry pipeline, member ageing, P&L with `"Common"` isolated — **verified live**: `branches: [Gotri, Vasna]`, `common` and `consolidated` separate keys
- [x] The consolidated card states up front that it will **not** equal the branch nets added together, and shows that sum inline — so the discrepancy is explained rather than discovered
- [x] `common`/`consolidated` are `null` for a branch admin and are never rendered as zero; the panel explains the costs were never charged to that branch, so nothing is missing from it
- [x] Exports: `ExportCSVModal` revived. **Root cause of it being dead code found**: it imported `react-csv`, which is not in `package.json`, so every render threw at import time. CSV is assembled inline now with formula-injection prefixing, so a member name starting `=` or `+` cannot execute in Excel
- [x] Exports require the **print** permission, not read — a screen stays on screen, a CSV leaves the building
- [x] `AuditLog` + `AsyncLocalStorage` actor plumbing + admin viewer. **Verified live**: a test write recorded `UPDATE | SiteItem | actor: Mid City Gym | fields: subtitle`
- [x] `Insights` menu group seeded (least-privilege, no blanket grant)
- [x] Six indexes added, including `memberId` on `Transaction` which had **none** — the member-ageing `$lookup` was a collection scan per member

**Two bugs the agent found while testing its own work**
- [x] Redaction ran **before** the diff, so a password change collapsed to `[REDACTED]` vs `[REDACTED]`, compared equal, and wrote **no row at all** — the event most worth recording was the one silently missing
- [x] A global mongoose plugin **does** reach child schemas, so `Member.payments[]` emitted a row per subdocument until the hooks guarded on `$isSubdocument`

**Tests**
- [x] `npm run test:unit` — **33/33 pass**, no DB required. Proves a Gotri admin asking for `?branch=Vasna` or `?branch=Common` still gets `{branch:"Gotri"}` on every one of footfall / live / not-checked-in / collections / P&L / expiry / ageing / all three exports / audit list; a super admin is unrestricted
- [x] P&L asserts `branches[]` never contains Common, that Common's expense does not land in a branch, and that `splitCommon` drops Common rows even if a bypassed helper returned them

**Gate**
- [x] Code review — every financial claim re-verified against the live DB rather than taken from the report
- [x] Browser: **GATE PASSED**, 41 checks, all three screens swept
- [x] Charts carry a table alternative — a canvas is invisible to a screen reader and to the gate
- [x] Live smoke — deployed; CI smoke step green on the public domain

Carried forward:
- [ ] When Phase 3 adds `Attendance.subjectType`, these queries must filter on it or trainer shifts will appear in member footfall

---

## Phase 3 — QR check-in for members and trainers — DONE except live deploy

Commits: `4f3b31f` (server) · `87baa69` (admin) · `71a944a` (portal)

- [x] Trainer credentials, portal login, `requireTrainer` / `requirePortalUser`, staff set/revoke password
- [x] `requireMember` **deliberately NOT widened** — a trainer gets 403 on every member-only route (weight, workout, profile, payments). All 10 routes enumerated to prove nothing regressed. Only `scan` accepts either subject
- [x] Both token types share a signing key, so signature validity proves only "some portal user" — the guards check the `subjectType` claim. A legacy token with no claim defaults to MEMBER, so the deploy signs nobody out
- [x] `Attendance` gains `subjectType`, `trainerId`, `deniedReason`, `source`; migration run against the live DB
- [x] **Migration fixed a live landmine**: `memberId_1_date_1` was a *plain* unique index, which treats `null` as a value — the second trainer to check in on any day would have hit `E11000`. Mongoose will not rewrite an existing index when the schema changes; it logs a conflict and keeps the dangerous one
- [x] 16 `Attendance` call sites audited **by grep, not memory**. Five in Phase 4's staff views were keyed only on branch and date and would have counted trainer shifts as member footfall — silently, with no error. One aggregation collapsed every trainer into a single "unique member" (`$addToSet` on a null `memberId` has one value)
- [x] `branch.controller` deliberately left unfiltered, with the reason in a comment: it asks whether a branch name is still referenced, and a trainer shift references it identically
- [x] Printable per-branch QR, generated client-side as a single SVG path. **Round-tripped through an independent decoder** (encode → render → parse back → rasterise → `jsQR`), 24 cases, all byte-identical. Black-on-white is a scanner threshold, not a theme colour
- [x] Login redirect preserves `branch` and `src` — the whole point of the QR. The full path+query is encoded into one `next` value; left raw, the destination's own `&` parses as a param of `/login` and `src` is lost
- [x] `next` is allowlisted to five portal routes; 13 open-redirect attempts rejected
- [x] DENY copy points to reception, states the check-in was *flagged rather than counted*, and says plainly that nothing stopped them coming in. No occurrence of "refused", "denied entry", "verified" or "proof of attendance" anywhere
- [x] Scan endpoint rate-limited despite being authenticated — it writes on every call. First real consumer of `userRateLimiter`, unused since before this phase

**Bug found and fixed in passing**
- [x] The login page had **two competing navigators** — the already-signed-in effect and the submit handler both calling `router.replace`. The effect won, sending a first-time member past the forced password change to a screen they could not use; i.e. exactly the member most likely to be standing at the sticker

**Tests**
- [x] `npm run test:unit` — 49/49 (16 eligibility + 33 Phase 4, still green after the filter changes)
- [x] Guard/scan smoke 28/28; login smoke 15/15; portal browser harness 38/38 at 390 px; redirect logic 43/43
- [x] Browser: **GATE PASSED**, 42 checks

Known limits, by design:
- [ ] Trainers cannot check out — that route is member-only server-side, so a shift closes on the 480-minute sweep. The screen says so rather than hiding a missing button
- [x] ~~Denied scans surface only through the export~~ — CLOSED. `/attendance/live` now returns a `denials[]` array alongside `sessions[]`. Footfall still excludes them, and always will: a refusal is not an arrival

---

### Phase 3 — what the original checklist asked for and did NOT ship

Everything else on the original Phase 3 list is done and listed above. Two of
the three outstanding items are now closed (see below); the browser walk-through
with real accounts is the one that remains.

**Tests after closing them:** `npm run test:unit` — **144/144**, was 122/122.
22 new in `scripts/tests/attendanceOverride.test.mjs`, and one existing
assertion in `scoping.test.mjs` updated on purpose: `/attendance/live` now runs
four branch-scoped queries, not two.

- [x] `GET /api/v1/attendance/live?since=` — **implemented**, the cursor
  narrows to arrivals after a timestamp so the poll payload stays small
- [x] Admin arrivals polling — **implemented**, 30 s, re-entrancy guarded
- [x] **Denials surfaced first in the arrivals feed.** Built.
  `GET /attendance/live` now returns `denials[]` **first in the payload**,
  with `deniedNew` (since the cursor) and `deniedToday` (the day's total)
  beside it. It is the same endpoint and the same 30 s poll — a second
  endpoint would mean a second cursor, and two cursors drift.
  **The denial cursor is `updatedAt`, not `checkInAt`**: a repeat refusal
  updates today's row in place (the unique `{memberId, date}` index forbids a
  second), leaving `checkInAt` at the first refusal of the day, so a
  `checkInAt` cursor would lose every later attempt between polls. `$gte` not
  `$gt`, so the race against `serverTime` produces a duplicate (dedupe by
  `_id`), never a miss. `inGymNow`, `sessions`, `staleOpenSessions` and every
  footfall query are untouched — a refusal is not an arrival
- [x] **"Mark as allowed" override**, writing an `AuditLog` row. Built:
  `POST /api/v1/attendance/:id/mark-allowed`, staff session +
  `checkPermission("/attendance-overview", "edit")`, branch-scoped via
  `scopeFilter` spread LAST (a Gotri admin gets the same 404 for a Vasna row
  as for a missing one, so an id cannot be probed across branches).
  `deniedReason` is cleared — so all 16 `NOT_DENIED` call sites keep working
  unchanged — and the original is relocated into a new `Attendance.
  denialOverride` sub-document with the actor, the time and an optional note,
  so the row reads "was denied for EXPIRED, overridden by Gotri Manager at
  07:12" rather than looking like it was never refused. A refusal **from
  today** becomes a live session (the same upgrade `attendanceScan` performs
  on a re-scan); an older one has the refusal cleared but opens no session and
  keeps its `date`. The response says which, in `sessionOpened`. Idempotent:
  a second call finds nothing to do, writes nothing, and therefore emits no
  second audit row. The `AuditLog` row comes from the global mongoose plugin
  and is **asserted, not assumed** — the test pulls the real hooks off the
  real `Attendance` schema
- [ ] Grant `edit` on `/attendance-overview` to whichever role runs the front
  desk. `scripts/seedInsightsMenus.js --grant-all` deliberately still grants
  read only; a super admin needs no grant (checkPermission short-circuits for
  `role === "ADMIN"`)
- [ ] Browser-verify the end-to-end door flow with real accounts: active member
  → ALLOWED and the entry appears in the feed; expired member → DENIED with the
  reception message; trainer → `subjectType: TRAINER`. The logic is unit-tested
  (16 eligibility cases) and the portal flow is harness-tested (38 checks), but
  no real expired member has been walked through it against live data

---

## Phase 5 — Class booking and email reminders — DONE

Commits: `5b4ea12` (server) · `fb82744` (fix) · `0ac0c49` (admin) · `4f2543a` (website)

Booking
- [x] `ClassSession`, `Booking` models; capacity reserved with a conditional
      `findOneAndUpdate` whose filter carries the comparison, so Mongo evaluates
      and increments under one document lock. The 51st caller matches nothing,
      which *is* the "full" answer — one round trip, no transaction, no retry
- [x] **Proven under real concurrency, twice.** Offline: 200 simultaneous
      bookings against 50 seats → exactly 50 succeed. Against the live database:
      8 against 2 seats → exactly 2 succeed, `bookedCount` lands on 2
- [x] The suite runs the **naive read-then-write against the identical fake and
      asserts it oversells**, so it cannot pass vacuously
- [x] Reserve-then-insert with a compensating release, so a crash leaves the
      counter one too *high* — drift can only under-fill, never oversell
- [x] A `Booking` belongs to a member **XOR** a lead; the roster renders both
- [x] Public booking form with the contact form's honeypot; admin roster with
      attended / no-show / cancelled; `/class-sessions` menu seeded
- [x] Full loop verified live: created in admin → visible on the public page
      after revalidation → booked by a prospect with no account → roster 1/10
- [x] **Bug found by that test and fixed**: all attempts wrote a `Lead` reading
      "Booked: <class>", so six *refused* callers were recorded as holding a
      place and the front desk would have sent them to a full class. Capturing
      them is right — a refused prospect is worth calling — but the note now
      reads "Tried to book" and is upgraded only once a seat is actually taken

Reminders
- [x] Vercel Cron in `vercel.json` → `POST /api/v1/jobs/reminders`
- [x] `CRON_SECRET` required; unset ⇒ **503, never open**. Verified live
- [x] Cohorts extracted from the dashboard so the two cannot disagree.
      Cross-checked against raw data: `Test Expiring Soon` (ends in 2 days) and
      `Test Payment Due` (expired **and** owes ₹1,200 — correctly in both)
- [x] `ReminderLog` prevents a double send; seven runs over a 7-day window
      produce one email; a failed send releases its claim so the next run retries
- [x] **Dry run by default.** Nothing in a *request* can switch sending on —
      only `REMINDERS_LIVE=true` on the server
- [x] Daily cap is 400, not Gmail's 500: the ceiling is account-wide and shared
      with OTP and lead mail, so exceeding it risks a lock that would take
      **OTP login down with it**

**Blocking issue for reminders, needs an owner decision**
- [x] **Members now have an email address** (deepmehta012@gmail.com, placeholder — owner will update). Dry run confirms wouldSend=3, noAddress=0, unreachable=0, so reminders reach members directly and the front-desk call list correctly stands down. **Live sending is still OFF** — set `REMINDERS_LIVE=true` on the API project when you want it to actually send.
- [x] ~~0 of 6 members have an email address~~ — resolved above. Original note: `mobileNumber` is required on
      `Member`; `email` is optional and unused — members sign in with a mobile
      number or a `loginId`. The scheduler is correct and skips them with
      `skippedNoAddress`, so today these emails reach **nobody**. SMS and
      WhatsApp were declined. Three ways forward: start capturing emails on the
      member form; reconsider a messaging channel (the scheduler is
      channel-agnostic by design, so it is a new module not a rewrite); or use
      the dry-run output as a staff call list, which works today with no new
      infrastructure. Recommended: the call list now, capturing emails alongside

Reminders
_(superseded — see the Phase 5 section above, which records what shipped.)_

---

## Next up — CMS navigation, one menu entry per page

Requested 2026-09-13, modelled on `marfatia.net/admin`, whose sidebar has a
**CMS** group listing pages rather than one screen: Home, About, Service (with
a submenu), Partner Page Settings, Pricing, FAQs, Contact Us, Footer, Header,
Content Management (submenu), Social & Media (submenu).

Ours currently has a single `/website-pages` screen with a `pageKey` tab strip
and a Content Lists tab. That is fewer clicks for us to build and more clicks
for the owner to use, and it does not scale as pages are added.

**Design, with the one gotcha that decides it.** Each CMS page needs a REAL
route and a REAL `MenuMaster` row. The cheap version — one screen with menu
rows pointing at `/website-pages?page=faqs` — does not work:
`MenuContext.findMenuIdByUrlInComplete` strips the query from the incoming URL
(`url.split('?')[0]`) but compares it against `menu.url` **un-stripped**, so a
row carrying a query string matches nothing, resolves to no `menuId`, and
`PermissionProtected` denies the route outright. Verified by reading
`src/context/MenuContext.jsx:409-458`.

**Server half — DONE** (admin and frontend halves are separate work).

- [ ] Routes `/cms/home`, `/cms/about`, `/cms/programs`, `/cms/pricing`,
      `/cms/faqs`, `/cms/trainers`, `/cms/testimonials`, `/cms/classes`,
      `/cms/contact`, `/cms/header`, `/cms/footer`, `/cms/social` — each
      rendering the existing editor scoped to its own `pageKey` or
      `collectionKey`. **Admin panel work, not started here.**
- [x] A "CMS" `MenuGroupMaster` with a row per page — `config/cmsMenus.js` holds
      the tree, `scripts/seedCmsMenus.js` creates it. Thirteen rows: nine
      top-level plus a `Content Management` parent (`menuUrl: "#"`,
      `isParent: true`) carrying the six repeating lists via `parentMenu`.
      Idempotent; `--grant-all` stays opt-in and grants read/write/edit, never
      delete
- [x] **Server permission follows the page.** `middlewares/cmsPermission.js`
      derives the menu URL from the `pageKey`/`collectionKey` the request
      actually touches and checks that. On PUT/DELETE/image the key is not in
      the request, so the row is loaded first — one projected `findById` on a
      write path, commented as such. A move (`pageKey`/`collectionKey` changed
      in the body) requires the permission for **both** ends, or "edit a FAQ"
      would be a way to write into `plans`
- [x] `/website-pages` is **kept and redefined as the "all CMS pages" grant** —
      checked as a fallback on every CMS write, so every role that works today
      keeps working, including in the window before `seed:cms-menus` is run (an
      unseeded `/cms/*` row simply does not resolve and the fallback carries the
      request). Adverts, leads and SEO Manager keep their own fixed permissions
- [x] Header, Footer and Social & Media given a home: `SiteContent` rows under
      new `pageKey`s `header` (brand, cta), `footer` (brand, explore, branches,
      legal) and `social` (one row per network). Social is `SiteContent` rather
      than a `SiteItem` list **because the footer addresses a network by name**
      and `SiteItem` has no unique index, so it would happily hold two Instagram
      rows. Only Instagram has real values; facebook/youtube/whatsapp are seeded
      blank and `isActive: false` because no such account exists anywhere in the
      repo and none was invented
- [x] `scripts/tests/cmsPermission.test.mjs` — 37 offline tests, no DB. Proves
      editing `faqs` checks `/cms/faqs` and never `/cms/pricing`, that a super
      admin bypasses before any lookup, that a move needs both ends, and pins
      `checkPermission`'s four outcomes after its refactor. `npm run test:unit`
      **122/122**
- [ ] Nothing on the frontend reads `header`/`footer`/`social` yet, so editing
      those three screens changes nothing on the live site until the frontend is
      wired to them. Nav links stay in `src/lib/site.ts` — they are a repeating
      list and want a `SiteItem` collection, not `header/link-1…n`
- [ ] `transformations` has no `/cms/*` screen (it was not in the twelve
      requested routes), so it still resolves to `/website-pages`

Upside worth having: per-page permissions become possible, so a staff member
can be allowed to edit FAQs without being able to touch pricing.

## Measured findings, not yet scheduled

- [ ] **187 unlabelled form controls across the admin panel.** Measured, not
  estimated: an audit mirroring the browser gate's rules (which correctly reject
  `placeholder` as an accessible name) over all 204 JSX files in
  `Gym-Admin/src`. The gate only sweeps the routes it is given, so it has been
  green while most of the panel went unaudited. Every screen built in Phases
  1–4 is clean; the older ones largely are not. This is real work touching
  screens no phase covers — scope it deliberately rather than folding it into
  an unrelated change.
- [ ] `Gym-frontend/src/app/(portal)/attendance/page.tsx` is 1226 lines against
  a 800-line guideline. It was 1085 before Phase 3, and the new work went into
  two separate components rather than growing it further. Splitting the calendar
  and session list out is its own refactor.

## Deferred (with reasons)

- SMS / WhatsApp reminders — no provider setup for now (owner decision); scheduler is channel-agnostic
- Payment gateway — all payment in the gym (owner decision)
- Rotating reception QR / geofence — static QR chosen; upgrade path documented in D2
- Dead template files (~1,300 KB / 93 files) — separate PR, away from concurrent merges
- Timestin dark re-theme — parked; tokens recorded in project memory
