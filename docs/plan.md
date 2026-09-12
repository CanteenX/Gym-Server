# Mid City Gym — Feature Plan

Status: **awaiting approval — nothing has been built.** Written 2026-09-13.

Covers all three repos: `Gym-Server` (API), `Gym-Admin` (staff panel),
`Gym-frontend` (marketing site + member portal).

---

## 1. Scope

Confirmed in scope:

1. Brand advertisements on the website, managed from the admin panel
2. Contact-us form on the website, submissions landing in the admin panel
3. Email setup (partly exists already — see §3)
4. QR check-in on mobile for members **and trainers**: starts gym time, verifies
   an active subscription, shows the member an **ALLOWED / DENIED** verdict, and
   writes an entry visible in the admin panel in near-real time. Unattended —
   see D2; nobody is at the door, so a denial informs and flags rather than
   physically refusing entry.
5. Full website CMS — every currently-static marketing page editable from admin
6. Lead capture: `Lead` model, admin inbox, staff notification
7. Free-trial / class booking with a slot cap
8. SEO: `sitemap.xml`, `robots.txt`, JSON-LD `LocalBusiness` per branch, OG
   images, plus a **page-wise SEO Manager** in the admin (meta title/description,
   keywords, canonical, Open Graph, live Google and social previews, score) -
   modelled on marfatia.net/admin/seo-manager with the UI improvements in Phase 2
9. Staff attendance view: footfall per branch per day, who is in the gym now,
   members not seen for 14 days
10. Reports and exports (revive `ExportCSVModal`), respecting `financialScopeFilter`
11. Audit log: who changed what

Explicitly **out** of scope:

- **Payment gateway.** All payment happens at the gym. Cash/UPI stays recorded
  by staff against `Member.payments[]` and the `Transaction` ledger.
- **SMS and WhatsApp.** No provider setup for now. Consequence: the retention
  reminders in Phase 5 are **email-only**. The scheduler, cohort logic and
  `ReminderLog` are built channel-agnostically so a channel can be added later
  without rework.

### Email address

**`nventra01@gmail.com`** is the single address used throughout: the recipient
for contact-form and lead notifications, the `from`/reply-to on outbound mail,
and the default `EmailSetup` account.

Two practical notes, not objections:

- Gmail SMTP requires an **app password** (not the account password) and is
  rate-limited to roughly 500 recipients/day. Fine for leads and reminders at
  current volume; if member-wide mailouts are ever wanted, that ceiling is the
  thing that will break first.
- Mail `from` a gmail.com address cannot be SPF/DKIM-aligned to
  `midcitygym.in`, so some recipients will show it as "via gmail.com" and spam
  placement is weaker than a domain sender. Worth revisiting if reminder
  open-rates matter; it is stored in `EmailSetup` so it is a data change, not a
  code change.

---

## 2. Architecture decisions — all resolved

Settled with the owner on 2026-09-13. Each one changes the shape of the work, so
the reasoning is kept here rather than only in a commit message.

### D1 — RESOLVED: the site becomes dynamic, rendered with ISR

**Decision: drop `output: "export"` and run Next.js dynamically, using ISR with
on-demand revalidation.**

Clearing up the SEO question first, because it drove the earlier
recommendation: **dynamic rendering is not bad for SEO.** Only *client-side*
fetching is, because a crawler receives an empty shell and never runs the fetch.
Server-rendered and incrementally-regenerated pages both ship complete HTML.

| Rendering | SEO | Delivery speed | Freshness |
|---|---|---|---|
| Static export (today) | Excellent | Fastest — pure CDN | Frozen at build time |
| **ISR + on-demand revalidate** (chosen) | **Excellent** | Near-static; cached HTML at the edge | **Instant** — admin save revalidates the affected path |
| SSR on every request | Excellent | Slower TTFB, server cost per hit | Instant |
| Static + client-side fetch | **Bad** | Fast shell | Instant |

ISR is chosen over plain SSR because the marketing pages are read far more often
than they are edited: pages are served as cached HTML like the static build, and
`revalidatePath()` is called from the admin when content changes, so an edit is
live in seconds without a rebuild and without paying a render on every visit.
This removes the "Publish to website" button and the ~2 minute lag entirely.

