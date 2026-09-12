# Mid City Gym — Execution Checklist

Companion to `plan.md`. Tick items in order within a phase; a phase is complete
only when its **Gate** block is fully ticked. Deferred items get a one-line
reason next to them rather than being silently unticked.

Sequence: **0 → 6 → 1 → 2 → 4 → 3 → 5**

---

## Decisions

- [x] Phase 6 brand panel: **A** gradient — chosen by owner 2026-09-13. No open decisions remain.

---

## Phase 0 — Deployment split (4–6 h)

Frontend
- [ ] Remove `output: "export"` from `next.config.ts`; remove `images.unoptimized`
- [ ] Add `/api/:path*` rewrite → project 2 internal URL
- [ ] Add `/admin/:path*` → `/admin/index.html` SPA fallback rewrite
- [ ] `API_INTERNAL_URL` env (server-side fetches) and `NEXT_PUBLIC_API_URL=""` (browser)
- [ ] Confirm `fileUrl()` still passes absolute Blob URLs through

Vercel
- [ ] Create project 1 from `Gym-frontend` (Next preset); attach `mid-city-gym.vercel.app`
- [ ] Project 2 (`Gym-Server`): keep `regions: ["bom1"]`, `api/index.js` only; remove `outputDirectory: public` and static rewrites from `vercel.json`
- [ ] Project 2 env: `ALLOWED_ORIGINS` = public domain; `trust proxy` stays on
- [ ] Remove `public/` assembly from `Gym-Server` (`.gitignore` entry, `.vercelignore`)

CI
- [ ] `Gym-frontend` workflow: build `Gym-Admin` → `public/admin/`, run `check:icons`, deploy project 1
- [ ] `Gym-Server` workflow: deploy project 2 only
- [ ] Repoint `repository_dispatch` in `Gym-Admin` → `Gym-frontend`
- [ ] Smoke test targets the **public** domain: `/`, `/admin`, `/admin/`, `/api`, icon font
- [ ] No `${{ }}` inside any `run:` block (re-run the YAML check)

Harness
- [ ] Move Playwright scripts into `Gym-Admin/scripts/e2e/`; `npm run e2e` works against a URL arg

**Gate**
- [ ] Code review — CRITICAL/HIGH fixed
- [ ] Browser: staff login sets `sessionId` through the rewrite; `/admin` and `/admin/` both render; member portal login works; 1440 + 390 px screenshots
- [ ] Browser: zero page errors, zero unnamed controls on login/dashboard/members
- [ ] Live smoke green on public domain; bundle hash changed; CDN given 2 min
- [ ] `/menus/by-groups` and `/auth/me` still ≈ 250 ms (bom1 colocation intact)

---

## Phase 6 — Admin login page (3–4 h)

- [ ] Left panel: `linear-gradient(135deg, $navy-900, $navy-700)` as a static login-page SCSS rule (not via `themeType`), low-opacity pattern, white rounded logo tile (~140 px, ~24 px radius)
- [ ] Headline + one line of subcopy; branch chips moved here
- [ ] Right panel: tinted ground; form in floating white card (12–16 px radius, navy-tinted shadow)
- [ ] Untouched: navy button, `#email`/`#password-input` ids, `autoComplete`, Enter-to-submit, panel hidden below `lg`
- [ ] Not added: consent checkboxes, `confirm()`, geolocation

**Gate**
- [ ] Code review
- [ ] Browser: Enter-to-login still works (278 ms baseline); white subcopy on panel ≥ 4.5:1; 1440 + 390 px screenshots; no overflow
- [ ] Live smoke green

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
