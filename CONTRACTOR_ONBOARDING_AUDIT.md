# Contractor onboarding audit — 10 September 2026

## Current flow

1. `/mysubbies-contractor-signup.html` renders the Founding 100 application. It collects contact/business details, ABN (and ACN for companies), trade categories, broad Melbourne regions plus free-text suburbs/postcodes, availability, licence/insurance declarations, referral data, and explicit Contractor Portal Terms acceptance.
2. The browser posts one application to `POST /api/sync-applications`. The server validates required fields, Australian mobile/ABN shape, categories, availability, compliance declarations, and the current agreement version; creates a `contractors` row in `manual_review`; creates admin notifications; and renders/sends the application-received email through Resend.
3. An optional second step accepts insurance, trade certificate/licence, and photo-ID images/PDFs. A random application-update token returned only to that browser authorises `uploadDocuments`; only its SHA-256 hash is stored.
4. Admin loads applications through `/api/get-admin-list?type=applications`. The Applications tab reads `contractors.full_application`, and approve/reject controls call admin-authenticated `/api/update-contractor-status`.
5. Approval/rejection updates `contractors.status`, creates an admin audit notification, and sends the relevant contractor email. Approval tells the contractor to open `/mysubbies-contractor-portal.html`, select **Activate your account**, and create a Supabase Auth password.
6. `GET/POST /api/activate-contractor` checks approval and links the verified Supabase Auth user to the pre-existing contractor row. Portal job/profile APIs bind bearer tokens to `contractors.auth_user_id`.
7. Approved/preferred contractors with current compliance can read matched jobs. New-job notification creates a `job_offers` row; accepting requires that contractor's pending offer. Customer, contractor, and admin data branches use separate authentication checks.

## Data and status model

Primary tables are `contractors`, Supabase `auth.users`, `jobs`, `job_offers`, and `notifications`. Application details/documents remain in `contractors.full_application`; structured identity/category/compliance/consent columns are also used. Relevant statuses are `manual_review`, `approved`, `preferred`, `watchlist`, `suspended`, `expired_documents`, and `rejected`. Only `approved` and `preferred` are portal/job eligible.

Terms evidence is stored as `agreement_accepted`, `agreement_accepted_at`, and `agreement_version`; the full application retains matching evidence. Licence and insurance have status/expiry columns. A daily CRON sends 30-day/expired reminders, creates admin notifications, and changes otherwise-active expired accounts to `expired_documents`.

Email is delivered by Resend using `RESEND_API_KEY` and optional `RESEND_FROM_EMAIL`. Persistent in-app/admin notifications use the `notifications` table and `/api/notifications`.

## Test matrix and findings

- **A — successful registration:** validation, consent evidence, persistence path, notification path, and safe email rendering are automated. No staging credentials were used, so a real Supabase insert and Resend delivery remain unverified.
- **B — missing required field:** server and browser reject incomplete applications with clear errors.
- **C — duplicate contractor:** email or ABN duplicates return HTTP 409 and no anonymous upsert can overwrite an account.
- **D — approval:** admin-authenticated status update, approval template, and approved-only account activation are implemented. Live staging delivery/login still require verification.
- **E — rejection/more information:** rejection and more-information templates exist; the existing Admin UI exposes Approve/Reject but does not yet collect a structured reason or expose a dedicated “more information” action.
- **F — security:** customer/contractor job reads are role-bound; pending/rejected/suspended/expired contractors are denied job APIs; profile and notification reads are bearer-token-bound; status changes require admin auth; job acceptance requires a pending `job_offers` record and uses an atomic unassigned-row condition.
- **G — expired compliance:** API eligibility fails closed and the daily reminder marks expired accounts. Signup currently does not collect expiry dates, and Admin has no dedicated compliance-date editor, so dates require a manual database/admin process.
- **H — email failure:** result-aware onboarding/status/compliance sends create an admin failure notification and never roll back the accepted application/status decision.

## Outstanding risks and manual steps

1. Apply `supabase/schema_v21_contractor_onboarding.sql` in a non-production environment before testing this branch. Do not deploy code first because the new consent/token columns are required.
2. Configure Preview/Staging `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, a verified `RESEND_FROM_EMAIL`, `ADMIN_SESSION_SECRET`, `ADMIN_PASSWORD`, and `CRON_SECRET`; enforce a synthetic-recipient Resend domain/allowlist.
3. Perform the complete browser matrix on desktop and mobile. This container has no browser executable, so upload UX, responsive layout, keyboard/screen-reader basics, Supabase email confirmation, and actual portal activation were code-reviewed but not visually exercised.
4. Admin must inspect uploaded documents, verify ABN/licensing/insurance, enter compliance statuses/expiry dates outside the current UI, choose categories/areas, then approve or reject.
5. Build an Admin “request more information” form with a mandatory reason and secure contractor re-upload route. The email backend supports it, but the UI workflow is incomplete.
6. Replace base64 compliance documents in `full_application` with private object storage, malware/type validation, size limits at upload, retention rules, and signed admin-only downloads before scale.
7. Add rate limiting/bot protection to public signup, activation eligibility, and notification entry points. Activation lookup currently permits account/status enumeration by email.
8. Create integration tests against an isolated Supabase project. Unit tests cannot prove migrations, RLS, Resend domain configuration, cron invocation, or database race behaviour.

## Launch decisions

- **Free community promotion: NO-GO.** Complete the staging migration and one synthetic end-to-end browser/email run first.
- **Paid Meta ads: NO-GO.** In addition to staging verification, finish structured more-information/compliance administration, private document storage, abuse controls, and mobile/accessibility testing.
- **Production deployment of these fixes: NO-GO.** This branch is committed for review only; migration-first staging validation is mandatory. Nothing was deployed or merged.

> **11 September remediation update:** Launch-blocking follow-up work is documented in `CONTRACTOR_ONBOARDING_LAUNCH_READINESS.md`. Where this original point-in-time audit conflicts with that document, the remediation document describes the current branch.