**The real cost is architectural, not SEO.** Today there is ONE Vercel project:
`Gym-Server` at the root, serving a folder of static files (`public/`, which
contains the Next export and the admin SPA) plus one `api/index.js` serverless
function. A dynamic Next app cannot be a folder of static files inside another
project — it needs its own runtime for routing, RSC payloads and image
optimization.

So the deployment has to be restructured. Recommended shape:

| | Project | Owns | Contains |
|---|---|---|---|
| 1 | `Gym-frontend` (Next.js preset) | the domain | marketing site + member portal, dynamic/ISR; admin SPA served from its `public/admin/` |
| 2 | `Gym-Server` (Express) | an internal URL | the API only |

Project 1 rewrites `/api/*` to project 2. The single-domain requirement is
preserved: the browser only ever sees one origin, so the `express-session`
cookie stays first-party and there is still no CORS to maintain. The admin panel
stays same-origin with the site because it is static and can live inside the
Next app.

Consequences to accept:
- `/api/*` gains one proxy hop. Small next to the ~220 ms we already removed by
  moving the function to `bom1`, but it is not zero.
- Two projects to configure instead of one; the CI workflow changes shape,
  deploying each project rather than assembling one `public/`.
- Project 2 must stay pinned to `bom1` for the database colocation win.

The single-project alternative is `vercel.json` legacy `builds` combining
`@vercel/next` and `@vercel/node`. It keeps one project but opts out of
zero-config and is a less-travelled path; I would only take it if the extra
proxy hop proves to be a problem.

### D2 — Check-in is UNATTENDED; staff watch the panel instead

**Constraint given:** nobody stands at the door to scan. The member scans the
gym's QR on their own phone, check-in happens unattended, and staff watch
arrivals on the admin panel in near-real time.

This inverts the earlier recommendation. With no one at the door, "deny at the
point of entry" cannot be physical — the system cannot stop anyone walking in.
What it *can* do is tell the member immediately and flag it to staff:

- The member's screen shows the verdict: **ALLOWED**, or
  **DENIED — membership expired / payment due, please see reception**.
- The attempt is recorded either way, with `deniedReason`, so a refusal is
  visible and auditable rather than just absent.
- The panel surfaces denials prominently, because those are the rows staff must
  act on.

**The hard problem is now presence proof.** Unattended, a QR printed on the wall
can be photographed once and used from a sofa forever, which makes attendance
self-reported and the churn signal worthless.

| Approach | Presence proof | Requires |
|---|---|---|
| Rotating QR on a screen at reception | Strong — the code changes every 30–60 s, so a photo is useless within a minute | Any tablet/TV/spare phone at reception showing a kiosk page |
| Static printed QR + device geofence | Moderate — raises effort, but GPS is spoofable and prompts for permission | Nothing physical; costs a permission prompt |
| **Static printed QR alone** (CHOSEN) | **None** — attendance is self-reported | Nothing |

**Decision: static printed QR alone.** A printed sticker per branch, no screen,
no geofence, no kiosk page. This is the cheapest thing that works and it can be
upgraded later without touching the member-facing flow — the rotating variant
only changes what the QR encodes and adds one server check.

What the static QR actually buys, given the check-in button already exists (D2b):

- **Fewer taps.** The QR deep-links straight to the check-in action rather than
  making the member navigate the portal.
- **Branch attribution.** The QR carries its branch, so the entry is attributed
  to Vasna or Gotri without the member selecting it — which is what makes
  per-branch footfall meaningful at all.

What it does not buy, stated plainly so nobody is surprised later:

- **It is not proof of attendance.** The sticker can be photographed once and
  the link used from anywhere, and the existing button needs no QR at all. A
  member can log a session without entering the building.
- Consequently the **"not seen in 14 days" churn signal in Phase 4 is soft**.
  It still catches the common case — someone who has stopped coming and stopped
  logging — but it cannot distinguish that from someone who comes and never
  scans, or who scans from home. Treat it as a prompt for a phone call, not as
  evidence.
- Eligibility gating still works and is still worth having: an expired member
  who scans is told their membership has lapsed and the denial is recorded for
  staff. It just cannot stop them walking in, which nothing unattended can.

### D2b — Manual session start ALREADY EXISTS; QR is the layer on top

Worth stating plainly before Phase 3 is scoped: the member portal already has a
working start-session button. `src/app/(portal)/attendance/page.tsx` posts to
`/member-portal/attendance/check-in`, and the screen runs a live timer computed
from `checkInAt` rather than an incrementing counter. The check-out and
auto-close paths exist too.

