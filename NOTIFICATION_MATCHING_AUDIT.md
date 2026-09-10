# Notification and matching audit

This audit documents the portal experience upgrade only. It does not authorise
deployment, schema changes, production data changes, or commercial-rule changes.

## Current end-to-end path

| Stage | Implemented now | Known gap / later backend work |
| --- | --- | --- |
| Customer booking | The booking page creates the authoritative job through the existing payment/booking path, caches it locally, and syncs it to Supabase. The authenticated sync starts the durable lifecycle worker; the cron recovers due work. | Apply schema v21 before enabling the lifecycle endpoint, then verify with a preview environment. |
| Suitable contractor selection | `api/notify.js` selects approved contractors whose stored trades include the category and whose stored regions/suburbs match the job suburb. `api/get-jobs.js` independently filters the authenticated contractor feed by account categories. | Matching logic is duplicated between email dispatch and portal display. There is no ranked distance, capacity, availability, licence-expiry, notification preference, delivery receipt, retry, or durable match record. Consolidate matching in one server service before adding sophistication. |
| Offer notification | Matching contractors receive Resend email and a persisted in-app notification from canonical server-loaded job data. Old browser-initiated dispatch calls are rejected. | Provider delivery/bounce telemetry is not yet persisted; application-level offer retries are durable. |
| Offer privacy | The authenticated feed uses a strict safe projection: job ID/number, category/icon, suburb, urgency, price, minimal item quantity/unit, status and creation time. This phase also removes customer photos, access instructions and site notes from pre-assignment email offers. | The email endpoint should ultimately derive the same projection from the stored job rather than maintain a second allow-list. |
| Contractor acceptance | `api/sync-jobs.js` requires a Supabase-authenticated contractor, checks current assignment, and conditionally assigns only an unassigned job. The deterministic database condition prevents a normal retry from taking an already-assigned job. | Acceptance and customer notification are not one atomic server transaction. The current browser attempts the customer notification after sync, but the safe offer does not contain customer contact details—which is correct—so a server-side assignment event/outbox is required for reliable notification. |
| Customer/admin assignment notice | `api/notify.js` can email and persist a customer `job-assigned` notification; admin sees unassigned jobs and operational action queues. | The assignment notification currently depends on a browser holding customer contact data. It must instead be emitted server-side after successful assignment using the stored job/customer relationship. Add an admin assignment event and failure/retry state. |
| Scheduling/status | Both portals show stored job state, messages, variations, milestone prompts and cancellation/dispute states. Job messages create email and in-app notifications. | There is no authoritative appointment/scheduling model, reminder service, reschedule workflow, SLA/escalation timer, or cross-device read state for job-thread messages. UI therefore says “in progress” rather than inventing dates. |
| Completion/payment | Existing milestone APIs, Stripe webhook processing, payment schedule, evidence and payout reporting remain intact. Admin surfaces disputed milestones and jobs awaiting schedules. | Completion-to-customer notification, evidence review reminders, payout failure escalation and durable workflow telemetry need a later backend phase. No changes should be made without a separate commercial/security review. |

## Safe offer contract

Before assignment, contractor UI/API and offer email may show only the minimum
information needed to decide whether to open the offer: job identifier/number,
category, optional category icon, suburb, urgency, customer price or derived
contractor payout, minimal task name/quantity/unit, offer status and creation
time. They must not show customer name/email/phone, exact address, access/site
notes, customer messages, photos, payment evidence, internal notes, or tokens.

## Recommended next backend phase

1. Introduce a server-only `job_created`/`job_assigned` outbox with idempotency,
   attempts, delivery status and retry timestamps.
2. Dispatch by authoritative `job_id`; never accept customer identity, address,
   price or scope from the notification request.
3. Centralise category/area/availability eligibility and store offer recipients
   so admin can see who was offered a job and whether delivery succeeded.
4. Emit customer and admin assignment notifications from the same successful
   server-side acceptance workflow, while keeping the offer projection private.
5. Add an explicit scheduling model only after its states, ownership and
   notification rules are approved.
