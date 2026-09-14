# Mid City Gym — Execution Checklist

Companion to `plan.md`. Tick items in order within a phase; a phase is complete
only when its **Gate** block is fully ticked. Deferred items get a one-line
reason next to them rather than being silently unticked.

Sequence: **0 → 6 → 1 → 2 → 4 → 3 → 5**

## Status — 2026-09-14 (updated same day: four items closed below)

**195 ticked · 5 open** (was 192 ticked · 8 open earlier today). Three items
closed under "Open — needs the owner" and "Open — known and accepted" in this
pass — trainer checkout, video upload, and the `about` pageKey/revalidation
decision — plus the separate `sectionKey: "seo"` documentation task (not one
of the original eight, added below its own heading). All closures are
test-backed: `scripts/tests/attendanceTrainerCheckout.test.mjs` (9),
`scripts/tests/secureUploadVideo.test.mjs` (19) and
`scripts/tests/cmsReservedKeys.test.mjs` (7) — `npm run test:unit` is
**336/336** (was 301/301). Remaining open items are listed once, below, and
nowhere else. Nothing open is blocking: **3** need an owner decision, **1** is
known and accepted, **1** is a small cleanup found while verifying this list.

Every phase is built, gated and **deployed**. The production browser gate is
green (`npm run e2e -- --base https://mid-city-gym.vercel.app`), `npm run
test:unit` is **301/301**, and `npm run audit:integrity` reports no problems.
Live marketing ships as a **static snapshot** to `mid-city-web` (aliased to
`mid-city-gym.vercel.app`) while remote Next builds hang — see `HANDOFF.md`.

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

\* two items from the original Phase 3 list remain, and **both are owner
decisions**, not unshipped work — see "Open — needs the owner" below. The third
(browser-verify the door flow with real accounts) was closed 2026-09-14.

`Gym-Server` (API) is live on `mid-city-gym-api`. Marketing + admin ship via
`Gym-frontend` CI as a **static snapshot** to `mid-city-web`, aliased to
`mid-city-gym.vercel.app` (remote Next builds currently hang — see
`HANDOFF.md`). Verified against the real database throughout.

### Closed 2026-09-14 (this pass)

- [x] **Trainers cannot check out — CLOSED.**
  `POST /member-portal/attendance/check-out` now runs behind
  `requirePortalUser`, not `requireMember` (`routes/v1/attendance.routes.js`).
  `checkOut()` (`controllers/v1/attendance.controller.js`) builds its
  `Attendance.findOne` filter from `req.portalUser` — `{subjectType:"TRAINER",
  trainerId}` for a trainer, `{subjectType:"MEMBER", memberId}` for a member —
  with no default branch, so a trainer's token can only ever match their own
  TRAINER row and a member's only their own MEMBER row. `check-in` stays
  `requireMember`, unchanged, on purpose — only the closing half of the
  product decision this bullet used to describe was actually blocked; opening
  a shift on someone's behalf was never asked for.
  `scripts/tests/attendanceTrainerCheckout.test.mjs` — 9 tests, including both
  cross-subject directions explicitly (a trainer can never close a member's
  session and vice versa) and that check-in's guard was left untouched.
- [x] **Video upload is not enabled — CLOSED, for the `media` collection ONLY.**
  `middlewares/secureUpload.js` gained `ALLOWED_MIMES.video` /
  `ALLOWED_EXTENSIONS.video` (`.mp4`/`.webm`/`.mov`, matching the bucket) and
  `FILE_SIZE_LIMITS.video` (50 MB, matching the bucket — NOT applied to
  images, which stay capped at 5 MB via `checkMediaSizeCap()`), plus
  `createSecureImageOrVideoUpload()`. It is wired on exactly one route —
  `POST /site/items/:id/image` — and only when `?slot=video`
  (`isVideoSlotRequest()`, `routes/v1/site.routes.js`); every other slot
  (poster, beforeImage, afterImage, none) keeps using the unchanged,
  images-only uploader. `"video"` is the only `FIELD_SPECS` key named that way
  (`models/SiteItem.js`, the `media` collection), so this is scoped to that
  collection by construction, not by convention alone. Magic-byte AND
  extension are both checked, and must AGREE ON FAMILY
  (`classifyMediaBuffer()`) — the direct answer to "a file claiming to be
  .mp4 whose magic bytes say otherwise must still be rejected": a JPEG renamed
  `clip.mp4` is rejected even though images remain an allowed type on this
  route, because its content is not the family its extension claimed. `sharp`
  is never invoked for a detected video (`prepareValidatedMedia()`) — the
  same corruption risk CLAUDE.md already records for PDFs. Generic uploaders
  (`createSecureUpload`, `guide.routes.js`, adverts, notices, site-content
  images) are unchanged and were swept by a regression test.
  `scripts/tests/secureUploadVideo.test.mjs` — 19 tests, magic bytes proven
  against REAL, hand-built minimal mp4/webm/mov container headers (verified
  against the installed `file-type` package, not mocked), including a real
  sharp WebP round-trip for the image path (RIFF/WEBP signature asserted on
  the output bytes).
