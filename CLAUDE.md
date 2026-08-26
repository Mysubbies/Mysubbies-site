# Mysubbies Group — Project Context

## What this is
A Melbourne renovation/construction marketplace. Uber-style model: customer picks
a service, gets an instant price, approves it, job is dispatched to one matched
contractor from a vetted panel — not open bidding. 25% platform commission.
Solo founder, no dev team, built entirely through Claude conversations to date.

## Real payment backend (added Aug 2026) — deposit only, not fully live yet
This project now has an actual backend for the first time: a `package.json`
(first build dependency this repo has ever had — the HTML pages themselves
are still unbundled, unframeworked, self-contained; only `/api` needs npm),
Stripe (Connect **Standard**, chosen for lower onboarding/support burden
over Express), and **Supabase (Postgres)** as the source of truth for
payment/payout state, since that can never live in localStorage.

**Scope is deliberately narrow — v1 is deposit-only, contractor payout is manual:**
- The deposit stage is real Stripe money, and (added Aug 2026) so are the
  materials/frame/completion stages — but not automatically anymore. The
  contractor can no longer self-mark a stage paid: they "request" it
  (`requestStageApproval()` in contractor-portal.html), the customer sees an
  Approve & Pay card (`renderStageApproval()`/`approveAndPayStage()` in
  customer-portal.html, same Stripe Elements pattern as the deposit) and
  pays with a real card before the stage counts as done. See
  `api/create-stage-payment-intent.js` — same "lock the amount in on first
  sight" pattern as `create-deposit-intent.js`, keyed by (job_id, stage) in
  the `payments` table rather than a dedicated jobs column.
- Money from every stage still only ever lands in the Mysubbies platform
  Stripe account — there is still no automatic Stripe Connect transfer to
  contractors for materials/frame/completion. Contractors are paid those
  stages manually by Mysubbies AP, by explicit founder direction, until this
  flow has proven stable. Only the deposit's 75% share flows through the
  automated weekly payout batch described below.
- `paidStages[stageKey]` is set **client-side**, by the customer's own
  browser, immediately after `stripe.confirmCardPayment()` succeeds — not
  by the webhook. This deliberately mirrors how the deposit stage already
  worked before this feature existed, and avoids a write race: the webhook
  only ever owns the `payments` table row for the charge itself (and,
  for the deposit specifically, `jobs.status`), never `jobs.full_record`.
  If you touch this again, do not make the webhook write
  `full_record.paidStages` — the next unrelated `saveJobs()` call from any
  browser would silently overwrite it with a stale local copy.
- Only single-category bookings go through real Stripe payment
  (`beginBookingFlow()` in booking.html). Multi-category bundles still use
  the old immediate-fictional-deposit path, because one Stripe PaymentIntent
  maps to one job in the current schema and bundles create several job rows
  at once — extending this to bundles is unbuilt follow-up work, not
  forgotten.
- The weekly payout batch (`api/weekly-payout.js`, Vercel Cron, Mondays
  01:00 UTC by default) only ever transfers a contractor's 75% share of the
  captured *deposit* — never the full job value, because the platform
  doesn't actually hold the rest of that money yet under this scope.
