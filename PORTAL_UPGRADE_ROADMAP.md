# Portal upgrade roadmap

This branch deliberately delivers the first usable CRM/Quotes phase only. The
existing static HTML/CSS/JavaScript architecture remains in place.

## Next recommended phase: accepted quote handoff

1. Add an explicit, admin-confirmed **Convert to job** action for accepted
   quotes. It should create the structured job server-side, retain the accepted
   immutable quote version, and never infer payment terms from browser state.
2. Add a real invoice object and lifecycle before enabling the Invoices
   navigation destination. Quotes and invoices must remain separate records.
3. Surface quote questions in a dedicated CRM action queue with reply and
   resolved states.

## CEO / admin portal

Consolidate the current CEO Overview and operational tabs into the approved
Overview, Operations, Jobs, Projects, Contractors, Customers, Finance, Support,
Reports and Settings information architecture. Reuse existing job, application,
payment and support APIs. Add category and larger-project pipeline metrics only
from server-authoritative data.

## Customer portal

Organise the existing functionality under My Home, My Bookings, Home
Maintenance, Payments and Help. Add the “What needs sorting?” CTA, visual
categories and a larger-project enquiry without changing booking pricing or
payment policy.

## Contractor portal

Organise the existing functionality under Overview, Job Offers, My Jobs,
Earnings and Messages. Then add server-backed preferences for service areas,
availability and larger-project capability; do not store matching authority in
browser-only state.

## Notifications and matching audit

Trace Booking → eligible nearby contractors → safe offer → atomic acceptance →
assignment notifications → scheduling → completion. Preserve the safe
unassigned-offer projection and move any remaining matching decisions to
authenticated server endpoints before expanding notifications.
