# Quote launch readiness

No migration or production change is performed by this document.

## Required database state

For the complete quote-to-job flow, production must contain:

1. `supabase/schema.sql` — base `jobs` and payment tables.
2. `supabase/schema_v2_marketplace.sql` — customers, job/customer linkage,
   structured job fields and inquiries dependencies.
3. `supabase/schema_v3_payment_schedules.sql` — payment schedule configuration
   used to place a converted quoted project into manual schedule review without
   inventing payment terms.
4. `supabase/schema_v10_job_numbers.sql` — server-issued job numbers.
5. `supabase/schema_v14_disputes_inquiries.sql` — the live inquiries table.
6. `supabase/schema_v19_quotes_crm.sql` — issuing entities, staff, quotes,
   immutable quote versions, quote events, secure document tokens, access
   attempt rate limiting, and `inquiries.quote_id`.
7. `supabase/schema_v20_quote_payment_terms.sql` — customer-visible payment
   terms text on quote versions.

The repository convention remains to apply the base schema and every committed
`schema_v*.sql` migration in numeric order. The list above calls out the direct
dependencies of this workflow; it is not permission to skip intervening
production migrations without auditing the target database first.

All quote-related tables must retain RLS. No browser receives the service-role
key and no client-side RLS policy is required for this server-mediated flow.

## Required application configuration

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for server-only persistence.
- `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` for authenticated CRM actions.
- `RESEND_API_KEY` with the sender domain verified in Resend.
- `RESEND_FROM_EMAIL` should be a verified sender such as
  `MySubbies <notifications@mysubbies.com.au>`; code uses that value as its
  default, but provider verification is still required.
- `QUOTE_BASE_URL` is optional. Production defaults to
  `https://app.mysubbies.com.au/mysubbies-quote.html`. A staging environment
  should set its own URL to prevent staging emails linking to production.
- At least one active row must exist in `issuing_entities`. The v19 migration
  seeds Mysubbies Holdings Pty Ltd; issuance fails closed if no entity is active.

## Pre-deployment verification

Use a non-production or explicitly approved test environment to verify one
continuous flow: admin login → select/create customer → draft → preview → issue
and email → open the secure link → ask a question → accept/decline on separate
quotes → refresh CRM status/action queue → convert accepted quote → confirm the
linked job and quote event. Confirm the email arrives outside the Resend account
owner address and that expired/revoked links fail closed.
