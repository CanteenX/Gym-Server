# Mid City Gym — Execution Checklist

Companion to `plan.md`. Tick items in order within a phase; a phase is complete
only when its **Gate** block is fully ticked. Deferred items get a one-line
reason next to them rather than being silently unticked.

Sequence: **0 → 6 → 1 → 2 → 4 → 3 → 5**

---

## Decisions

- [x] Phase 6 brand panel: **A** gradient — chosen by owner 2026-09-13. No open decisions remain.

---

## Phase 0 — Deployment split (4–6 h) — IN PROGRESS

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
- [ ] **Live smoke green on public domain** — BLOCKED: production deploy not yet run
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
- [ ] Live smoke green — BLOCKED with Phase 0 on the Vercel account restriction

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
- [ ] Live smoke green — BLOCKED with Phase 0 on the Vercel account restriction

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
- [ ] Live smoke green — BLOCKED with Phase 0 on the Vercel account restriction

Open item for the owner:
- [ ] **Two postal addresses and map pins.** `streetAddress`, `postalCode` and `geo` are omitted from the JSON-LD because they exist nowhere — the `Branch` documents hold `address: ""` for both gyms. Nothing was invented. `Branch.streetAddress`/`postalCode`/`geo` in `src/lib/site.ts` are typed and documented; filling them emits the keys with no other change

---

## Phase 1 carry-forward — repeatable CMS content — server DONE

- [x] `SiteItem` model: programmes, plans, FAQs, trainers, class grid, testimonials, transformations — the structured records `SiteContent`'s flat shape cannot express
- [x] **48 rows seeded from the content the site already ships**, so the editor opens with real data
- [x] `fields` is `Mixed`, not a Mongoose `Map`: a Map read through `.lean()` serialises to `{}`, and the public read *is* `.lean()`, so every row's extras would blank in production while passing any test that skipped it
- [x] `fields` validated against a per-collection allowlist — a typo like `pirce` is a 400 naming the key, not a silently blank price
- [x] `classes` flattened from a positional grid to 24 one-per-cell rows, keyed on `(collection, title, day, time)` because "Zumba" is five separate cells
- [ ] Admin editor screen — in progress
- [ ] Frontend switchover — in progress. Until it lands the site still renders the hardcoded copy

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
- [ ] Live smoke green — BLOCKED with Phase 0 on the Vercel account restriction

Carried forward:
- [ ] When Phase 3 adds `Attendance.subjectType`, these queries must filter on it or trainer shifts will appear in member footfall

---

## Phase 3 — QR check-in for members and trainers (11–15 h)

Trainer auth (D4)
- [ ] `Trainer`: `loginId`, `passwordHash`, portal-access fields
- [ ] Portal login issues JWT with `subjectType`; `requirePortalUser` accepts member or trainer
- [ ] Admin: set/revoke trainer password (mirrors member flow)
- [ ] Key sets stay distinct from staff session

Data
- [ ] `Attendance`: `subjectType`, `trainerId`, `deniedReason`, `source`
- [ ] Migration: existing rows → `subjectType: "MEMBER"`, `source: "SELF"`
- [ ] Partial index `{ subjectType, branch, checkInAt }`
- [ ] Every existing attendance query filters on `subjectType`

Flow
- [ ] Admin generates printed QR per branch (`?branch=…&src=qr`)
- [ ] Portal login carries `branch`/`src` through the post-login redirect
- [ ] `POST /member-portal/attendance/scan`: eligibility → `ALLOW`/`DENY` + reason; attempt recorded either way; `source: "QR"`
- [ ] DENY screen points to reception (no dead end)
- [ ] `GET /api/v1/attendance/live?since=` (staff)
- [ ] Admin arrivals feed: polling with `since` cursor, pauses on hidden tab, denials first, **"mark as allowed"** writes `AuditLog`
- [ ] `MenuMaster` rows seeded

**Tests (required)**
- [ ] Eligibility rules: active → ALLOW; expired → DENY(EXPIRED); payment due → DENY(PAYMENT_DUE); inactive → DENY(INACTIVE); trainer → ALLOW

**Gate**
- [ ] Code review
- [ ] Browser (390 px, real phone-width): scan link as active member → ALLOWED + entry appears in admin feed; as expired member → DENIED with reception message + denial in feed; as trainer → entry with `subjectType: TRAINER`; logged-out scan preserves branch through login
- [ ] Admin feed updates without reload within the poll interval
- [ ] Live smoke green

---

## Phase 5 — Class booking and email reminders (10–14 h)

Booking
- [ ] `ClassSession`, `Booking` models; **atomic** capacity check
- [ ] Public booking form; admin roster; `MenuMaster` rows seeded

Reminders
- [ ] `crons` in `Gym-Server/vercel.json` → `POST /api/v1/jobs/reminders`
- [ ] Shared-secret check; cron secret in project 2 env only
- [ ] Cohorts: expiring 7d, expired, payment due (same logic as dashboard)
- [ ] `ReminderLog`; no double-send
- [ ] **Dry-run mode first** — log only, send nothing, until the list is inspected and approved

**Tests (required)**
- [ ] Concurrent bookings cannot exceed capacity
- [ ] A member in two cohorts receives one email; a second run sends nothing new

**Gate**
- [ ] Code review
- [ ] Browser: book the last slot, second attempt refused; admin roster correct; 1440 + 390 px
- [ ] Dry-run `ReminderLog` reviewed by owner before live sends enabled
- [ ] Live smoke green

---

## Deferred (with reasons)

- SMS / WhatsApp reminders — no provider setup for now (owner decision); scheduler is channel-agnostic
- Payment gateway — all payment in the gym (owner decision)
- Rotating reception QR / geofence — static QR chosen; upgrade path documented in D2
- Dead template files (~1,300 KB / 93 files) — separate PR, away from concurrent merges
- Timestin dark re-theme — parked; tokens recorded in project memory
