# MySubbies engineering guide

This is the master engineering instruction file for this repository. It is
grounded in the checked-in source as inspected on 8 September 2026. Treat the
code, committed migrations, and deployment configuration as the source of
truth; do not infer that a planned feature exists in production.

## Purpose and product journey

MySubbies is a Melbourne home-services marketplace. Its intended customer
journey is:

1. Choose a service or describe a problem.
2. Supply job details and, where requested, photos.
3. Receive the applicable pricing or booking path.
4. Book and pay the applicable deposit/stage.
5. Have a matched contractor allocated or accept an offer.
6. Schedule and perform the work.
7. Submit completion evidence, then allow customer confirmation, support, or
   review where the implemented flow supports it.

The marketplace is not an open bidding product: a job is intended to be
dispatched to one matched, vetted contractor.

## Current stack and repository layout

- Root HTML pages are self-contained static pages with inline CSS and
  JavaScript. There is no frontend framework, bundler, TypeScript, or shared
  application component library.
- `index.html` is the byte-for-byte mirror of `mysubbies-website.html`. Keep
  them identical whenever either is changed.
- `api/` contains CommonJS Node.js Vercel serverless functions. `api/_lib/`
  contains non-routable helpers for clients, admin authentication, email,
  quote totals, and payment schedules.
- `supabase/` contains additive SQL migrations. It is the repository's
  migration mechanism; there is no Supabase CLI configuration or ORM.
- `tests/` contains Node's built-in test-runner tests for the current security
  patch. `scripts/check_syntax.js` parses API, service-worker, and inline
  JavaScript; `scripts/check_syntax.py` is an older equivalent.
- `sw.js`, `manifest.json`, and `manifest-contractor.json` provide PWA support.
  The service worker is network-first with cache fallback. Do not cache API or
  authenticated responses; bump the cache version when a precached asset must
  refresh for existing installations.
- Static images live in `images/`; icons live in `icons/`. Do not edit
  `node_modules/` or other generated/vendor files.
- `vercel.json` supplies four rewrites and a Monday 01:00 UTC
  `/api/weekly-payout` cron. Vercel deploys this repository; a push to `main`
  deploys production.

Current server dependencies are `stripe`, `@supabase/supabase-js`, and
`@anthropic-ai/sdk`. Browser pages load Supabase and, on some pages, Stripe or
other libraries from CDNs. Do not add dependencies unless necessary and
justified.

## Three product environments

### Customer experience

- Public entry and service discovery: `mysubbies-website.html` and its mirror
  `index.html`; `/` rewrites to the former. They load the rate card, accept
  problem/photo input, can call `api/classify-job.js` and
  `api/geocode-distance.js`, and hand booking context to the next page.
- Booking: `mysubbies-booking.html`. It creates booking/job context, obtains
  payment-schedule information, and uses `api/create-deposit-intent.js` for
  Stripe payment intents.
- Customer workspace: `mysubbies-customer-portal.html`; `/login` rewrites to
  it. It includes jobs, payment schedules/stages, House Health/property
  information, support/disputes, notifications, and customer preferences.
- Quote document: `mysubbies-quote.html`, served through the public
  token-based quote API flow. It can view, accept, decline, or ask a question
  about an issued quote.
- Supporting public pages include the blog, FAQ, terms, privacy, and service
  landing pages. Keep customer-facing flows simple: clear service selection,
  details/photos, price/booking, payment, and job tracking. Do not expose
  internal pricing, CRM, payout, security, or operational complexity.

### Contractor portal

- Signup/application: `mysubbies-contractor-signup.html` and
  `mysubbies-founding-contractors.html` (also the
  `/foundingcontractorssignup` rewrite). The application is synced through
  `api/sync-applications.js`; the page includes client-side ABR lookup.
- Portal: `mysubbies-contractor-portal.html`; `/contractor` rewrites to it.
  Existing functions include account activation/profile changes, service
  categories/service areas stored in contractor data, matched job feed and
  assigned-job views, accept/reject and status UI, admin messages,
  notifications, support inquiries, milestone evidence/claims, payment
  schedule views, earnings displays, and Stripe Connect onboarding.