- [x] **`pageKey: "about"` — decision recorded, not an accident. CLOSED.**
  Verified 2026-09-14: `Gym-frontend/src/app/internal/revalidate/route.ts`
  already maps `about: "/"` in its own `PAGE_PATHS` table, with its own
  comment explaining why ("about" has no page of its own — its blocks render
  inside the home page). That is the frontend half of this decision and it was
  already explicit, not guessed at; nothing there needed changing. The
  server-side gap was that `config/cmsMenus.js` documented `about` as
  RESERVED without saying anything about revalidation, so this pass added
  that cross-reference and a pinning test for the server's own contract:
  editing the LIVE about content (`pageKey:"home", sectionKey:"about"`, seeded
  and real) revalidates `{pageKey:"home"}` — the page a visitor actually
  sees — and a future standalone `pageKey:"about"` row would revalidate
  `{pageKey:"about"}` unchanged, matching the frontend's existing fallback.
  `scripts/tests/cmsReservedKeys.test.mjs` — 3 of its 7 tests cover this.
  Whether the owner ever wants About to become its own route is unchanged and
  still open — see below.

### `sectionKey: "seo"` — formalised and pinned (separate from the eight above)

- [x] **CLOSED.** Not one of the original eight open items — the "undocumented"
  framing was already stale (see the retire-or-keep bullet below) — but the
  task of formally documenting the key was not actually done server-side until
  now. `config/cmsMenus.js` gained `SEO_FALLBACK_SECTION_KEY = "seo"` with the
  full contract (which two fields — `title` -> meta title, `body` -> meta
  description, NOT `subtitle` — a page it applies to, and the all-or-nothing
  precedence against `SeoMeta`), cross-referenced from
  `models/SiteContent.js`'s `sectionKey` field. `EDITABLE_FIELDS` in
  `controllers/v1/siteContent.controller.js` is now exported specifically so
  the pinning test can catch a rename of `title`/`body` before it silently
  breaks `Gym-frontend/src/lib/seo.ts`. `scripts/tests/cmsReservedKeys.test.mjs`
  — 4 of its 7 tests, including a schema-level `validateSync()` proving nothing
  server-side rejects or special-cases the key.

### Open — needs the owner (3, was 5)

These are decisions, not work. Each is blocked on a judgement nobody here is
entitled to make; none of them is being guessed at.

- [ ] **Branch street addresses, postal codes and map pins.** `Branch.address`
  is `""` for both gyms, and `streetAddress` / `postalCode` / `geo` are
  declared, typed and parsed in `Gym-frontend/src/lib/site.ts` but empty. The
  recorded decision is that **nothing is invented** — the JSON-LD publishes only
  real data (name, phone, locality, region, country, per-branch opening hours).
  Supplying the real values fills the keys with no other change.
