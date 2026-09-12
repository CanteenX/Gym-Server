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
8. SEO: `sitemap.xml`, `robots.txt`, JSON-LD `LocalBusiness` per branch, OG images
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
| **Rotating QR on a screen at reception** (recommended) | Strong — the code changes every 30–60 s, so a photo is useless within a minute | Any tablet/TV/spare phone at reception showing a kiosk page |
| Static printed QR + device geofence | Moderate — raises effort, but GPS is spoofable and prompts for permission | Nothing physical; costs a permission prompt |
| Static printed QR alone | **None** — attendance becomes self-reported | Nothing |

**Recommendation: rotating QR on a screen.** The kiosk page needs no
interaction and no one attending it — it just displays a QR derived from a
branch secret plus the current time window, exactly like an authenticator code.
The member's scan carries that short-lived token, so the server can tell a scan
at the door from a scan at home. If there is no screen available at either
branch, fall back to static + geofence and accept that attendance is
approximately honest.

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

### Phase 2 — SEO

`sitemap.xml` and `robots.txt` generated from routes plus CMS pages; JSON-LD
`LocalBusiness` per branch (Vasna and Gotri — real addresses, hours, geo);
per-page OG/Twitter images; canonical URLs; a `next/image` sizing pass.

**Risk: LOW. Effort: 4–6 h.**

### Phase 3 — QR check-in for members and trainers

Per D2 and D3.

- `GET /api/v1/kiosk/branch-token` (kiosk-authenticated) → rotating branch token
  for the reception screen, valid for one 30–60 s window.
- `POST /member-portal/attendance/scan` (**member**-authenticated — the member's
  own phone makes this call) → verifies the scanned branch token is for the
  current window, resolves member or trainer, evaluates eligibility (active
  subscription, payment due, inactive flag) and returns an explicit
  `ALLOW` / `DENY` + reason, recording the attempt either way.
- `GET /api/v1/attendance/live` (staff-authenticated) → arrivals since a `since`
  timestamp, for the admin feed.
- Reception kiosk page (unattended) displaying a rotating branch QR, refreshed
  every 30-60 s from a branch secret plus the time window - no interaction and
  nobody attending it.
- Member-side scanner in the portal on mobile; the verdict is shown to the
  member, since no one is at the door to refuse entry.
- Admin arrivals feed polling GET /api/v1/attendance/live, denials surfaced
  first because those are the rows staff must act on.
- `Attendance` gains `subjectType`, `trainerId` and `deniedReason`, so refusals
  are auditable rather than invisible.
- Admin: live "in the gym now" plus per-day footfall.

**Risk: MEDIUM.** Lower than when a person was refusing entry, because a false
DENY now misinforms a member rather than physically turning them away — but it
still tells a paying member their membership has lapsed when it has not, at the
door, with nobody there to correct it. So the eligibility rules still need unit
tests, the message must direct them to reception rather than dead-ending, and
staff need a one-click "mark as allowed" on the feed that is itself audit-logged.

The other exposure is the rotating token: if the kiosk screen and the server
drift out of time sync, every scan fails. The token window must be generous
(accept the previous window too) and the kiosk page should surface its own clock
skew rather than silently rejecting everyone.
**Effort: 12–16 h.**

### Phase 4 — Visibility: attendance views, reports, exports, audit log

- Staff attendance: footfall per branch/day, in-gym now, and **not seen in 14
  days** — the churn signal already sitting in the data.
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

Total: **46–64 h**, shippable as five independent increments.
