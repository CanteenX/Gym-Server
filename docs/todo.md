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

## Phase 1 — CMS, adverts, contact form, leads (8–12 h)

Server
- [ ] `services/mailService.js` extracted from `otp.controller.js`; OTP uses it
- [ ] Seed `EmailSetup` row for `nventra01@gmail.com` (app password in Mongo only — never `.env`, never docs)
- [ ] Models: `SiteContent`, `Advertisement`, `Lead`
- [ ] `GET /api/v1/site/content`, `GET /api/v1/site/ads` (public reads)
- [ ] Authenticated writes behind `checkPermission`
- [ ] `POST /api/v1/site/leads`: `authRateLimiter` + honeypot/Turnstile + strict validation
- [ ] Lead notification email → `nventra01@gmail.com`
- [ ] Advert creatives via `secureUpload` → `persistBuffer` → Blob (no new path)
- [ ] Saves call `revalidatePath()` on the affected route

Admin
- [ ] Website menu group: Pages, Adverts, Leads inbox; `MenuMaster` rows seeded
- [ ] Lead inbox: status, assignedTo, notes

Frontend
- [ ] Marketing sections read `SiteContent` at request time (ISR)
- [ ] Advert slots render from `Advertisement` (active window respected)
- [ ] Contact form posts to leads endpoint; success + error states

**Gate**
- [ ] Code review
- [ ] Browser: edit a page in admin → live within seconds without rebuild; upload an advert → visible on site; submit contact form → row in admin inbox + email received at `nventra01@gmail.com`
- [ ] Browser: spam attempt (honeypot filled / rapid repeats) is rejected
- [ ] Zero page errors; unnamed controls = 0 on new admin screens; 390 px no overflow
- [ ] Live smoke green

---

## Phase 2 — SEO + page-wise SEO Manager (10–14 h)

Site-wide
- [ ] `sitemap.xml` from routes + CMS pages; portal routes excluded
- [ ] `robots.txt`
- [ ] JSON-LD `LocalBusiness` per branch (Vasna, Gotri — real address, hours, geo)
- [ ] Canonical URLs; `next/image` sizing pass

Manager
- [ ] `SeoMeta` model (slug unique, noIndex, isActive, …)
- [ ] Seed rows for all marketing routes; `noIndex: true` seeded for the 6 portal routes
- [ ] Pane 1: searchable list, category chips, add/edit/delete, completeness label **with text, not colour-only**
- [ ] Pane 2: counters (amber near / red past 60 & 160), keyword chips, canonical (validated; defaults to route's absolute URL), OG block with thumbnail
- [ ] Pane 3: score with clickable rules → jump to field; Google preview **mobile/desktop toggle**; social card
- [ ] Icon field uses existing `IconPicker` (no free-text class)
- [ ] `generateMetadata()` per route reads `SeoMeta` via `API_INTERNAL_URL`; **sensible defaults when a row is missing**
- [ ] Save → `revalidatePath()`
- [ ] `MenuMaster` row seeded

**Gate**
- [ ] Code review
- [ ] Browser: edit meta title → `view-source` of the live page shows it; portal route has `noindex`; sitemap excludes portal; score rules jump to fields; 1440 + 390 px
- [ ] Any new icon: rendered width > 0; any new colour: ≥ 4.5:1
- [ ] Live smoke green

---

## Phase 4 — Visibility: attendance views, reports, exports, audit log (10–14 h)

- [ ] `GET /api/v1/attendance/*` staff routes (footfall per branch/day, in-gym now, not-checked-in-14d) — all through `scopeFilter`, filtered on `subjectType`
- [ ] Admin Attendance page; "not **checked in** for 14 days" label, framed as a call prompt
- [ ] Reports: collections by month/branch, expiry pipeline, member ageing, P&L with `"Common"` isolated
- [ ] Exports: revive `ExportCSVModal`; server-side CSV; `financialScopeFilter` applied
- [ ] `AuditLog` model + `AsyncLocalStorage` actor plumbing in early Express middleware + mongoose hooks + admin viewer
- [ ] `MenuMaster` rows seeded

**Tests (required)**
- [ ] Export as branch admin cannot include other branch or `"Common"` rows
- [ ] Super admin export includes `"Common"`; branch admin's does not

**Gate**
- [ ] Code review
- [ ] Browser: attendance page renders real data; export downloads and opens; audit viewer shows a change just made with the right actor; 1440 + 390 px
- [ ] Live smoke green

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