So the baseline is done: a member logs in, taps the button, and an attendance
entry exists. Phase 3 does not build that - it adds the parts the button cannot
provide:

- **Presence proof.** The button can be pressed from anywhere; a rotating
  reception QR is what ties a session to actually being at the gym.
- **Eligibility gating.** The current button does not evaluate subscription
  state, so an expired member can still start a session. Phase 3 adds the
  ALLOW / DENY verdict and records `deniedReason`.
- **Trainer sessions**, via the D3 discriminator.
- **Staff visibility**, via the polling arrivals feed.

This also means the two paths must write the same shape of row, distinguished by
a `source` field (`SELF` vs `QR`), or the footfall numbers will not be
comparable once the gym starts enforcing scans.
### D2a — Real-time on the panel: polling, not WebSockets

Also constrained by the architecture, so worth settling now: **the API is a
serverless function and cannot hold a WebSocket or a Server-Sent Events stream.**
Vercel functions are stateless and short-lived — `vercel.json` caps
`maxDuration` at 30 s — so a persistent connection is not available without
adding a third-party realtime service (Pusher, Ably) or a long-running host.

**Decision: poll.** The admin check-in feed polls a lightweight
`GET /api/v1/attendance/live` on an interval. Every 5 minutes as you suggested
is fine, and 30–60 s is also affordable now that authenticated endpoints run at
roughly 250 ms — an arrivals feed that lags 30 s reads as live to a person
glancing at a screen. The endpoint returns only rows changed since a `since`
timestamp so the payload stays small, and polling pauses while the browser tab
is hidden so an idle panel costs nothing.

### D3 — RESOLVED: one `Attendance` collection with a discriminator

`Attendance` is modelled per member (`memberId` taken from the verified JWT).
Trainers check in too, so the collection gains `subjectType: "MEMBER" | "TRAINER"`
and a nullable `trainerId`, with `memberId` becoming nullable in the trainer case.

Chosen over a separate `TrainerAttendance` because:

- "Who is in the gym now" and per-day footfall are one query rather than two
  plus a merge, and those are the views the feature exists to serve.
- The auto-close behaviour (a session left open is closed after a member-set
  60–120 minutes) is identical for both, so a second collection would duplicate
  it and the two copies would drift.
- `Attendance` is already "one row per visit, not a counter", which is exactly
  the shape a trainer shift needs.

Cost of the decision, accepted knowingly: every existing attendance query must
now filter on `subjectType`, or trainer shifts will silently appear in member
footfall numbers. A partial index on `{ subjectType, branch, checkInAt }` keeps
the dashboard queries fast, and the existing rows need a one-off migration to
set `subjectType: "MEMBER"`.

---

## 3. What already exists — do not rebuild

- **Email.** `EmailSetup` stores SMTP host/port/SSL/app-password **in Mongo**
  (admin-editable, no env vars), and `otp.controller.js` has a working
  nodemailer transport. `EmailTemplate`, `EmailFor`, `EmailTo` models exist.
  *Missing:* a reusable mail service — sending is currently inlined in the OTP
  controller and must be extracted before anything else can send mail.
- **Attendance.** Member self check-in/check-out already exists under
  `/member-portal/attendance/*`, one row per visit, auto-closing after a
  member-set 60–120 minutes. **No staff-facing route or admin page exists**, so
  the data is collected and never seen.
- **Ledger.** `Transaction` is append-only (`direction: IN|OUT`) with a
  `"Common"` branch for shared costs. All reporting must read this, never
  `Member.payments[]`, which is cleared on renewal.
- **Branch scoping.** `scopeFilter`, `resolveBranchFilter` and
  `financialScopeFilter` in `middlewares/branchScope.js`.
- **Dead code to revive.** `Components/Common/ExportCSVModal.jsx` exists and is
  imported by nothing.

---

## 4. Phases

Ordered by value per unit of risk. Each ships independently.

### Phase 1 — Website CMS, adverts, contact form, leads

Turns the static marketing pages into admin-managed content.

- **Models:** `SiteContent` (keyed blocks per page/section), `Advertisement`
  (creative, target URL, placement slot, active window, sort order), `Lead`
  (name, phone, email, message, source, status, assignedTo, notes).