- Server endpoints involved include `activate-contractor.js`,
  `contractor-profile.js`, `get-jobs.js`, `create-connect-onboarding-link.js`,
  `job-payment-schedule.js`, `milestone.js`, `notifications.js`, `support.js`,
  `admin-messages.js`, and `notify.js`.

Do not claim or build unverified functionality as though it exists. In
particular, the repository records onboarding guidance and reminder ideas, but
does not yet implement a complete contractor welcome/onboarding journey,
deduplicated reminder system, or a fully server-authoritative job acceptance
workflow.

### Admin and CRM

- `mysubbies-admin-portal.html` is the admin UI. `api/admin-account.js` issues
  a signed, 12-hour admin session after a shared-password login; protected API
  routes use `api/_lib/adminAuth.js`.
- Existing operational screens and endpoints cover customer/contractor lists,
  contractor applications and status updates, job lists, rate-card management,
  admin-contractor messages, support/disputes/inquiries, notifications,
  payment-schedule templates/rules/config, milestone claims, contractor payout
  reporting, refunds, and quotes.
- Quotes are implemented in `api/quotes.js`, `api/_lib/quoteMath.js`,
  `api/_lib/quoteEmail.js`, `mysubbies-admin-portal.html`, and
  `mysubbies-quote.html`. The current implementation supports draft/revise,
  server-calculated totals, versioned issued snapshots, tokenized customer
  access, accept/decline/questions, direct email, and an admin-only read-only
  email preview.

The admin/CRM is not yet a complete accounting or operations system. There is
no central invoice ledger, payment allocations, credit-note workflow, complete
customer timeline, reliable delivery outbox, staff RBAC, or CEO reporting
workspace. `staff_members` provides assignment attribution only; it is not an
identity or permission system.

## Business and financial rules

- The current commercial model is an 18% platform commission and 82%
  contractor share. Do not silently change the percentage, price, deposit,
  payout, or margin.
- Money is stored in integer cents on server-side payment/schedule records.
  Use server-side, authoritative calculations wherever the implementation
  supports them: `api/_lib/paymentSchedule.js` for payment schedules and
  `api/_lib/quoteMath.js` for quote line totals/GST.
- Existing code still repeats 18%/82% presentation calculations in portal
  pages and some endpoints. This is a known architectural gap. Do not add more
  copies. For any financial change, first identify and consolidate the
  authoritative calculation with explicit approval and tests.
- The Stripe implementation is high-risk. It handles deposit payment intents,
  stage payment intents, refunds, webhook processing, Stripe Connect Standard
  onboarding, and a scheduled weekly payout batch. The batch transfers 82% of
  eligible, webhook-confirmed deposit funds only; later-stage payouts remain
  manual by design. Multi-category bookings have an older non-Stripe path.
- `api/create-deposit-intent.js` currently locks a browser-supplied initial
  job price rather than recalculating it fully from the server rate card. This
  is a known security gap, not a permission to change live pricing policy.
- Never change payment amounts, deposit logic, refunds, payout eligibility,
  Stripe Connect behaviour, commission, or rate-card prices without explicit
  approval and workflow-level tests.

## Security and privacy rules — critical

- Never expose service-role keys, Stripe secret/webhook keys, Resend keys,
  Anthropic keys, admin secrets, cron secrets, tokens, or privileged credentials
  to browser code or committed files. `.env.example` documents names only.
- `api/_lib/clients.js` is server-only and uses the Supabase service-role key.
  Preserve that boundary. The browser's Supabase publishable key is distinct
  and only supports the deliberately scoped authenticated profile policies.
- Preserve authentication and authorization boundaries. Admin actions must
  remain server-side and require `requireAdmin`; customer/contractor private
  reads and writes must verify the Supabase session and account ownership.
- Never weaken Supabase RLS or add broad policies merely to make a feature
  work. Validate/sanitize all untrusted request data and constrain outbound
  redirects. Treat photos, data URLs, storage objects, and uploads as
  untrusted; avoid arbitrary file execution, public sensitive URLs, or
  uncontrolled size/type acceptance.
- Do not log passwords, authentication tokens, payment data, or secrets.
- Do not alter production data, authentication, authorization, RLS/security
  policies, payment logic, secrets, or environment variables without explicit
  approval.
- Public/unassigned contractor feeds must not disclose exact addresses,
  contact details, private messages, or other unnecessary customer data.