- [ ] **Grant `edit` on `/attendance-overview` to whichever role runs the front
  desk.** A policy choice about who may override a denied scan.
  `scripts/seedInsightsMenus.js --grant-all` deliberately still grants read
  only, and the script says so in a comment. A super admin needs no grant
  (`checkPermission` short-circuits for `role === "ADMIN"`). Nothing is broken
  — the capability exists and is simply not handed out.
  **Recommendation, recorded 2026-09-14, RBAC baseline NOT changed:** do not
  bake a default `edit` grant into any seed/repair script. `checkPermission("/
  attendance-overview", "edit")` gates `POST /attendance/:id/mark-allowed`,
  which reverses a system refusal (`EXPIRED`/`PAYMENT_DUE`) in a member's
  favour, usually with money behind it — the failure mode of under-granting it
  is a phone call to whoever holds it; the failure mode of over-granting it is
  silent, branch-wide revenue leakage with an audit trail nobody reviews until
  asked to. `RoleMaster` rows are owner-named and discovered from live staff
  data (`scripts/seedBranchRolePermissions.js`), not a fixed enum — there is no
  single "Front Desk" role this codebase can identify generically, so any
  seeded default would be a guess dressed as a policy. The mechanism to grant
  it correctly already exists and already reaches the right screen — the super
  admin ticks `edit` for the specific role(s) that staff each branch's desk on
  the Employee Roles screen — so the honest description of this item is "no
  code is missing", not "unimplemented". Left for the owner: naming which
  role(s), per branch, actually run the desk.
- [ ] **Retire the `sectionKey: "seo"` fallback layer?** Now formally documented
  and pinned server-side (`SEO_FALLBACK_SECTION_KEY`, see above) — the
  remaining question is unchanged and is a different one: whether to DELETE the
  fallback now that it is dead in practice. Precedence was formalised in
  Phase 2 and is documented at length in `Gym-frontend/src/lib/seo.ts:11-31` —
  `SeoMeta` wins all-or-nothing, `seo` rows are the fallback, shipped constants
  are last. Checked 2026-09-14: **0 `sectionKey: "seo"` rows exist** and all
  three marketing routes have a `SeoMeta` row, so the fallback is already dead
  in practice. Deleting the layer is a deliberate removal, not a fix.

### Open — known and accepted (1, was 2)

Being handled elsewhere or consciously not done. Not defects to re-litigate.