- Payout eligibility (matching the founder's explicit requirement): job's
  deposit webhook-confirmed, not disputed, at least `HOLD_DAYS` (3, constant
  at the top of weekly-payout.js) since payment succeeded, and the
  contractor's Stripe Connect onboarding is complete. A job can only ever be
  paid out once (enforced by a DB unique index, not just application logic).

## Vercel function count
Every file directly under `api/` (not `api/_lib/`) counts as one serverless
function. This repo previously hit the Hobby plan's 12-function hard cap
(confirmed the hard way: a 13th/14th function didn't error the deploy, it
just silently 404'd on the newest functions while everything else kept
working — looks exactly like a routing bug if you don't know to check the
count). As of Aug 2026 there are 16 functions and all of them respond
correctly in prod (verified live: each returns a real app-level status —
400/405 — not Vercel's 404 routing page), so whatever the current plan/limit
is, it's comfortably above 12 now. Still, prefer extending an existing
multi-purpose endpoint over adding a new top-level file where it's a
natural fit — `api/notify.js` (`{type: 'job-assigned' | 'stage-requested',
...}`), `api/get-admin-list.js` (`?type=applications|customers|
milestone-claims|pending-schedule-jobs|payment-audit`), and
`api/admin-account.js` (`{role, email, action}`) all exist specifically as
multi-purpose endpoints for exactly this reason — it's just no longer a
hard constraint that blocks new files outright.

**Known correctness gap, flagged deliberately:** the rate card (21
categories, ~163 tasks) still lives only in browser localStorage, not in
Supabase. `api/create-deposit-intent.js` therefore can't independently
recompute a job's price the way a fully server-authoritative system should
— it trusts the client-submitted amount **once**, on first sight of a given
job ID, then locks it into the database; every later call for that same
job ID reuses the stored amount and ignores whatever the client sends. This
stops a customer manipulating the charge after the fact, but doesn't stop a
wrong number being submitted the very first time. Closing that fully means
moving the rate card server-side too — out of scope for this pass.

**Not yet tested against live services** — built without real Stripe test
keys or a live Supabase project in the loop, so verified for syntax,
balance, and the pre-Stripe fallback path only (confirmed the site still
works exactly as before when `STRIPE_PUBLISHABLE_KEY` is left as the
`REPLACE_ME` placeholder — see `stripe` guard in booking.html). The actual
card-entry-to-webhook-to-payout path needs a real test-mode pass once
credentials exist. See `.env.example` for the exact Vercel environment
variable names needed, and `supabase/schema.sql` for the DB schema to run
in the Supabase SQL editor before anything will work.

**Real-world discovery (Aug 2026): Connect needs its own Stripe account.**
The founder's original Stripe account (`mysubbies.com.au`) turned out to be
Xero-linked and Stripe flatly refuses to enable Connect on it — the
dashboard says outright "Connect is not available for this account, please
create a new account." A second account ("Mysubbies Site") was created
specifically for Connect, using the **Marketplace** business model (buyer →
platform → contractor, matching the "customers and contractors never deal
with payment directly" requirement — the alternative "Platform" model has
contractors collecting payment directly, which is the opposite of what was
wanted). Consequence: `STRIPE_SECRET_KEY` must be the key from whichever
account actually charges customers. If that ever needs to change, every
downstream key/webhook/publishable-key value changes with it — they're not
portable between Stripe accounts.

**Two separate webhook destinations, two separate secrets.** Stripe will
not let one destination mix "Your account" scope (payment_intent events)
with "Connected accounts" scope (account.updated) — their own UI copy says
"create two separate destinations." Each destination gets its own signing
secret, so `api/stripe-webhook.js` tries both `STRIPE_WEBHOOK_SECRET` and
`STRIPE_WEBHOOK_SECRET_CONNECT` when verifying a request, since there's no
way to know in advance which destination sent it.

Required setup before any of this goes live:
1. Run `supabase/schema.sql` in the Supabase project's SQL editor.
2. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_CONNECT`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` in Vercel env
   vars (never in code — see `.env.example`).
3. In Stripe, register **two** event destinations at the same URL
   (`https://yourdomain/api/stripe-webhook`): one scoped to "Your account"
   listening for `payment_intent.succeeded` + `payment_intent.payment_failed`,
   and one scoped to "Connected accounts" listening for `account.updated`.
4. Replace `STRIPE_PUBLISHABLE_KEY` in `mysubbies-booking.html` with the
   real publishable key (safe to be client-visible, unlike the secret key).
5. Set the same `CRON_SECRET` value in Vercel's Cron configuration for this
   project.

**Note on Stripe's newer dashboard UI**: the Connect-enabled account uses a
"Workbench" webhook creation flow with heavily obfuscated, non-standard
form components (no real `<input type=checkbox>`, custom `<a role="button">`
elements instead of `<button>`, layout that shifts under automation). If
scripting against this again, expect standard DOM queries to fail silently
— full pointer-event sequences dispatched on the exact text-matching leaf
element were what actually worked.

## Property Profiles — Phase 1 (added Aug 2026)
A permanent, address-keyed record of every completed job done at a property,
on top of the founder's own strategic framing: the real long-term moat here
isn't the booking app, it's the compounding household + property + contractor
+ transaction history nobody else has. Two new Supabase tables
(`supabase/schema_v5_property_profiles.sql`): `property_profiles` (one row
per address, keyed by a best-effort `normalized_address` — trim/lowercase/
collapse whitespace, **not** geocoding — `job.address` is free text with no
verification, so this is a string match, not a guaranteed same-property
match) and `property_history` (one row per *completed* job at that address,
`job_id unique` so re-syncing the same job never duplicates it).

**Fully automatic, no new UI trigger anywhere.** `api/sync-jobs.js` already
fires on every `saveJobs()` from all 4 portals (booking, customer,
contractor, admin) — the property tables are populated right there
(`syncPropertyProfile()`), so a plumber accepting a job, a customer paying a
stage, or an admin editing a job all silently keep the property record
current with zero client-side wiring. A job counts as complete when every
stage in its own `paymentSchedule` is ticked in `paidStages` — **not**
`job.status === 'completed'`, which is never actually reached anywhere in
this codebase (dead/aspirational state, UI has filters for it, nothing sets
it). If you touch job-completion logic again, use the `paidStages` check,
not the status field.

Customer-facing read-only view: "My Property" in `mysubbies-customer-portal.html`
(next to "Payment history", same `render()`-dispatcher pattern), backed by a
new dedicated endpoint `api/property-profile.js` (`GET ?customerEmail=`) —
address-keyed, not customer-keyed, so the data model already supports a
property's history outliving any one customer account, even though nothing
surfaces that yet.

**Deliberately Phase 1 only — explicit gaps, not oversights:**
- **No proactive reminder emails** ("your gutters were cleaned 11 months ago
  — book again"). Would need a real per-category maintenance interval that
  nobody has defined yet; inventing intervals would mean sending customers
  fabricated recommendations, which this project doesn't do (see the
  "no fabricated content" pattern throughout — fake ratings/prices already
  turned down once for the homepage hero image). Phase 2, once the founder
  specifies real intervals per category.
- **No warranties.** There is no warranty field anywhere in the data model
  (rate card tasks, job records, nothing) — nothing to build this on yet.
- **No admin/contractor-portal visibility** into property history yet —
  Phase 1 is customer-facing only. The schema already supports adding it
  later without rework.
- Photos are **not** duplicated into the new tables (they're base64 in
  `job.photoDataUrl(s)`/`milestone_evidence.photo_urls`, already prone to
  bloat) — `property_history` just references `job_id`, and the customer
  portal reuses the existing job detail view for photos.

## Company-only ABN verification (added Aug 2026, ABR lookup live from day one)
Contractor signup requires both an ABN and an ACN, and validates that the
ABN is genuinely derived from that ACN (`abn.slice(2) === acn`, after each
passes its own real checksum — ATO algorithm for ABN, ASIC algorithm for
ACN). This is real, correct, instant, client-side verification that a
company-structured ABN was supplied — sole traders have no ACN and can't
pass it.

On top of that, `verifyAbnWithAbr()` in mysubbies-contractor-signup.html
calls the real ABR (Australian Business Register) JSON API on ABN field
blur and shows the actual registered entity name, status, and entity type
— live-tested against the real registry (confirmed working: looked up a
real ABN and got back the correct entity name and a correct "not a
company" warning for a non-company entity type). The `ABR_GUID` constant is
hardcoded directly in that page's client-side JS **on purpose** — the ABR
API is JSONP-only, so the GUID has to be browser-visible for it to work at
all; this is a fundamentally different risk than the Stripe/Supabase
secrets elsewhere in this project, which are server-only and must never
appear in any file. Don't "fix" this by trying to move it server-side.

## Account deactivation & deletion (added Aug 2026)
Admin can now deactivate or permanently delete a customer or contractor
account from the admin portal — Applications tab for contractors (buttons
now appear on approved/suspended/rejected rows, not just pending ones), a
new Customers tab (searchable list, fetched live via
`/api/get-admin-list?type=customers`) for customers. Both route through one
new endpoint, `api/admin-account.js` (`POST {role, email, action}`,
`action` = `deactivate`/`reactivate`/`delete`).

**Deactivate is a pure status-column check, not a Supabase Auth ban.**
Contractors already had `contractors.status = 'suspended'` and
contractor-portal.html's `doLogin()` already refused portal access to
suspended accounts — deactivation reuses that untouched. Customers didn't
have any status column at all, so `supabase/schema_v4_account_status.sql`
adds `customers.status` (`'active'`/`'deactivated'`), checked explicitly in
both `mysubbies-booking.html`'s login branch and
`mysubbies-customer-portal.html`'s `doLogin()`, by email, **before** any
password verification happens. This matters because both contractor-portal
and customer-portal logins try real Supabase Auth first and silently fall
back to a local-cache plaintext-password check if that fails (see the
`localStorage['mysubbies_contractor_applications']` /
`['mysubbies_customers']` self-heal pattern) — an Auth-level ban alone
wouldn't close that fallback path, but an app-level status check that runs
regardless of which path verified the password does.

**Delete is permanent and deliberately restrictive.** None of the FKs in
this schema pointing at `customers`/`contractors` are `ON DELETE CASCADE`
(Postgres default `NO ACTION`), so a hard delete would simply fail — with a
confusing DB error, not a helpful one — the moment that account has any
job, address, rating, or offer on record. `api/admin-account.js` checks for
that first (`jobs` by id or email, plus `customer_addresses`/`ratings`) and
refuses with a clear "use Deactivate instead" message rather than let the
delete fail unexplained. When there's genuinely no history, it removes both
the table row and the Supabase Auth user (`supabase.auth.admin.deleteUser`
— the service-role key in `api/_lib/clients.js` can already do this, it
was just unused until now). In practice this means Delete only really works
for an account that signed up/applied and never went any further —
everything else needs Deactivate, which keeps their job/payment history
intact for the audit trail while blocking future logins.

## CRITICAL — read this before touching anything

**There is no backend.** This is 14 static HTML files (13 distinct pages plus
`index.html`, a duplicate of the homepage — see below), each fully self-contained
(inline CSS/JS, no build step, no framework, no bundler). All "shared" data —
jobs, messages, the rate card, customer/contractor accounts, disputes, ratings,
referrals — lives in the browser's `localStorage`, keyed by strings like
`mysubbies_jobs`, `mysubbies_ratecard`, `mysubbies_customers`,
`mysubbies_contractor_applications`, `mysubbies_disputes`,
`mysubbies_password_reset_requests`.

This means: everything works beautifully for one person testing solo in one
browser (including cross-tab sync via the native `storage` event — genuinely
real, not faked). It does **not** yet work for different real people on
different devices — a customer's phone and a contractor's laptop won't see
each other's data. Getting there needs a real database and backend, not just
hosting these files somewhere. Don't let a request to "make it live" imply
that gap is solved unless it's been explicitly addressed.

**Partial exception, added Aug 2026:** customer registration/login on
`mysubbies-booking.html` now goes through real Supabase Auth
(`signUp`/`signInWithPassword`, publishable key embedded client-side like
Stripe's) instead of a plaintext password field — verified live end-to-end.
On success the profile is also written to a real `customers` table
(RLS-protected: `auth.uid() = auth_user_id`, see
`supabase/schema_v2_marketplace.sql`). This is a genuine security upgrade
and the first real account-level backend piece, but it does **not** yet mean
cross-device jobs — `mysubbies-customer-portal.html`'s separate "My Jobs"
login still checks `mysubbies_customers` in localStorage directly (untouched
on purpose, kept working via a dual-write from booking.html), and job
records themselves still live in localStorage except for the thin
payment-mirror row in Supabase. Contractor accounts haven't been migrated
yet either. Don't assume "accounts are real now" implies "jobs sync across
devices now" — they're separate, sequential pieces of the same migration.

**Nothing here processes real payments.** Payment "stages" are boolean flags a
contractor manually ticks in their portal — no Stripe, no money movement, no
transaction ledger. Be upfront about this if asked to touch payment logic.

**The admin portal has a password gate, not real security.** It's a
client-side JS check (`Mysubbies2026!`, hardcoded, visible in page source) —
a deterrent for keeping the page out of casual view during testing, not
something to describe as secure. It is also no longer linked from the
contractor portal nav (was previously a public "Admin" link in the header —
removed). On the live Vercel deployment as of Aug 2026, `mysubbies-admin-portal.html`
404s while every other page resolves — the deploy appears incomplete/stale,
not a deliberate security measure. Worth checking before assuming it's live.

**`index.html` is a byte-for-byte duplicate of `mysubbies-website.html`.**
It exists purely so static hosts that require `index.html` at the root still
serve the homepage. There's no build step or rewrite config to keep them in
sync — if you edit one, copy it over the other (`cp mysubbies-website.html
index.html`) before finishing, or they silently drift apart. A `vercel.json`
rewrite (`/` → `/mysubbies-website.html`) would remove this duplication but
hasn't been added since it can't be verified without pushing to the live
deploy — flag it if asked to touch routing.

**Any place that renders another user's free text via `innerHTML` must
escape it.** Messages (customer↔contractor↔admin), dispute details, variation
descriptions/reasons, and contractor application fields (business name,
contact, phone, ABN, licence, insurer, profile photo) are all stored as raw
user input and interpolated into template-literal `innerHTML` blocks — this
was a real stored-XSS surface (confirmed and fixed Aug 2026) since the admin
portal renders all of it, meaning any customer or an unvetted contractor
applicant could execute script in the founder's admin session. Each portal
file (`customer-portal`, `contractor-portal`, `admin-portal`,
`contractor-signup`) now defines its own local `escapeHtml()` helper (no
shared JS file, per the self-contained-page convention) — wrap any
interpolated user-supplied string in it before adding new render code.

**Self-service password reset was removed in favor of a logged request.**
The old flow let anyone who knew a customer's or contractor's email set a new
password instantly with zero verification — a full account-takeover hole,
and it also leaked account existence via a distinct error message. There's no
email/SMS delivery in this static architecture, so a "send a real reset
link" fix isn't possible — instead, "Forgot password?" now logs a request to
`mysubbies_password_reset_requests` (role, email, timestamp) with an
identical response regardless of whether the account exists, and the founder
resolves it manually out-of-band. There's no admin UI to action these yet —
just the raw log — that's a known gap, not an oversight.

## Files and what they do
- `mysubbies-website.html` — homepage + the instant-quote estimator (the core
  product). Category picker → task picker → quantity → price → cart. Supports
  cross-category bundling (splits into separate jobs per trade at booking).
- `mysubbies-booking.html` — registration/login + job creation. Splits a
  multi-trade cart into separate job records sharing a `bundleId`.
- `mysubbies-customer-portal.html` — "My Jobs": tracking, messaging, ratings
  (post-completion only, never fabricated), dispute reporting, referral code,
  variation approve/decline.
- `mysubbies-contractor-portal.html` — job feed, My Jobs, dual messaging
  (customer-facing + private admin thread), payment stage actions, earnings,
  variation requests, referral code.
- `mysubbies-contractor-signup.html` — application with trade/suburb
  selection, insurance/licence document upload, profile photo, referral code
  field. Goes to `pending` status until admin approves.
- `mysubbies-admin-portal.html` — password-gated. Tabs: All Jobs, Applications
  (approve/reject with document review), Disputes, Rate Card (upload CSV,
  bulk % update with CPI reference, Manage Existing with inline edit +
  disable/enable, Research New with a guided-search-not-automatic workflow).
- `mysubbies-faq.html`, `mysubbies-terms.html`, `mysubbies-privacy-policy.html`,
  `mysubbies-contractor-agreement.html` — legal/trust pages. All four are
  explicitly marked as drafts pending real solicitor review — don't remove
  that banner without asking. `mysubbies-terms.html` is customer-facing only;
  `mysubbies-contractor-agreement.html` (added Aug 2026) is what
  contractor-signup actually links to — they'd previously been pointed at the
  customer terms by mistake.
- `mysubbies-blog.html` + 2 cost-guide posts (Decking, Fencing) — only 2 of 21
  categories have guides; more were planned but not built.

## Key architectural decisions worth knowing
- **Contractors never see the customer's phone number** (added Aug 2026). All
  contractor↔customer communication is meant to happen in the in-app message
  thread only. `job.customerPhone` is intentionally omitted from every
  contractor-portal render (job cards and job detail) — only admin-portal
  shows it, for customer-service purposes. If you add a new contractor-facing
  job view, don't wire `customerPhone` into it. Customer *name* is still
  shown to contractors (only the phone number is restricted).
- **Job `urgency` field** (added Aug 2026): free-text "How urgent is this
  job?" captured in the estimator (`selectedUrgency` in website.html), carried
  through `quote.urgency` → `job.urgency` in booking.html, same pattern as
  `site`/`access`. Displayed to contractor and admin, not customer (customer
  already knows what they typed).
- **Rate card tasks already carry a customer-facing `notes` field** (material
  details/specs, e.g. "AS/NZS 3000... WaterMark-certified...") — this isn't
  new, it's been in `DEFAULT_CATEGORIES` since the start and was already
  displayed to customers in the estimator/cart. What was missing until Aug
  2026 was an admin UI to edit it — `rateCardManageHtml()` in
  admin-portal.html now has a textarea per task wired to the existing generic
  `editService(cat, idx, 'notes', value)`, no schema change needed.
- **Large-job inspection policy** (added Aug 2026): for jobs $20,000+
  (reusing the threshold already established in the Terms' deposit-cap
  clause, for consistency — not a new number), a Mysubbies inspector reviews
  completed work before the job is marked complete. This is currently policy
  copy only (Terms §5, FAQ) — there's no backend to actually enforce a
  completion gate, since there's no backend at all. Don't let anyone assume
  this is enforced in-app.
- **Homepage leads with categories, not the estimator** (reordered Aug 2026):
  category grid now sits directly under the hero, before the "for
  customers/for contractors" split panels. There was previously a duplicate
  category grid further down the page (after the split panels) — that's
  gone, there's exactly one now. If you touch homepage layout, keep
  categories as the first visual thing after the hero headline.
- **Admin Reports tab** (added Aug 2026): `renderReportsTab()` in
  admin-portal.html — finance/marketing/director-CEO views built entirely
  from existing localStorage data (jobs, customers, applications, disputes,
  newsletter signups). No new data source, just aggregation. Recomputes
  live every time the tab opens, nothing cached.
- **Research New now does bulk multi-row entry with an auto-averaged rate**
  (changed Aug 2026, reversing the earlier deliberate "guided, not
  automatic" decision on request): admin enters a low–high price range per
  sub-category found during research; the system averages it and adds every
  filled row to the rate card in one click. There is still no live pricing
  API — "automatic" here means the math, not the research itself; the admin
  still has to actually go look up prices via the Research button (opens
  Google) and type in what they find.
- **Rate card**: 21 categories, ~163 individually priced tasks, sourced from
  the founder's real Melbourne rate card (not invented). Lives in
  `DEFAULT_CATEGORIES` in website.html, seeded into `localStorage` on first
  load, then merged (never overwritten) on every subsequent load via
  `mergeRateCardUpdates()` — this additive-merge exists specifically because
  a plain "seed if empty" approach silently stopped propagating code updates
  to anyone who'd already opened the site once. If you change
  `DEFAULT_CATEGORIES`, the merge will add new fields/categories/tasks to
  already-stored data without touching anything an admin has edited
  (rate, disabled status). If you need to *remove* a field that's already
  shipped, add explicit cleanup logic to that same function (see the
  reference-photo removal for the pattern).
- **Pricing shows ONE number, not a range.** This was deliberately changed
  from an earlier ±3-5% widened range — don't reintroduce range display
  without being asked.
- **Payment schedules are category-specific**, defined per category in the
  rate card as a `paymentSchedule` array of `{key, label, pct}`. Skip Bins:
  10/90. Electrical/Plumbing: 10/30/60. Everything else defaults to 5/35/50/10
  (in `DEFAULT_PAYMENT_SCHEDULE` in booking.html). Jobs store their own copy
  of the schedule at creation time (`job.paymentSchedule`) plus a
  `paidStages` object tracking what's been confirmed — this locks in the
  schedule even if the category's default changes later. Older test jobs
  without this field fall back gracefully to the default 4-stage schedule —
  preserve that fallback if you touch this code.
- **"Estimated," never "Fixed."** Copy was deliberately changed site-wide from
  "fixed price" to "estimated price" — keep this consistent in any new copy.
- **Logo**: current mark is a plain "M" monogram (simple geometric stroke),
  white square on the black header. Two other directions (an "MS" monogram,
  and a geometric hammer icon) were tried and explicitly rejected — don't
  reintroduce either without being asked. If asked to touch the logo, check
  what's actually live in the page first rather than assuming.
- **No AI-generated visuals.** A request for AI-rendered "your deck in your
  yard" images was deliberately turned down in favor of real reference
  photos — which were then themselves removed after testing (see the
  `mergeRateCardUpdates` cleanup step). Don't add AI image generation to the
  estimator without discussing the reasoning already established.

## Testing conventions used throughout this project
Every change has been verified with real interaction testing (Playwright),
not just read-through:
1. After any HTML/JS edit, a quick brace/paren balance check
   (`content.count('{') - content.count('}')` etc.) to catch unbalanced edits
   before testing.
2. Real browser automation for functional changes — actually click through
   the flow, don't assume. Several real bugs in this project were only found
   this way (e.g. a duplicated icon, a stale-cache bug, a CSS selector that
   silently missed `type=email`/`type=password` inputs).
3. Cross-page/cross-role flows tested end-to-end in one continuous script
   (customer → contractor → admin) since isolated per-page tests miss
   integration bugs — this caught a real bug where the contractor job feed
   showed the category instead of the specific task name.
4. Multi-file link integrity check (grep every `href="mysubbies-*.html"` and
   confirm the target file exists) before any deployment handoff.

## Known gaps / explicitly deferred, not forgotten
- Document upload for permits/plans in the customer quote flow — not built.
- Compliance flags: jobs over $10K need an updated builder's licence flag,
  over $20K need indemnity insurance flag — not built.
- 19 of 21 categories still have no blog cost-guide post.
- Contractor referral code mechanism exists and works (generated at signup,
  tracked when redeemed) but a plain-language "how do I use this" walkthrough
  for the founder was requested and not yet delivered.
- No dispute/refund UI existed until recently added — customer-facing report
  flow + admin review queue now exist; no automated resolution or refund
  logic beyond marking resolved.

## PWA setup (added Aug 2026)
The site installs as a PWA (add-to-home-screen, standalone window, offline
app-shell). Three shared files, unavoidably not self-contained per-page since
a manifest/service worker are inherently global — this is the one deliberate
exception to the "no shared external files" rule:
- `manifest.json` — name, icons, `start_url: "/"`, `display: standalone`,
  black theme/background color matching the header.
- `sw.js` — **network-first, cache-fallback**. Deliberately not
  cache-first/stale-while-revalidate: this project has already shipped one
  real stale-cache bug (see Testing conventions), and a cache-first service
  worker would silently serve old HTML after every future edit. Precaches
  all 14 pages + manifest + icons on install; purges old cache versions by
  bumping `CACHE_VERSION` in `sw.js` (currently `mysubbies-v1`) — bump this
  string whenever precached content should be forcibly refreshed for
  returning visitors.
- `icons/` — `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
  `apple-touch-icon.png` (180×180), `favicon-32.png`. Generated (not
  designed) from the existing header "M" mark's exact SVG path via a
  PowerShell/System.Drawing script, at each required size — this was a
  faithful export, not a new logo direction. Regenerate the same way if the
  mark ever changes; don't hand-design new icons independently or they'll
  drift from the header logo.

Every page's `<head>` links the manifest + icons + `theme-color` +
`apple-mobile-web-app-*` meta tags, and every page registers `sw.js` in an
inline `<script>` before `</body>` (same duplication pattern as everything
else in this codebase — no shared JS file). If you add a 15th page, copy
both blocks from an existing page and add the new page's path to
`PRECACHE_URLS` in `sw.js`.

## When making changes
- Keep every page fully self-contained — no shared external JS/CSS files,
  matching every existing page.
- If touching the rate card or anything category-related, remember the
  additive-merge migration system — new code changes need to actually reach
  browsers with already-seeded data.
- Test real flows before calling something done, the way this whole project
  has been built.