- **Admin:** a Website menu group — Pages, Adverts, Leads inbox.
- **Server:** public reads (`GET /api/v1/site/content`, `/site/ads`),
  authenticated writes behind `checkPermission`, and a public rate-limited
  `POST /api/v1/site/leads`. Extract `services/mailService.js` from the OTP
  controller and notify `nventra01@gmail.com` on each new lead.
- **Frontend:** marketing sections read `SiteContent` at build time; adverts
  render from `Advertisement`; the contact form posts to the leads endpoint.
- **Freshness:** no publish step. Saving content calls
  `revalidatePath()` on the affected route (per D1), so the change is live in
  seconds while the page is still served as cached HTML.
- **Rendering move:** this is the phase that drops `output: "export"` and splits
  the deployment into the two projects described in D1. Do it first, before any
  CMS content depends on it.

**Risk: MEDIUM.** The lead endpoint is public, so it needs the existing
`authRateLimiter`, a honeypot or Turnstile, and strict validation, or it becomes
a spam relay pointed at your inbox. Advert creatives must go through
`secureUpload` → `persistBuffer` → Blob, not a new upload path.
**Effort: 10–14 h.**

### Phase 2 — SEO, with a page-wise SEO Manager in the admin

Site-wide first: `sitemap.xml` and `robots.txt` generated from routes plus CMS
pages; JSON-LD `LocalBusiness` per branch (Vasna and Gotri — real addresses,
hours, geo); canonical URLs; a `next/image` sizing pass.

Then the admin screen, modelled on `marfatia.net/admin/seo-manager`.

**`SeoMeta` model**, one document per page: `slug` (unique), `pageTitle`,
`category`, `icon`, `metaTitle`, `metaDescription`, `keywords[]`, `canonicalUrl`,
`ogTitle`, `ogDescription`, `ogImage`, `ogType`, `noIndex`, `isActive`.

**Admin UI — three panes:**

1. *Page list* — searchable, category-filter chips, add/edit/delete, and a
   completeness indicator per row (Complete / Partial / Missing).
2. *Editor* — Meta Title and Meta Description with live character counters
   against the 60/160 targets; Keywords as removable chips (Enter or comma to
   add); Canonical URL; an Open Graph block (OG Title and Description defaulting
   to the meta values when blank, OG Image with a thumbnail, OG Type);
   Save / Discard, and a "View Live" link.
3. *Previews* — an SEO score with a per-rule checklist, a Google search-result
   mock, and a social-share card mock, all updating as you type.

**Where ours should be better than the reference, concretely:**

- **Server-rendered from the database.** Because D1 makes the site dynamic,
  these values feed Next's `generateMetadata()` per route, and saving calls
  `revalidatePath()` — so an edit is live in seconds and is real HTML in the
  crawler's response. A static site would need a rebuild for each change.
- **Status is not colour-only.** The reference signals completeness with a bare
  green/amber/red dot plus a legend at the bottom of the list. Colour alone
  fails for colour-blind users and in greyscale; ours pairs the dot with a short
  text label, which also removes the need for the legend.
- **Reuse the existing `IconPicker`.** The reference asks the user to type a
  Remixicon class name into a free-text field ("ri-file-line"), which is a typo
  waiting to happen — and we now know from the icon work that a wrong class
  renders an invisible, zero-width element. `Components/Common/IconPicker.jsx`
  already exists and offers only valid classes; `scripts/check-icons.mjs` cannot
  catch a bad value that lives in the database.
- **Counters should warn, not just fill.** A progress bar that only grows tells
  you nothing at 75/60 characters. Ours turns amber approaching the limit and
  red past it, since Google truncates rather than rejects.
- **Preview both widths.** Google truncates titles differently on mobile and
  desktop, so the preview needs a toggle rather than one fixed mock.
- **Portal routes get `noIndex`, not SEO fields.** Ours has ~9 routes, of which
  6 sit behind member auth (`login`, `dashboard`, `attendance`, `weight`,
  `workout`, `change-password`). Those should never be indexed. The reference's
  flat 42-page list makes no such distinction; ours seeds `noIndex: true` for
  the portal group and excludes them from `sitemap.xml` automatically, so nobody
  has to remember.
- **Score rules must be honest.** Show what each rule checks and let clicking it
  jump to the offending field. A single number with no path to fixing it is
  decoration.

