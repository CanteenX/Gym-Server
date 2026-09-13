# Mid City Gym — Execution Checklist

Companion to `plan.md`. Tick items in order within a phase; a phase is complete
only when its **Gate** block is fully ticked. Deferred items get a one-line
reason next to them rather than being silently unticked.

Sequence: **0 → 6 → 1 → 2 → 4 → 3 → 5**

## Status — 2026-09-13

| Phase | Code | Gate | Live |
|---|---|---|---|
| 0 — deployment split | done | passed | **blocked** |
| 6 — login page | done | passed | blocked |
| 1 — CMS, adverts, leads | done | passed | blocked |
| 1b — repeatable CMS content | done | passed | blocked |
| 2 — SEO + SEO Manager | done | passed | blocked |
| 4 — attendance, reports, audit | done | passed | blocked |
| 3 — QR check-in + trainer login | done* | passed | blocked |
| 5 — booking + reminders | in progress | — | — |

\* three items from the original Phase 3 list did not ship — see the section
after Phase 3.

**Everything is blocked on one thing, and it is not code.** The Vercel account
is in a restricted state (`limited: true`); deployments return `BLOCKED` with no
build logs at all. Check Usage/Billing at vercel.com. Until it clears, every
commit stays local and Phase 0's live smoke — the one gate nothing else can
substitute for — cannot run.

Nothing is broken in the meantime: the live site still serves the pre-split
deployment and is healthy on `/`, `/admin` and `/api`.

Verified locally instead, against the real database: the full stack runs
(Express + Next + the admin SPA), the browser gate passes at **42 checks**, and
`npm run test:unit` is **49/49**.

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
- [ ] Denied scans surface only through the export; the live and footfall endpoints exclude them server-side

---

### Phase 3 — what the original checklist asked for and did NOT ship

Everything else on the original Phase 3 list is done and listed above. These
three are genuinely outstanding, verified by reading the code rather than
assumed:

- [x] `GET /api/v1/attendance/live?since=` — **implemented**, the cursor
  narrows to arrivals after a timestamp so the poll payload stays small
- [x] Admin arrivals polling — **implemented**, 30 s, re-entrancy guarded
- [ ] **Denials surfaced first in the arrivals feed.** Not built. The live and
  footfall endpoints exclude denied rows server-side, so today a refusal is
  visible only through `exports/attendance?includeDenied=true`. D2 says these
  are the rows staff must act on, so they belong in the feed
- [ ] **"Mark as allowed" override**, writing an `AuditLog` row. Not built.
  Without it, a member wrongly denied at the door has no path to being fixed
  from the panel — reception can take payment, but the refusal stands in the
  record with nothing pointing at its resolution
- [ ] Browser-verify the end-to-end door flow with real accounts: active member
  → ALLOWED and the entry appears in the feed; expired member → DENIED with the
  reception message; trainer → `subjectType: TRAINER`. The logic is unit-tested
  (16 eligibility cases) and the portal flow is harness-tested (38 checks), but
  no real expired member has been walked through it against live data

---

## Phase 5 — Class booking and email reminders (10–14 h) — IN PROGRESS

Server half building now. Two things it must get right rather than approximate:
the capacity check has to be genuinely atomic (a read-then-write loses the race
and oversells the last slot), and reminders ship in **dry-run by default** so
the recipient list can be inspected before anything reaches a member's inbox.

Booking
- [ ] `ClassSession`, `Booking` models; **atomic** capacity check, proven under
      concurrency rather than reasoned about
- [ ] A `Booking` may belong to a member **or** a lead — a prospect with no
      account is exactly who books a free trial
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
