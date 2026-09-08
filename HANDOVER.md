# MySubbies — Engineering Handover

**Repository:** https://github.com/Mysubbies/Mysubbies-site
**Branch:** `main`
**Live URL:** https://app.mysubbies.com.au (Vercel; the apex `mysubbies.com.au` redirects here as of a recent DNS migration — see "Domain / DNS" below)

This document was authored on top of commit `f447a82` on `main`. Run `git log -1` for the actual current latest commit — this file itself lands in a commit after that one, so its own header can't reference its own hash.

This document is a snapshot for whoever picks this codebase up next. It is not a replacement for `CLAUDE.md` at the repo root, which is the running, chronological engineering log this project has been built from — read that too, especially before touching payments, the rate card, or anything marked "deliberate" below. This file exists to organize that history into something a new engineer can act on quickly.

---

## 1. What this is

A Melbourne home-services marketplace. A customer picks a category, gets an instant computed price from a real rate card, approves it, and the job is dispatched to one matched contractor (not open bidding). Platform commission is 18%. Built solo, by the founder working through Claude conversations — there is no separate dev team and no automated test suite; every change has historically been verified by live browser interaction, not by CI.

---

## 2. Setup

### Prerequisites
- Node.js (for installing `/api`'s dependencies — see below).
- A Vercel account with this repo connected (push to `main` auto-deploys — there is no separate deploy step).
- A Supabase project (Postgres) — this is the system of record for payments, quotes, contractor applications, and increasingly everything else. See "Architecture" for what still lives only in `localStorage`.
- Accounts/keys for: Stripe, Resend (email), Anthropic (optional — AI features), Twilio (not currently used, despite appearing in some planning notes).

### Local structure
- 17 static HTML pages at the repo root (`mysubbies-*.html` + `index.html`). Each is **fully self-contained** — its own inline `<style>` and `<script>`, no shared JS/CSS file, no build step, no framework. This is a deliberate, repeatedly-reaffirmed convention: if you fix something in one portal, the identical bug likely exists in the sibling portal file and needs the same fix pasted in separately.
- `index.html` is a **byte-for-byte duplicate** of `mysubbies-website.html` (some static hosting requires `index.html` at the root). There is no build step keeping them in sync — after editing `mysubbies-website.html`, always run:
  ```bash
  cp mysubbies-website.html index.html
  diff mysubbies-website.html index.html && echo SYNCED
  ```
- `/api` — 28 Vercel serverless functions (Node, CommonJS, no framework). `/api/_lib` holds shared, non-routable helper modules (`clients.js`, `email.js`, `adminAuth.js`, `adminNotify.js`, `paymentSchedule.js`, `quoteMath.js`).
- `package.json` exists **only** for `/api`'s three dependencies (`stripe`, `@supabase/supabase-js`, `@anthropic-ai/sdk`) — it does not build or bundle the HTML pages.
- `vercel.json` — one Cron job (`weekly-payout`, Mondays 01:00 UTC) and four path rewrites (root → `mysubbies-website.html`, `/contractor`, `/login`, `/foundingcontractorssignup`).

### Environment variables
See `.env.example` at the repo root for the full annotated list (names only, no real values are ever committed). Required for a working deployment:
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_CONNECT`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `CRON_SECRET` (must match the value configured in Vercel's Cron settings for this project)
- `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` (admin portal login — rotate `ADMIN_PASSWORD` if you ever suspect it's been shared insecurely; the old hardcoded value from before Sept 2026 is in git history and must never be reused)
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (see "Email" below — `RESEND_FROM_EMAIL` now defaults to `notifications@mysubbies.com.au`, a real verified sending domain, if left unset)
- `ANTHROPIC_API_KEY` (optional — AI photo-triage and AI quote-text drafting both degrade gracefully to a manual-review/no-op state if unset, never block a booking)
- `ADMIN_NOTIFY_EMAIL` (optional, defaults to `accounts@mysubbies.com.au` in code)

### Running/deploying
There is no local dev server convention documented in this repo — the HTML pages are opened directly or served by Vercel; the `/api` functions only really run under Vercel (dev or prod). **Every push to `main` deploys to production immediately.** There is no staging environment.

---

## 3. Architecture

### The core fact to understand before changing anything
**Most of this app's state still lives in the browser's `localStorage`, not in Supabase.** Jobs, the rate card display, messages, and several other things are read/written to `localStorage` keys (`mysubbies_jobs`, `mysubbies_ratecard`, `mysubbies_customers`, `mysubbies_contractor_applications`, etc.) and then separately, best-effort, synced to Supabase via fire-and-forget calls to `api/sync-jobs.js` / `api/sync-applications.js`. This means:
- Two browsers/devices for the *same* person will not automatically see each other's local state unless a real sync path has been built for that specific piece of data (jobs, applications, and several account fields now do sync cross-device; some things, historically, did not — always check before assuming).
- Money-relevant state (payments, payout eligibility, milestone status, quotes) has been progressively moved to Supabase as the real source of truth, precisely because localStorage was never safe for that. `jobs.full_record` (jsonb) is a *mirror* of the localStorage job object for cross-device display — the real payment logic reads structured Postgres columns, not `full_record`.

### Money handling
- **Deposit-only Stripe integration.** Only the deposit stage (and, for single-category bookings, the later materials/frame/completion stages too) is real Stripe money. Multi-category bundle bookings still use an older, non-Stripe path — flagged, not forgotten.
- Contractors are paid their 82% share of the **deposit only**, automatically, weekly (`api/weekly-payout.js`, Stripe Connect Standard transfer), gated on: webhook-confirmed payment, not disputed, ≥3 days since payment, contractor's Connect onboarding complete, and a DB-unique-index guard against double payout.
- Everything past the deposit (materials/frame/completion) is paid to contractors **manually**, by the founder, by design — this has not been automated.
- The rate card (21+ categories, ~160+ tasks) now lives server-side in Supabase (`platform_rate_card` table, `api/rate-card.js`), not just localStorage — but `api/create-deposit-intent.js` still trusts the client-submitted price **on first sight of a given job ID only**, then locks it in. It does not independently recompute a job's price server-side from the rate card. This is a known, deliberately-scoped gap (closing it fully means moving all pricing *logic*, not just the *data*, server-side).

### The quoting CRM (added this session — Stage 1 only)
A real, from-scratch object model was added for admin-issued quotes, since none existed before (the estimator's "quote" was previously just a transient shopping-cart object with no ID, no persistence, no acceptance step). See `supabase/schema_v19_quotes_crm.sql` and `schema_v20_quote_payment_terms.sql`, `api/quotes.js`, and the new customer-facing `mysubbies-quote.html`.
- Admin creates a draft quote (customer + line items pulled from the real rate card or typed as custom items), previews a branded PDF, and either **issues a link only** or **issues and emails it directly** to the customer in one action.
- Each issue/revise creates an immutable, versioned snapshot (`quote_versions`) — a later rate-card or customer edit never silently rewrites what was actually shown/accepted. Acceptance is a separate, explicit customer action (name/email/consent, IP + user-agent recorded) — a bare page load, email preview, or crawler can never accept a quote.
- Customer access is via a single-use-style, hash-stored, expiring, revocable token (`document_access_tokens`) — the raw token is never stored, only its SHA-256 hash, and every token lookup is rate-limited by IP (`document_access_attempts`).
- An "✨ Draft with AI" button expands short admin notes into full scope/inclusions/exclusions text via Anthropic — always lands back in an editable field for human review before saving, never auto-saves or auto-issues.
- **Deliberately NOT built yet** (Stage 2+): a branded email preview-before-send screen, the "More plans for your home?" service-recommendation widget on the quote page, a customer-portal-invitation panel, real structured invoicing (draft/issued/paid/overdue/credit-notes as their own object, distinct from a quote), payment allocation records, admin reporting/dashboards for the quote pipeline, and full per-staff RBAC (see below).

### Admin authentication
One shared password (`ADMIN_PASSWORD`) gates `mysubbies-admin-portal.html`'s login screen; a signed, 12-hour-expiring HMAC token (`api/_lib/adminAuth.js`, Node's built-in `crypto`, no external JWT library) is then required by every admin-only API action. **There is no per-staff login or role system** — every admin action is attributed to the literal string `'admin'` in audit logs. A `staff_members` table exists (added alongside the quoting CRM) purely so a quote can say a real assigned-staff *name* — it has no password or session of its own, it is attribution only, not authentication.

### PWA
The site installs as a PWA (`manifest.json`, `sw.js`). The service worker is **network-first with cache fallback**, deliberately not cache-first — this project has shipped a real stale-cache bug before. `sw.js`'s `CACHE_VERSION` must be bumped whenever precached content should be force-refreshed for returning visitors, and any new top-level page must be added to `PRECACHE_URLS`.

---

## 4. Integrations

| Service | What it's used for | Notes |
|---|---|---|
| **Stripe** (Connect, Standard) | Deposit + later-stage payments, contractor payout | Two *separate* Stripe accounts exist in practice — see CLAUDE.md's "Real-world discovery" note on why Connect needed a fresh, non-Xero-linked account. Two separate webhook *destinations* are required (Stripe won't mix "Your account" and "Connected accounts" event scopes in one destination) — `api/stripe-webhook.js` tries both signing secrets automatically. |
| **Supabase** (Postgres) | System of record for payments, applications, quotes, and progressively more | Service-role key only, server-side, in `/api`. RLS is enabled with **no policies** on every table — by design, only the service-role key (never shipped to the browser) can read/write. |
| **Resend** | Transactional email | Domain `mysubbies.com.au` was just verified in Resend this session (DKIM/SPF/DMARC records added via Cloudflare). `RESEND_FROM_EMAIL` now defaults to a real address on that domain instead of Resend's shared sandbox sender, which only ever delivered to the account's own email — this was very likely the root cause of a real "quote emails aren't reaching customers" bug fixed this session. |
| **Anthropic (Claude)** | "Fix Something" photo/description triage (`api/classify-job.js`); AI-assisted quote text drafting (`api/quotes.js`) | Both fail safe to a manual/no-op state if `ANTHROPIC_API_KEY` is unset — never blocks a booking or a quote save. |
| **ABR (Australian Business Register)** | Live ABN lookup at contractor signup | Calls the real government JSONP API client-side; the `ABR_GUID` constant is *intentionally* visible in client JS (the API is JSONP-only, this is not a secret leak — do not "fix" this by moving it server-side). |
| **Google Workspace** | Real business email for `@mysubbies.com.au` | MX record, untouched by the recent DNS migration — see below. |
| **Cloudflare** | DNS host for `mysubbies.com.au` (moved off Wix this session) | See "Domain / DNS" below. |
| **Vercel Cron** | Weekly contractor payout batch | Requires `CRON_SECRET` to match between Vercel's Cron config and the env var, or the endpoint rejects the request. |

---

## 5. Domain / DNS (migrated this session — verify current status)

`mysubbies.com.au` was moved off Wix-managed DNS to **Cloudflare** during this engineering session, because Wix's DNS panel does not support the record types Resend needed for domain verification. Current intended end state:

- **Nameservers**: Cloudflare (`faye.ns.cloudflare.com`, `malcolm.ns.cloudflare.com`), switched at the registrar (Crazy Domains).
- **Root (`mysubbies.com.au`) and `www`**: 301 redirect to `https://app.mysubbies.com.au` (Cloudflare Redirect Rule, path + query string preserved). The root/`www` A/CNAME records point to a non-routable placeholder (`192.0.2.1`) — traffic is intercepted and redirected at Cloudflare's edge before ever reaching it, this is expected and correct, not a misconfiguration.
- **`app.mysubbies.com.au`**: unchanged, CNAME to Vercel, set to Cloudflare's "DNS only" (grey cloud) mode — proxying this through Cloudflare on top of Vercel's own edge is not recommended and was deliberately avoided.
- **Email (MX)**: unchanged, still Google Workspace (`aspmx.l.google.com`) — this must never be pointed anywhere else without confirming Workspace itself isn't affected.
- **Resend records** (DKIM TXT, 2 CNAMEs, DMARC TXT) were added to Cloudflare and the domain shows **Verified** in Resend as of this session.

**Action for the incoming team:** confirm global DNS propagation has fully settled (nameserver changes can take up to ~24h in the worst case; it was progressing well within the hour during this session) and that `mysubbies.com.au` in a fresh/incognito browser reliably redirects to `app.mysubbies.com.au`. Also confirm real email to `@mysubbies.com.au` addresses is still arriving.

---

## 6. Migrations

Run `supabase/schema.sql` first (base schema), then every `schema_v*.sql` file **in numeric order** in the Supabase SQL editor. All are additive (`create table if not exists`, `add column if not exists`) and safe to re-run.

Current highest version: **v20** (`schema_v20_quote_payment_terms.sql`).

**⚠️ One file needs attention before you do this: `supabase/schema_v11_notifications_and_disputes.sql` exists on disk but was deliberately *not* committed to this repo** (it remains as an untracked local file in whatever working copy produced this handover — check whether it's present in yours). It defines an *earlier, superseded* version of the `notifications` and `disputes` tables. **`schema_v13_notifications.sql`** and **`schema_v14_disputes_inquiries.sql`** are the real, live, committed versions of those two tables and are what the actual application code (`api/notifications.js`, `api/support.js`) reads and writes. If you ever encounter a `schema_v11_notifications_and_disputes.sql` file, **do not run it** — because both tables use `create table if not exists`, running v11 *before* v13/v14 would silently lock in v11's older, incompatible column shape and v13/v14 would then silently no-op instead of applying their intended shape. Recommend deleting that stray file rather than committing it.

---

## 7. Testing

**There is no automated test suite** (no unit tests, no CI test job, no `npm test`). The established verification convention for every change, throughout this project's history, is:
1. A quick brace/paren balance check on any edited `.html`/`.js` file (catches unbalanced edits before they ship).
2. Real browser interaction against the **live production deployment** (there being no staging environment) — actually click through the flow, don't assume. Several real bugs in this project were only ever caught this way.
3. Cross-role, cross-device flows tested end-to-end in one continuous pass (e.g. admin creates a quote → customer receives the email → customer accepts → admin sees it reflected) rather than testing each portal in isolation, since integration bugs have repeatedly hidden between isolated per-page tests.
4. A link-integrity grep (`href="mysubbies-*.html"`) across all pages before considering a multi-file change done.
5. Synthetic test data is always cleaned up afterward — real customer/contractor records must never be created or altered for testing.

If you add real automated tests, that would be a genuine, valuable improvement — just be aware you're establishing a new practice, not maintaining an existing one.

---

## 8. Known bugs / risk areas

- **Rate card data corruption, partially worked around**: a "Same-Day Metro Delivery Boxes" Courier Services task's `unit` field was found corrupted (literal string `"5"` instead of `"Box"`) mid-session — this broke a category-grouping heuristic and was root-caused and fixed in code (grouping no longer depends on that field for Courier Services). The underlying **data** is still wrong in the admin Rate Card tab and will show a garbled `"$50/5"` label on the customer-facing gallery tile until an admin manually corrects that one field. Low priority (cosmetic), but worth doing.
- **Courier Services pricing is now fully hardcoded** (flat $50/$250/$275/$400 table by metro/regional × small/bulk), not sourced from the rate card at all — this was a deliberate founder decision after the rate-card-driven version proved unreliable in practice. Don't "fix" this back to reading `.rate` fields without checking with the founder first.
- **`api/create-deposit-intent.js` trusts the client price on first sight** of a job ID (see "Money handling" above) — a genuine, known, scoped gap, not an oversight.
- **No per-staff admin login/RBAC** — a single shared password authenticates as a generic `'admin'` actor. Anyone who needs individual accountability for admin actions (beyond the new but purely-cosmetic `assigned_staff_id` on quotes) needs this built.
- **Multi-category bundle bookings** still use the pre-Stripe, non-real-payment path — only single-category bookings go through real Stripe payment intents.
- **The quoting CRM's "Issue & email" flow sends immediately** with no admin preview screen first (the original spec called for one; not built this pass).
- `mysubbies-contractor-agreement.html` is still an earlier Claude-authored draft, **not** the founder's own supplied contractor T&C document — the founder's real supplied doc itself still contains unresolved `[INSERT ...]` placeholders and an explicit "must be reviewed by an Australian solicitor" disclaimer, so it was deliberately never published as-is. Do not replace this file's content without either resolving those placeholders or getting explicit sign-off to publish with them blank.
- **19+ of the ~31 rate-card categories still have no blog cost-guide post** (only Decking and Fencing exist) — content gap, not a bug.
- **No warranty data model, no proactive maintenance-reminder emails** — both were explicitly deferred because the underlying data (real per-category maintenance intervals, any warranty concept at all) doesn't exist yet anywhere in the schema. Do not invent intervals or warranty claims to fill this gap; get real numbers from the founder first.

---

## 9. Unfinished / explicitly deferred work

This is not a bug list — these are scoped-out, intentional gaps, documented so nobody assumes they were forgotten:

- **Quoting CRM Stages 2+**: branded email send-preview, "More plans for your home?" recommendation widget, customer-portal-invitation panel on the quote page, real structured invoicing as its own object (drafts/issued/paid/overdue/credit-notes), payment allocation records, admin reporting/dashboards for the quote pipeline (conversion rate, pipeline value, follow-ups due).
- **Document permits/plans upload** in the customer quote flow.
- **Compliance flags** for large jobs (an updated builder's-licence flag over $10K, an indemnity-insurance flag over $20K) — policy exists in the Terms/FAQ copy, not enforced anywhere in-app.
- **Full RBAC** for the admin portal (see "Known bugs" above).
- **Server-side rate card pricing enforcement** at the point of charging (see "Money handling" above).
- **Property "Health"/maintenance reminders** beyond the customer manually setting their own mowing-frequency reminder — no other category has a real interval defined.

---

## 10. A few conventions worth internalizing before your first PR

- Never reintroduce a price *range* (e.g. "$X–$Y") — pricing was deliberately changed to show one number.
- Copy says "estimated," never "fixed," price — this was a deliberate, site-wide copy change.
- No AI-generated marketing imagery — real photos only (a prior request for AI-rendered "your deck in your yard" images was explicitly turned down).
- Escape all user-generated free text (messages, dispute details, application fields) before interpolating into `innerHTML` — this was a real stored-XSS vulnerability, found and fixed; every portal has its own local `escapeHtml()` helper (no shared file, per convention).
- If you touch anything about the rate card, remember `mergeRateCardUpdates()`'s additive-merge migration pattern in `mysubbies-website.html` — a plain "seed if empty" approach has, historically, silently stopped shipping rate-card updates to already-seeded browsers.
