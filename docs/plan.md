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
   an active subscription, can **deny at the point of entry**, and writes an
   entry visible in the admin panel
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

## 2. Decisions needed before Phase 1 starts

These change the architecture, so they are yours to make.

### D1 — How does a CMS-driven site stay SEO-friendly? *(blocks Phases 1 and 2)*

`Gym-frontend` is currently `output: "export"` — a fully static build. That is
why it is fast and indexes perfectly. A CMS conflicts with it, because static
HTML is generated at build time rather than per request.

| Option | SEO | Freshness | Cost |
|---|---|---|---|
| **A. Static + Publish button** (recommended) | Perfect — real HTML | ~2 min after publishing | Low. Keeps the current build; adds a Vercel Deploy Hook the admin calls. |
| B. Switch to SSR/ISR | Good | Instant | Medium. Drops `output: "export"`, changes the deploy shape, adds per-request server cost. |
| C. Static + client-side fetch | **Bad** — content invisible to crawlers | Instant | Low, but defeats requirement 8. |

**Recommendation: A.** Marketing copy and adverts do not need sub-minute
freshness, and C is disqualified by the SEO requirement. Admin gets an explicit
"Publish to website" action, which is also safer than every keystroke going live.

### D2 — Which direction does the QR scan go? *(blocks Phase 3)*

You asked for both a scanner and a default QR. There are two directions and they
are not equivalent:

| Direction | How | Presence proof | Denial UX |
|---|---|---|---|
| **B1. Member shows a personal QR, the gym scans it** (recommended) | Portal renders a short-lived signed token as a QR; a staff/kiosk page scans it | Strong — the member is physically at the desk | Excellent: the scanner shows ACTIVE / EXPIRED / PAYMENT DUE instantly, so staff can refuse entry |
| B2. Gym displays a QR, the member scans it | Branch QR on the wall, member's phone opens it | **Weak — a photographed QR works from home** | Poor: the member sees their own verdict, staff see nothing |

**Recommendation: B1 as the gate, B2 as a convenience.** B1 is the only one that
can actually deny entry, and it matches the existing comment in
`attendance.routes.js` that "a check-in is a claim about where a member is". If
B2 is wanted as well, the branch QR must carry a **rotating** token rather than a
static URL, or it is trivially abused.

### D3 — Trainer attendance shape

`Attendance` is modelled per member (`memberId` taken from the verified JWT).
Trainers need check-in too: either add a nullable `trainerId` plus a
`subjectType` discriminator, or create a separate `TrainerAttendance`.

**Recommendation: one collection with a discriminator.** The "who is in the gym
now" view wants a single query, and the auto-close logic is identical.

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
- **Publish:** an admin "Publish to website" action calling a Vercel Deploy Hook.

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

- `GET /member-portal/checkin-token` → short-lived signed token (60–90 s TTL),
  rendered as a QR in the portal, mobile-first.
- `POST /api/v1/attendance/scan` (staff-authenticated) → verifies the token,
  resolves member or trainer, evaluates eligibility (active subscription,
  payment due, inactive flag) and returns an explicit `ALLOW` / `DENY` + reason
  **before** writing attendance.
- Kiosk page in the admin panel: camera scanner, large ALLOW/DENY result, branch
  taken from the signed-in employee's scope.
- `Attendance` gains `subjectType`, `trainerId` and `deniedReason`, so refusals
  are auditable rather than invisible.
- Admin: live "in the gym now" plus per-day footfall.

**Risk: MEDIUM-HIGH.** This gates physical entry — a false DENY is a paying
member being turned away at the desk. The eligibility rules need unit tests, and
there must be a staff override that is itself audit-logged.
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