**Risk: LOW-MEDIUM.** Low technically, but two things to get right: a bad
`canonicalUrl` can de-index a page, so it should be validated and default to the
route's own absolute URL rather than being free text; and `generateMetadata()`
must fall back to sensible defaults when a row is missing, or adding a route
without an SEO entry would ship a page with no title at all.
**Effort: 10–14 h** (4–6 site-wide, 6–8 for the manager).

### Phase 3 — QR check-in for members and trainers

Per D2 and D3.

- **Printed QR per branch**, encoding a deep link such as
  `/{portal}/attendance?branch=vasna&src=qr`. No kiosk page, no rotating token,
  no screen — per D2. Generated once from the admin so the branch codes are not
  hand-typed onto a sticker.
- `POST /member-portal/attendance/scan` (**member**-authenticated — the member's
  own phone makes this call) → resolves member or trainer, evaluates eligibility
  (active subscription, payment due, inactive flag) and returns an explicit
  `ALLOW` / `DENY` + reason, recording the attempt either way with the branch
  from the QR.
- `GET /api/v1/attendance/live` (staff-authenticated) → arrivals since a `since`
  timestamp, for the admin feed.
- Member-side scanner in the portal on mobile; the verdict is shown to the
  member, since no one is at the door to refuse entry.
- Admin arrivals feed polling GET /api/v1/attendance/live, denials surfaced
  first because those are the rows staff must act on.
- `Attendance` gains `subjectType`, `trainerId` and `deniedReason`, so refusals
  are auditable rather than invisible.
- Admin: live "in the gym now" plus per-day footfall.

**Risk: LOW-MEDIUM.** Lower than either earlier version. Nobody is refusing
entry, so a false DENY misinforms rather than turns someone away; and dropping
the rotating token removes the clock-skew failure mode entirely, where a kiosk
screen drifting out of sync with the server would have rejected every scan.

What remains: a wrong eligibility verdict tells a paying member their
membership has lapsed, at the door, with nobody there to correct it. So the
eligibility rules still need unit tests, the DENY message must point them to
reception rather than dead-ending, and staff need a one-click "mark as allowed"
on the arrivals feed that is itself audit-logged.

**Effort: 8–11 h** (down from 12–16: no kiosk page, no rotating-token
endpoint, no time-window verification).

### Phase 4 — Visibility: attendance views, reports, exports, audit log

- Staff attendance: footfall per branch/day, in-gym now, and **not seen in 14
  days**. Label this one "not checked in for 14 days", not "not visited" — with
  the static QR chosen in D2 there is no presence proof, so it measures logging
  behaviour rather than actual visits. Still the best churn prompt available, but
  it should read as "worth a phone call", not as evidence someone stopped coming.
- Reports: collections by month/branch, expiry pipeline, member ageing, and a
  P&L that keeps `"Common"` out of any single branch's numbers.
- Exports: revive `ExportCSVModal` with server-side generation, scoped by
  `financialScopeFilter`.
- `AuditLog`: actor, action, collection, documentId, before/after diff,
  timestamp, IP — written from mongoose middleware so it cannot be forgotten at
  a call site — plus an admin viewer.

**Risk: LOW-MEDIUM.** The real hazard is an export leaking another branch's or
`"Common"` financial data; that must be a test, not a review note.
**Effort: 10–14 h.**

### Phase 5 — Class booking and email reminders

- `ClassSession` (title, branch, trainer, start, capacity) and `Booking` (member
  or lead, session, status), with an **atomic** capacity check so a slot cannot
  be oversold under concurrency.
- Public booking form on the site; admin roster view.
- Reminders: Vercel Cron → `POST /api/v1/jobs/reminders` (shared-secret
  protected) → cohorts (expiring in 7 days, expired, payment due) → **email**
  via the Phase 1 mail service → `ReminderLog` so nobody is contacted twice.
  Ships in dry-run mode first: log who *would* be mailed and send nothing, until
  you have inspected the list.

**Risk: MEDIUM.** Overselling a class and double-mailing members are both
user-visible; an atomic write and `ReminderLog` are what prevent them.
**Effort: 10–14 h.**

---

### Phase 6 — Admin login page (independent, can run any time)

The login page was rebalanced to 58/42 and put on brand navy, but it is still
plainly composed: a flat pale panel with the logo and a form on white. Compared
against `marfatia.net/admin/`, four specific techniques are missing — the
difference is depth and a typographic anchor, not colour.