- [x] **React #418 on the marketing home page** — investigated to a conclusion
  and formally accepted. Nine statically prerendered bisect routes established
  it is NOT a component (removing any one of seven sections made the page
  clean), NOT the metadata path, NOT build or chunk skew (every referenced
  chunk resolves 200), and NOT the page's content (a verbatim copy at another
  path stayed clean). `/` was clean immediately after a deploy and errored
  minutes later in the same run, so the variable is the cached generation of
  `/` itself. It is recoverable — React regenerates the subtree and the page
  renders correctly, so no visitor is affected. The browser gate now forgives
  exactly one occurrence per visit to that one page and reports it every run,
  and says explicitly when it stops so the exception can be deleted. Two
  genuine hydration bugs were found and fixed during the hunt (the Counter's
  reduced-motion branch, the hero's scroll-derived transform); neither was
  this. Any further work is Vercel-side, not code.

### Open — doable (1)

Everything that was on this list as doable has been done and ticked in place
below. This one item is **new**, found on 2026-09-14 while verifying the login-IP
entry, and is recorded rather than fixed because it is a separate screen.

- [x] **The admin login-history view read three fields nothing writes** —
  done. `ipAddress` and `locationCoordinates` left `LoginAttempt` when the
  consent checkboxes went, but the search clause and two columns survived,
  matching only the eleven rows written before the removal and silently
  missing every login since. Server projection, search clause, both columns
  and the three cell components are all removed; only comments explaining why
  remain.

## Decisions

- [x] Phase 6 brand panel: **A** gradient — chosen by owner 2026-09-13. No open decisions remain.
- [x] Repeating content model: a `SiteItem` collection keyed by `collectionKey`, decided 2026-09-13 rather than the `program-1…n` sectionKey convention — the latter breaks ordering, validation and the editor UI.

---

## Phase 0 — Deployment split — DONE, live

Commits: `8a98492` (server) · `3791263` (admin) · `1bf3141` (frontend)

Both Vercel projects exist and are configured, both CI workflows are written
and their secrets are set, the whole split is verified end to end on a local
production build, and it is deployed and live.

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
- [x] **Measured against production 2026-09-14**, 5 runs each through the public domain, signed in as super admin: `/auth/me` **214–238 ms** (median 228), `/menus/by-groups` **194–227 ms** (median 214, 8014-byte payload), all HTTP 200. The ≈250 ms estimate holds and is slightly better than recorded. The useful finding is that it is **not query time**: an unauthenticated 401 on the same path, which touches no collection, costs **182–241 ms**, so essentially the whole figure is round-trip plus function invocation from India to `bom1` through the front-end rewrite hop. Optimising the queries would buy nothing; only dropping the extra hop or moving the caller closer would
- [x] **Recorded login IP — the question is moot: no login IP is recorded at all.** Checked, not assumed. `models/LoginAttempt.js` has **no `ipAddress` and no `locationCoordinates` path**, and `recordSuccessfulLogin()` in `services/authService.js` writes only `attemptCount / isLocked / lockUntil / lastLoggedIn / updatedAt`. The capture was removed along with the consent checkboxes — `utils/clientIp.js` says so in its header and now serves rate limiting only. **Proven live**: logged in to `https://mid-city-gym.vercel.app` as the super admin (HTTP 200, 402 ms); the row that moved carries `ipAddress: "49.36.65.68"` while the machine that logged in has public IP `103.251.215.47` — i.e. the stored value is a **fossil from the old schema**, untouched by the login, and `lastLoginAttempt` did not move either. 11 of 15 rows still carry such fossils. No fix is needed for the audit trail because there is no audit trail to get wrong; **do not** implement the speculative custom-header forwarding described in the original note
  - Follow-on found while checking the above, **not fixed here** — tracked as the one open "doable" item at the top of this file: the admin's login-history view still reads the fields nothing writes any more.

Pre-existing defects found by the new gate and fixed here (not introduced by Phase 0):
- [x] 14 form controls with no accessible name (search inputs on members/trainers/membership-plans/employee/cash-flow, the trainers branch filter, 9 unassociated `Label`/`Input` pairs on profile)
- [x] 1 nameless icon-only button (cash-flow refresh)
- [x] Employee-roles placeholder text at 3.95:1 — **fixed to 4.83:1**, and for all 15 react-selects rather than the two the gate happened to report. `Gym-Admin/src/assets/scss/plugins/_react-select.scss` overrides `.select__control .select__placeholder` to `$input-placeholder-color`, which is `$gray-600` = `#6b7280` (`_variables.scss:161,1029`) — the same token every native input placeholder already uses, so the two kinds of control finally agree. Verified imported at `config/default/app.scss:94`, so it is actually in the build and not an orphan partial. Specificity (0,2,0) deliberately beats emotion's runtime-injected single class without `!important`; the same file also gives react-select the focus ring the other controls have

---

## Phase 6 — Admin login page (3–4 h) — DONE, live

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

## Phase 1 — CMS, adverts, contact form, leads (8–12 h) — DONE, live

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
- [x] Repeating content — the six programme cards, timetable, trainers, pricing, FAQs, testimonials — was hardcoded in `src/lib/site.ts`; `SiteContent`'s flat shape cannot express structured records. **Resolved in Phase 1b** by `models/SiteItem.js` (`collectionKey` + `sortOrder`), with `site.ts` kept as the fallback when a collection is empty
- [x] `SiteContent.imageUrl` free text / `POST /site/content/:id/image` unused — **closed, the admin uses it now.** `Gym-Admin/src/pages/Website/ImageField.jsx` is the picker and `pages/Website/pages/useSectionImage.js` the hook; `WebsitePages.jsx:37-38,172,516` wires both, and the call goes through `uploadSiteContentImage` → `endpoints.jsx:292` → `POST /site/content/:id/image`. The same `ImageField` is reused by `items/SiteItemForm.jsx` against `/site/items/:id/image`. The ordering gotcha is handled and commented: the upload is a **second** request keyed by the row id, so it can only run after create() answers, and a failed upload is reported as a **warning** rather than an error because the section itself saved — calling it a failure would invite a second save that the unique `(pageKey, sectionKey)` index then rejects as a duplicate. The free-text box is deliberately kept, so a section can still point at an external CDN with no upload at all
- Two items that lived here are decisions, not gaps, and have moved to **"Open — needs the owner"** at the top of this file: whether `about` should become its own route (it holds 0 rows and is documented as RESERVED), and whether to retire the `sectionKey: "seo"` fallback (0 rows exist; Phase 2 already formalised and documented the precedence in `Gym-frontend/src/lib/seo.ts:11-31`, so the "undocumented" wording was stale).

---

## Phase 2 — SEO + page-wise SEO Manager (10–14 h) — DONE, live

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

## Phase 4 — Visibility: attendance views, reports, exports, audit log — DONE, live

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
- [x] When Phase 3 adds `Attendance.subjectType`, these queries must filter on it or trainer shifts will appear in member footfall — **done in Phase 3**; seven controllers filter on it and `scripts/tests/attendanceOverride.test.mjs` covers the split

---

## Phase 3 — QR check-in for members and trainers — DONE, live

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
- [x] ~~Trainers cannot check out~~ — CLOSED 2026-09-14. See "Closed 2026-09-14 (this pass)" at the top of this file for the implementation and the 9 tests.
- [x] ~~Denied scans surface only through the export~~ — CLOSED. `/attendance/live` now returns a `denials[]` array alongside `sessions[]`. Footfall still excludes them, and always will: a refusal is not an arrival

---

### Phase 3 — the tail of the original checklist

Everything else on the original Phase 3 list is done and listed above. All of
the engineering items here are now closed, including the browser walk-through
with real accounts (2026-09-14). What is left is a **single policy question** —
who may override a denied scan — which lives in "Open — needs the owner" at the
top of this file.

**Tests after closing them:** `npm run test:unit` — **144/144** at the time, was
122/122. 22 new in `scripts/tests/attendanceOverride.test.mjs`, and one existing
assertion in `scoping.test.mjs` updated on purpose: `/attendance/live` now runs
four branch-scoped queries, not two. The suite has since grown to **301/301**.

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
- Grant `edit` on `/attendance-overview` to whichever role runs the front desk —
  re-verified 2026-09-14 (`scripts/seedInsightsMenus.js:81,172` grants
  `read: true`, `edit: false`, and the script's own comment says the super admin
  ticks `edit` for that role by hand). This is a policy choice, so it now lives
  in **"Open — needs the owner"** at the top of this file
- [x] **Door flow verified end to end against production with real accounts,
  2026-09-14.** Member `midcity` (Krish Modi, Vasna, active to 2027-11-12) →
  `POST /member-auth/login` 200 → `POST /member-portal/attendance/scan`
  `{branch:"Vasna",source:"QR"}` → **`verdict: ALLOW`**, `subjectType: MEMBER`,
  `branch: Vasna`, and the reply carries the honest `basis` string
  ("Self-reported check-in. The branch QR is a printed sticker and is not proof
  of presence."). The session then appeared to staff on the **same production
  deployment**, signed in as the super admin: `GET /attendance/live?branch=Vasna`
  → `inGymNow: 1` with the member named in `sessions[]`, and
  `GET /attendance/footfall` → `2026-09-14 checkIns: 2, uniqueMembers: 2`.
  `POST /member-portal/attendance/check-out` → **"Checked out after 19 minutes"**,
  `durationMinutes: 19`; `/attendance/live` then read `inGymNow: 0` and footfall's
  `totalMinutes` moved 8 → 27. The re-scan was also shown to be **idempotent** —
  the unique `{memberId, date}` index meant it updated today's open row rather
  than opening a second one, leaving `checkInAt` untouched.
  **Left unverified, and deliberately not faked:** the *expired* → `DENIED` leg
  and the *trainer* → `subjectType: TRAINER` leg. No expired member account and
  no trainer credential was available, and inventing one by editing a live
  member's `endDate` would have been a worse trade than leaving the gap
  recorded. Both remain covered by the 16 offline eligibility cases and by
  `scripts/tests/attendanceOverride.test.mjs`.
  **Production data left clean:** the `attendances` collection was snapshotted
  before the walk-through (4 rows) and re-compared after — 4 rows, identical
  SHA. No row was created; the single row the flow touched was restored to its
  captured state field by field

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

**Server + admin + chrome frontend — DONE** (2026-09-13).

- [x] Routes `/cms/home`, `/cms/about`, `/cms/programs`, `/cms/pricing`,
      `/cms/faqs`, `/cms/trainers`, `/cms/testimonials`, `/cms/classes`,
      `/cms/contact`, `/cms/header`, `/cms/footer`, `/cms/social` — thin locked
      wrappers (`CmsScreens.jsx`) over `WebsitePages` / `SiteItemsManager`
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
      `checkPermission`'s four outcomes after its refactor
- [x] Frontend chrome reads `header` / `footer` / `social` via `getSiteChrome()`
      with `site.ts` fallbacks; revalidate route maps those keys to marketing
      paths (active again when Next hosting returns)
- [x] `transformations` now HAS `/cms/transformations`, with a drift test
  pinning the mapping to its menu-tree row. Original note: it was not in the twelve
      requested routes), so it still resolves to `/website-pages` — **by design**

Upside worth having: per-page permissions become possible, so a staff member
can be allowed to edit FAQs without being able to touch pricing.

## Supabase storage for uploads (owner request)

- [x] Bucket `gym-uploads` created on project `zqcltxlpfnwklxtdefok` — public
  read, 50 MB cap, MIME allowlist covering images, PDF and video
- [x] Access posture verified against the live project, not assumed: RLS is on
  with zero policies, so `service_role` writes and anon cannot. An anon-key
  write was probed and refused — *"new row violates row-level security policy"*
- [x] Third backend added to `storage/fileStore.js` behind the existing
  `persistBuffer()` seam. No route, controller or client change: both
  `fileUrl()` helpers already pass absolute URLs through, so Supabase URLs and
  legacy relative paths coexist with no migration
- [x] Uses the Storage REST API over `fetch` rather than `@supabase/supabase-js`
  — no new dependency, no extra cold-start cost on a function that already
  boots slowly
- [x] `npm run verify:storage` — uploads a real PNG through the seam, re-fetches
  it with no auth header, byte-compares, deletes the probe
- [x] `SUPABASE_*` documented in `.env.example`; `next.config.ts` already
  allows `**.supabase.co/storage/**` for `next/image`
- [x] **`SUPABASE_SERVICE_ROLE_KEY` is set and the path is proven end to end.**
  Re-checked 2026-09-14. It is present in `Gym-Server/.env` (a 219-char JWT) and
  `npm run verify:storage` is **green** — uploads a real PNG through the
  `persistBuffer()` seam, re-fetches it with **no auth header**, byte-compares
  70 identical bytes, deletes the probe. Production evidence, not just local:
  the live advert *"Ganesh Chaturthi Leave"* returned by
  `GET https://mid-city-gym.vercel.app/api/v1/site/ads` carries
  `imageUrl: …supabase.co/storage/v1/object/public/gym-uploads/uploads/cms/adverts/b8af502d-….webp`,
  and that object fetches anonymously as **HTTP 200, image/webp, 119,264 bytes**
  — a UUID name and WebP body, i.e. it came through `secureUpload` →
  `persistBuffer` → Supabase rather than being pasted in.
  **One caveat, stated rather than glossed:** the Vercel dashboard env var could
  not be *read* directly to confirm it — the Vercel MCP connection is
  unauthenticated (HTTP 401) and there is no env-listing tool. The evidence above
  is behavioural, and it is strong, but it is inference from a stored object, not
  a screenshot of the project settings
- [x] ~~Video upload is still not enabled~~ — CLOSED 2026-09-14, for the `media`
  collection only. See "Closed 2026-09-14 (this pass)" at the top of this file.
- [x] Migrate existing Blob / local rows into the bucket — **done**, and it
  turned out to matter more than "optional": the rows were hotlinks to
  `images.unsplash.com` and `videos.pexels.com`, i.e. a third party's server on
  every page view. `scripts/migrateMediaToSupabase.js` moved them.
  Verified against the live DB 2026-09-14: **21 of 21** asset URLs across
  `SiteContent.imageUrl`, `SiteItem.imageUrl` and `SiteItem.fields.*` now
  resolve to the bucket, **0 remain elsewhere**, and all 21 carry `migratedFrom`
  so the move is one update away from being undone. They occupy **17** objects
  under `site/` because the key is a hash of the *source* URL, so two rows
  pointing at the same stock photo share one stored file rather than duplicating
  it. The script also does not re-encode and does not delete, by design

## Everything CMS-editable (owner request, 2026-09-14)

- [x] Six things still lived only in `Gym-frontend/src/lib/site.ts`, so changing
  a branch phone number or the tagline meant a code change and a deploy. All
  six now have CMS backing, an admin screen, and frontend rendering:
  hero **stats** (`/cms/stats`), the **marquee** ribbon (`/cms/marquee`),
  **nav links** (`/cms/navlinks`), **branch cards** (`/cms/branches`),
  **background media** (`/cms/media`), and **site identity** (`/cms/site`).
- [x] Proven, not asserted: building with every `site.ts` constant replaced by
  a sentinel leaves exactly **one** sentinel in the output — `og:site_name`,
  documented, because reading it in `generateMetadata` costs a third CMS
  round-trip per page for a string that is already the fallback.
- [x] Building with the API unreachable still renders a full 80 KB page. The
  CMS cannot blank the site.
- [x] `site.ts` remains the fallback for every key. A row that is missing,
  inactive or malformed falls back per row; if that empties a list, the whole
  list falls back.
- [x] ~~Video cannot be uploaded through `/cms/media`~~ — CLOSED 2026-09-14. See
  "Closed 2026-09-14 (this pass)" at the top of this file. Original note: the
  field took a pasted URL, and the field hint said so in the UI. This was the
  same item as the bucket-side note in the Supabase section; both were tracked
  **once**, under "Open — known
  and accepted" at the top of this file.
- Branch street addresses, postal codes and map pins are declared and parsed but
  empty — nothing was invented, per the owner's recorded decision. Supplying them
  is an owner action, so it is tracked under "Open — needs the owner" at the top
  of this file.

## Integrity audit (`npm run audit:integrity`)

- [x] Sweeps for the class of bug that hid the RBAC failure: references that
  look right but resolve to nothing. Dangling ObjectIds, routes gated by
  `checkPermission` with no `MenuMaster` row, `/cms/*` screens and menu rows
  that do not pair up, branch strings no `BranchMaster` backs, staff who would
  land a session with zero permissions, and whether an active super admin
  exists at all. **Currently reports no problems.**
- [x] `/currency-master` was a routed, gated admin screen with no menu row —
  super admin bypassed and it worked, everyone else got "Menu not found", and
  it could never appear in a sidebar. Seeded.

## Known open defect

- React #418 (recoverable hydration error) on the marketing home page. The full
  record — what was fixed, what was ruled out and why the page still works —
  is kept **once**, under "Open — known and accepted" at the top of this file.
  It is being handled elsewhere.

## Measured findings, not yet scheduled

- [x] **187 unlabelled form controls across the admin panel** — now **0**,
  re-measured with `Gym-Admin/scripts/a11y-names.mjs` (AST-based, applies the
  gate's rule that `placeholder` is not an accessible name) across 203 files.
  Commit bd21b23 had already fixed them; the script exists so this is provable
  on demand instead of resting on a one-off count. Original note follows.
  Measured, not estimated: an audit mirroring the browser gate's rules (which correctly reject
  `placeholder` as an accessible name) over all 204 JSX files in
  `Gym-Admin/src`. The gate only sweeps the routes it is given, so it has been
  green while most of the panel went unaudited. Every screen built in Phases
  1–4 is clean; the older ones largely are not. This is real work touching
  screens no phase covers — scope it deliberately rather than folding it into
  an unrelated change.
- [x] `Gym-frontend/src/app/(portal)/attendance/page.tsx` — split, now **633**
  lines; calendar, session list, muscle groups, workout detail, formatters and
  types extracted to `src/components/portal/`. Pure refactor, build green.
  Original note: it was 1226 lines against
  a 800-line guideline. It was 1085 before Phase 3, and the new work went into
  two separate components rather than growing it further. Splitting the calendar
  and session list out is its own refactor.

## Deferred (with reasons)

- SMS / WhatsApp reminders — no provider setup for now (owner decision); scheduler is channel-agnostic
- Payment gateway — all payment in the gym (owner decision)
- Rotating reception QR / geofence — static QR chosen; upgrade path documented in D2
- Dead template files (~1,300 KB / 93 files) — separate PR, away from concurrent merges
- Timestin dark re-theme — parked; tokens recorded in project memory
