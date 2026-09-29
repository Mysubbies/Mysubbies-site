# MySubbies AI Booking + Property Management Roadmap

## Current state

### Reused
- Supabase Auth for customer and contractor identities.
- MFA-backed, HttpOnly admin session.
- Live platform rate card and admin rate-card editor.
- Existing estimator split between predictable instant-price work and project quotes.
- Existing Fix Something AI classification flow, with pricing handed back to the real rate card.
- Existing jobs, job offers, contractor matching/acceptance, notifications and contractor portal.
- Existing pre-assignment privacy allow-list: unassigned contractors see only category, suburb, urgency, price and task quantity.
- Existing contractor before/after photo workflow.
- Existing high-value residential safeguard for jobs above $9,900.

### Missing before this branch
- Organisation accounts and role-based commercial contacts.
- Multiple properties under one account.
- Work-order approvals, urgency and requested completion dates.
- Commercial recurring-maintenance settings.
- Commercial portal/admin workspace.
- Private work-order attachments and invoice documents.
- AI-safe service/pricing API representation.

## Phase 1 MVP in this PR

1. Admin onboards an organisation and initial contact.
2. Invitee activates a Supabase account using the invited email.
3. Organisation admins manage multiple properties.
4. Clients create either instant-price or project-quote work orders.
5. Request files are private.
6. Required client approval blocks release.
7. Work above $9,900 is additionally blocked for contract/legal review.
8. Admin releases only priced, approved and legally-cleared work.
9. Release creates a normal MySubbies job and contractor offers.
10. The existing contractor portal handles assignment and before/after photos.
11. The property client sees status, completion evidence, invoice PDFs and job history.

## AI-ready endpoints implemented

### GET /api/booking-api?action=catalog
Public customer-safe live catalogue. Missing/unavailable rates become project_quote and are never coerced to zero.

### GET /api/booking-api?action=service-areas
Public current Melbourne/Victoria pilot metadata. Contractor base addresses are not exposed.

### POST /api/booking-api
Body: action=estimate plus category, taskName and qty. Validates against the live rate card server-side.

### GET /api/booking-api?action=job-status&jobId=...
Requires an authenticated customer bearer token and restricts lookup to that customer's job.

### /api/property-management
Organisation-scoped bootstrap, invitation activation, properties, work orders, approvals, admin quote/release/invoice actions and assigned-contractor completion evidence.

## Required before an AI agent can complete a paid residential booking

1. Address/serviceability endpoint using structured address data.
2. Availability endpoint backed by a real scheduling source of truth.
3. Authoritative create-booking endpoint that recalculates price server-side and uses idempotency.
4. Payment-session endpoint based on that server-owned booking draft.
5. Authenticated project-quote creation endpoint with private uploads.
6. Short-lived delegated agent authorisation; never give an agent customer passwords, admin credentials or long-lived service-role tokens.
7. Audit events for every agent-initiated mutation.

### Current blocker to AI-created paid bookings
The existing residential payment flow still accepts a client-supplied base price. Until that path is fully server-authoritative, this PR deliberately stops the AI surface at catalogue, validated estimate and authenticated status instead of exposing paid booking creation.

## Phases after this MVP

### Phase 2 — Operations
- Automatic future work orders from recurring plans.
- SLA definitions, due/overdue timers and escalation.
- Site/tenant notification preferences.
- Dedicated commercial notifications.
- Invoice generation/payment reconciliation integration.
- Commercial reporting/export.

### Phase 3 — AI execution
- Address/serviceability.
- Real availability.
- Server-owned booking draft and pricing.
- Agent-safe payment session.
- Project quote API.
- Short-lived delegated consent/auth.
- Idempotency and full audit logs.

### Phase 4 — Portfolio/enterprise
- Multi-organisation user memberships.
- Cost centres and purchase orders.
- Approval limits.
- Asset register.
- Preventive-maintenance schedules.
- SLA dashboards.
- Vendor performance and spend reporting.
- Property-management/FM integrations.

## Security/privacy design
- New commercial tables have RLS enabled and direct anon/authenticated privileges revoked.
- Data access is server-mediated with explicit identity checks.
- Admin reuses MFA-backed HttpOnly sessions.
- Work-order storage is private; client file links are short-lived signed URLs.
- JPEG/PNG/PDF uploads are content checked and payload-limited.
- Unassigned contractors retain the existing safe feed shape with no exact address, customer/contact, access notes or private photos.
- Property clients receive contractor status, not private contractor account details.
- AI catalogue/status endpoints expose no admin credentials, service-role keys or contractor private information.

## Australian/Victorian release considerations
This is engineering guidance, not legal advice.

- Consumer Affairs Victoria says most domestic building work over $10,000 requires a major domestic building contract and a registered building practitioner. The existing >$9,900 review gate is intentionally conservative.
- Victorian domestic-building deposit limits vary by contract value; payment rules should follow the legal classification of the job, not a generic commercial template.
- Domestic building insurance requirements can apply before taking money above the statutory threshold.
- Property/facilities work can be residential, common-property or commercial; legal rules are not identical, so high-value/licensing/permit-sensitive work should remain reviewable before release.
- If MySubbies is covered by the Privacy Act, APP 11 requires reasonable technical and organisational steps to secure personal information. APP-style controls remain sensible even where a small-business exemption might apply because the system holds addresses, access notes, contacts and photos.
- If the Privacy Act/NDB scheme applies, eligible data breaches can require notification.
- Independent-contractor status depends on the real relationship, not the label in the contract. Dispatch/control features should be reviewed as the model evolves.
- Digital-platform worker rules may also become relevant to some contractor arrangements.

Official references:
- OAIC APP guidelines: https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-guidelines
- OAIC small-business privacy: https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business
- OAIC data-breach guidance: https://www.oaic.gov.au/privacy/notifiable-data-breaches/when-to-report-a-data-breach
- Consumer Affairs Victoria building contracts: https://www.consumer.vic.gov.au/licensing-and-registration/builders-and-tradespeople/running-your-business/domestic-building-contracts/laws-about-home-building-contracts
- Consumer Affairs Victoria deposits/payments: https://www.consumer.vic.gov.au/licensing-and-registration/builders-and-tradespeople/running-your-business/deposits-and-payments
- Fair Work Ombudsman contractors: https://www.fairwork.gov.au/find-help-for/independent-contractors

## Production test checklist

### Database/config
- Run supabase/schema_v31_property_management.sql.
- Confirm existing Supabase, admin/MFA, email and Stripe environment variables.
- No new secret is required by this PR.

### Property client
- Admin creates organisation and invited admin.
- Invitee activates with exact email.
- Add two properties.
- Submit a priced work order.
- Submit a project quote with a photo.
- Approve/reject.
- Verify >$9,900 cannot be released until legal review is cleared.
- Verify invoice PDF opens using a signed link.

### Admin
- View organisation/contact/property/work-order lists.
- Set project quote and contractor category.
- Verify quote change resets client approval when required.
- Clear high-value legal review.
- Release approved work and confirm job number/offer count.
- Upload invoice PDF.

### Contractor
- Confirm pre-acceptance view contains no exact address/contact/access notes.
- Accept released property job.
- Confirm full site details appear only after assignment.
- Add before/after photos and complete.

### Regression
- Residential booking still creates jobs.
- Existing >$9,900 residential no-deposit flow still holds for contract review.
- Customer portal still shows residential jobs.
- Contractor feed/acceptance still works.
- Admin login still requires MFA.