Measured from the reference rather than eyeballed:

| | Reference | Ours today |
|---|---|---|
| Brand panel | `linear-gradient(135deg, #064e3b, #047857)` + faint cross-hatch pattern | flat `#f1f5fb` |
| Logo treatment | dark logo inside a **white rounded tile** (~140 px, ~24 px radius) | bare logo on a pale ground |
| Headline | "Welcome to Admin Panel", ~44 px bold white, with a line of subcopy | none |
| Form container | white card, ~16 px radius, soft shadow, floating on `#f3f3f9` | form directly on plain white |
| Font | Poppins | Poppins (already matches) |

**The white logo tile is the unlock.** Our brand panel is pale blue only because
the wordmark is dark navy on transparent and would vanish on a navy ground. Put
the logo in a white rounded tile and the panel can finally be brand navy, which
is what makes the reference read as branded rather than decorated.

Proposed spec:

- **Left panel (58%)**: navy `$navy-900 → $navy-700` surface with a very low
  contrast repeating pattern; white rounded logo tile; headline
  ("Mid City Gym — Staff Panel" or similar) and one line of subcopy; the two
  branch chips move here.
- **Right panel (42%)**: tinted ground rather than plain white, with the form in
  a floating white card — radius 12–16 px, the navy-tinted shadow already added.
- Keep: the navy submit button, field ids, `autoComplete`, Enter-to-submit, and
  the panel collapsing below `lg`. None of the form logic changes.
- Do **not** copy the reference's consent checkboxes — those were deliberately
  removed, along with the `confirm()` dialog and the geolocation await.

**One decision needed.** The reference gets its depth from a *gradient* panel,
and the instruction here was to remove gradients everywhere. That instruction
was about buttons, where a gradient reads as dated; on a large brand surface it
reads as intentional. Two options:

- **A. Gradient brand panel** — matches the reference, gradients stay banned on
  buttons and badges. `applyTheme`'s flattening only touches `--btn-*`
  variables, so it will not strip a panel background.
- **B. Flat navy panel + pattern only** — keeps "no gradients anywhere" literal;
  slightly less depth, still a large improvement over flat pale blue.

I would take A and keep the ban specific to controls, but B is a one-line
difference if gradients are unwanted on principle.

**Risk: LOW.** Presentation only, no auth logic touched. The one hazard is
contrast: white subcopy on a mid-navy panel must clear 4.5:1, so the pattern
overlay has to stay low-opacity rather than lightening the ground.
**Effort: 3–4 h.**


## 5. Cross-cutting requirements

- **Branch scoping** on every new query, export and report. Read
  `req.session.user` — `req.user` carries no `branch` and silently reads as
  "unrestricted", which leaks every branch's data.
- **Permissions.** New admin screens need `MenuMaster` rows seeded before
  `checkPermission` will pass. The gym routes deliberately skip it today; follow
  the existing pattern rather than half-applying it.
- **Uploads.** Advert creatives and OG images go through `secureUpload` →
  `persistBuffer` → Blob. No new upload path.
- **Tests.** There are currently **zero** across all three repos. Phases 1–2 do
  not need to be blocked on that, but Phase 3's eligibility rules and Phase 4's
  export scoping should ship with tests — those are the two places where a bug
  means a refused customer or a data leak.

---

## 6. Security debt this plan would make worse

`Gym-Server` is a **public** GitHub repository containing a committed `.env`
with the live Mongo URI and every JWT secret.

Phase 1 adds SMTP credentials (the Gmail app password) and a Vercel Deploy Hook
URL to that same surface. Phase 5 adds a cron shared secret. Each is a
credential that lets a stranger act as the system.

Rotating the Atlas password and making the repo private takes roughly 20 minutes
and should happen **before** Phase 1, not after.

---

## 7. Recommended sequence

**1 → 2 → 4 → 3 → 5**

Phase 1 unlocks most of what was asked for and builds the content and mail
layers everything else depends on. Phase 2 is cheap and compounds over time.
Phase 4 is low-risk and pays off every day. Phase 3 is deliberately later: it is
the highest-risk phase because it can turn a paying member away at the door, and
it is safer once Phase 4's audit log already exists. Phase 5 depends on Phase 1's
mail service.

Total: **51–76 h**, shippable as six independent increments.