## Supabase database and migration rules

Run `supabase/schema.sql` first, then committed `schema_v*.sql` migrations in
numeric order. They are designed to be additive and re-runnable; nevertheless,
inspect each migration and production state before use. Never run a database
migration against production without explicit approval. Never make destructive
production changes automatically.

The committed schema currently covers:

- Core payments/payouts: `jobs`, `payments`, `contractor_connect_accounts`,
  `payout_batches`, and `payout_line_items`.
- Marketplace/accounts: cities, suburbs, services, platform settings,
  customers, customer addresses, contractors, job offers, variations, job
  events, ratings, and job extensions including the JSONB `full_record` mirror.
- Payment scheduling: templates, category rules/config, job schedules,
  milestones, evidence, customer responses, milestone disputes, inspections,
  schedule versions, and payment audit logs.
- Property, messaging, notifications, support, referrals/credits, contractor
  details, rate card, quotes, issuing entities, staff attribution, quote events,
  and document-access/token attempt tables.

RLS is enabled throughout the schema. Most tables have no browser policy and
are intended to be accessed only through server-side service-role functions.
The explicit exception is authenticated users' own `customers` or
`contractors` profile rows, matched by `auth_user_id`. Preserve the
append-only/revocation safeguards on audit/event tables.

`supabase/schema_v11_notifications_and_disputes.sql` is present locally but is
untracked and superseded. Do not run, commit, or use it as the migration path;
the committed `schema_v13_notifications.sql` and
`schema_v14_disputes_inquiries.sql` are the current compatible definitions.

## Development, testing, and deployment

- Inspect the existing implementation before creating code. Reuse the current
  API helpers and page patterns where appropriate; avoid duplicate code and
  do not replace working architecture unnecessarily.
- Keep changes narrow and reviewable. Fix root causes rather than masking
  symptoms. Do not modify generated or vendor files, including `node_modules`.
- For meaningful changes, run the relevant checks: `npm test`,
  `npm run check:syntax`, and `git diff --check` when applicable. There is no
  configured lint, type-check, production build, or CI pipeline.
- For customer, contractor, authentication, booking, pricing, payment, refund,
  quote, webhook, or PWA changes, test the complete affected cross-role flow
  with synthetic/non-production data. Include negative authorization cases and
  provider test mode where applicable. A passing static check is not proof of
  a working workflow.
- Before any deployment, report files changed, tests run, warnings/failures,
  database changes, and security implications. Do not push, merge, deploy,
  rewrite history, or force-push unless explicitly instructed. Do not use
  `main` as a casual test branch because it auto-deploys production.

## Approval gates

Explicit approval is required before:

- a production deployment or push/merge to `main`;
- any production database migration or destructive operation;
- authentication, authorization, RLS, or security-policy changes;
- payment, refund, deposit, commission, contractor-payout, or pricing changes;
- secret or environment-variable changes; and
- major dependency upgrades.

## Known gaps and risks (do not silently fix)

1. `sync-jobs` accepts broad browser-supplied job records; job ownership,
   assignment, state transitions, and concurrency need operation-specific,
   server-authoritative handling.
2. Deposit and some stage/payment paths do not fully enforce identity,
   ownership, server-calculated amounts, idempotency, and transactional state.
3. Job feeds still return full records where field-level projections are needed
   to protect unassigned-offer/customer data.
4. Browser `localStorage` remains a source of job, cache, message, and legacy
   account state; it is not safely scoped or authoritative across devices.
5. Shared admin authentication lacks individual staff accounts, RBAC, and
   attributable permissions.
6. Webhook duplicate handling is not a durable unique event inbox and can be
   vulnerable to replay/out-of-order processing issues.
7. Quote status transitions, resend/delivery reliability, and immutable issuing
   entity snapshots need transactional/outbox hardening.
8. CRM lacks central invoices, allocations, credit notes, reliable delivery
   history, complete customer timeline, operational work queue, and reporting.
9. Contractor onboarding, setup reminders, protected first-job offers, and
   post-completion communication are documented requirements but not complete
   confirmed-backend workflows.
10. Testing is limited to mocked Node tests and syntax checks; no CI, staging
    environment, deployed RLS verification, browser/PWA regression suite, or
    full provider integration suite is present.
